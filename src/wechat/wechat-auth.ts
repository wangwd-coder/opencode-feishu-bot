/**
 * WeChat QR code authentication flow
 *
 * Manages QR code generation, status polling, and credential persistence.
 * Active login sessions stored in globalThis to support HMR.
 * Saves credentials to ./data/wechat/ via file-based store.
 */

import QRCode from 'qrcode';
import { startLoginQr, pollLoginQrStatus } from './wechat-api.js';
import { saveAccount } from './wechat-store.js';
import type { QrCodeStatusResponse, WeixinAccount } from './wechat-types.js';
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from './wechat-types.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface QrLoginSession {
  qrcode: string;
  qrImageUrl: string;
  startedAt: number;
  refreshCount: number;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed';
  accountId?: string;
  error?: string;
  pollPromise?: Promise<void>;
  confirmed?: boolean;
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MAX_REFRESHES = 3;
const QR_TTL_MS = 5 * 60_000;
const GLOBAL_KEY = '__weixin_login_sessions__';
const TOKENS_DIR = './data/wechat';

// ──────────────────────────────────────────────
// Session storage (in-memory via globalThis)
// ──────────────────────────────────────────────

function getLoginSessions(): Map<string, QrLoginSession> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, QrLoginSession>();
  }
  return g[GLOBAL_KEY] as Map<string, QrLoginSession>;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Start a new QR login session.
 * Displays QR code as terminal ASCII art.
 * Returns session ID for polling with pollQrLoginStatus().
 */
export async function startQrLoginSession(): Promise<{ sessionId: string; qrTerminal: string }> {
  console.log('[WeChat] Starting QR login session...');

  const resp = await startLoginQr();

  if (!resp.qrcode || !resp.qrcode_img_content) {
    throw new Error('[WeChat] Failed to get QR code from server');
  }

  // Generate terminal ASCII art QR code
  const qrTerminal = await QRCode.toString(resp.qrcode_img_content, {
    type: 'terminal',
    small: true,
  });

  console.log('[WeChat] Scan this QR code with WeChat:');
  console.log(qrTerminal);

  const sessionId = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: QrLoginSession = {
    qrcode: resp.qrcode,
    qrImageUrl: resp.qrcode_img_content,
    startedAt: Date.now(),
    refreshCount: 0,
    status: 'waiting',
  };

  getLoginSessions().set(sessionId, session);

  // Auto-cleanup after 10 minutes
  setTimeout(() => {
    getLoginSessions().delete(sessionId);
  }, 10 * 60_000);

  return { sessionId, qrTerminal };
}

/**
 * Poll QR login status for a session.
 * Handles QR refresh on expiry and credential persistence on confirmation.
 */
export async function pollQrLoginStatus(sessionId: string): Promise<QrLoginSession> {
  const sessions = getLoginSessions();
  const session = sessions.get(sessionId);

  if (!session) {
    return {
      qrcode: '',
      qrImageUrl: '',
      startedAt: 0,
      refreshCount: 0,
      status: 'failed',
      error: 'Session not found',
    };
  }

  // Already confirmed or failed, return immediately
  if (session.status === 'confirmed' || session.status === 'failed' || session.confirmed) {
    return session;
  }

  // Check QR expiry (5 minutes)
  if (Date.now() - session.startedAt > QR_TTL_MS) {
    if (session.refreshCount >= MAX_REFRESHES) {
      session.status = 'failed';
      session.error = 'QR code expired after maximum refreshes';
      return session;
    }

    // Refresh QR code
    try {
      console.log('[WeChat] QR code expired, refreshing...');
      const resp = await startLoginQr();
      if (resp.qrcode && resp.qrcode_img_content) {
        session.qrcode = resp.qrcode;
        session.qrImageUrl = resp.qrcode_img_content;
        session.startedAt = Date.now();
        session.refreshCount++;
        session.status = 'waiting';

        const qrTerminal = await QRCode.toString(resp.qrcode_img_content, {
          type: 'terminal',
          small: true,
        });
        console.log('[WeChat] New QR code:');
        console.log(qrTerminal);
      }
    } catch (err) {
      session.status = 'failed';
      session.error = `QR refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return session;
  }

  // If a poll is already in progress, wait for it
  if (session.pollPromise) {
    await session.pollPromise;
    return session;
  }

  // Start new poll
  session.pollPromise = doPoll(sessionId, session);
  await session.pollPromise;
  session.pollPromise = undefined;

  return session;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

async function doPoll(_sessionId: string, session: QrLoginSession): Promise<void> {
  try {
    const resp: QrCodeStatusResponse = await pollLoginQrStatus(session.qrcode);

    switch (resp.status) {
      case 'wait':
        session.status = 'waiting';
        break;

      case 'scaned':
        session.status = 'scanned';
        console.log('[WeChat] QR code scanned, waiting for confirmation...');
        break;

      case 'confirmed': {
        // Prevent duplicate processing
        if (session.confirmed) return;
        session.confirmed = true;
        session.status = 'confirmed';

        if (resp.bot_token && resp.ilink_bot_id) {
          // Normalize account ID (replace unsafe characters)
          const accountId = (resp.ilink_bot_id || '').replace(/[@.]/g, '-');
          session.accountId = accountId;

          const botToken = resp.bot_token;

          // Persist to file asynchronously
          setImmediate(() => {
            try {
              const account: WeixinAccount = {
                accountId,
                userId: resp.ilink_user_id || '',
                baseUrl: resp.baseurl || DEFAULT_BASE_URL,
                cdnBaseUrl: DEFAULT_CDN_BASE_URL,
                token: botToken,
                name: accountId,
                enabled: true,
              };
              const accountPath = `${TOKENS_DIR}/tokens.json`;
              saveAccount(accountPath, account);
              console.log(`[WeChat] Login successful, account saved to ${accountPath}`);
            } catch (err) {
              console.error('[WeChat] Failed to save account:', err);
            }
          });
        }
        break;
      }

      case 'expired':
        session.status = 'expired';
        // Force refresh on next poll
        session.startedAt = 0;
        break;
    }
  } catch (err) {
    // Poll timeout is normal, don't change status
    if (err instanceof Error && err.name === 'TimeoutError') {
      return;
    }
    console.error('[WeChat] Poll error:', err);
  }
}

/**
 * Cancel and clean up a login session
 */
export function cancelQrLoginSession(sessionId: string): void {
  getLoginSessions().delete(sessionId);
}

/**
 * Get an existing login session
 */
export function getQrLoginSession(sessionId: string): QrLoginSession | undefined {
  return getLoginSessions().get(sessionId);
}
