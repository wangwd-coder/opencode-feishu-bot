/**
 * WeChat HTTP protocol client
 *
 * Pure protocol layer using undici fetch.
 * Base URL is configurable, defaults to https://ilinkai.weixin.qq.com.
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import type {
  GetUpdatesResponse,
  GetConfigResponse,
  QrCodeStartResponse,
  QrCodeStatusResponse,
} from './wechat-types.js';
import {
  DEFAULT_BASE_URL,
  MessageType,
  MessageState,
  MessageItemType,
} from './wechat-types.js';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const CHANNEL_VERSION = 'feishu-opencode-bridge/1.0';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_STATUS_POLL_TIMEOUT_MS = 8_000;

// ──────────────────────────────────────────────
// Header builders
// ──────────────────────────────────────────────

/**
 * Generate X-WECHAT-UIN header: random uint32 encoded as base64
 */
function generateWechatUin(): string {
  const buf = crypto.randomBytes(4);
  return buf.toString('base64');
}

/**
 * Build authentication headers for a request
 */
function buildHeaders(token: string, routeTag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': generateWechatUin(),
  };
  if (routeTag) {
    headers['SKRouteTag'] = routeTag;
  }
  return headers;
}

// ──────────────────────────────────────────────
// WeChatApiClient class
// ──────────────────────────────────────────────

export class WeChatApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    console.log(`[WeChat] API client initialized: ${this.baseUrl}`);
  }

  private async request<T>(
    token: string,
    endpoint: string,
    body: unknown,
    timeoutMs: number = API_TIMEOUT_MS,
    routeTag?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}/ilink/bot/${endpoint}`;

    console.log(`[WeChat] POST ${endpoint}`);

    const res = await undiciFetch(url, {
      method: 'POST',
      headers: buildHeaders(token, routeTag),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`[WeChat] API error: ${res.status} ${res.statusText}`);
    }

    const rawText = await res.text();
    if (!rawText.trim()) {
      return {} as T;
    }

    try {
      return JSON.parse(rawText) as T;
    } catch (err) {
      throw new Error(
        `[WeChat] Non-JSON response from ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Long-poll for message updates (default 35s timeout)
   */
  async getUpdates(token: string, offset?: string, timeout?: number): Promise<GetUpdatesResponse> {
    const timeoutMs = timeout ?? LONG_POLL_TIMEOUT_MS;
    try {
      return await this.request<GetUpdatesResponse>(
        token,
        'getupdates',
        {
          get_updates_buf: offset ?? '',
          base_info: { channel_version: CHANNEL_VERSION },
        },
        timeoutMs + 5_000, // client timeout slightly longer than server
      );
    } catch (err) {
      // Long-poll timeout is normal, return empty response
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { msgs: [], get_updates_buf: offset };
      }
      throw err;
    }
  }

  /**
   * Send a text message to a peer user
   */
  async sendTextMessage(
    token: string,
    peerUserId: string,
    text: string,
  ): Promise<{ clientId: string }> {
    const clientId = `bridge-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await this.request<Record<string, unknown>>(token, 'sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: peerUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
    return { clientId };
  }

  /**
   * Get bot configuration (typing_ticket, route_tag, etc.)
   */
  async getConfig(token: string): Promise<GetConfigResponse> {
    return this.request<GetConfigResponse>(
      token,
      'getconfig',
      {
        base_info: { channel_version: CHANNEL_VERSION },
      },
      CONFIG_TIMEOUT_MS,
    );
  }
}

// ──────────────────────────────────────────────
// Standalone QR login API functions
// ──────────────────────────────────────────────

/**
 * Start a QR code login session
 */
export async function startLoginQr(): Promise<QrCodeStartResponse> {
  const url = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await undiciFetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[WeChat] QR login start failed: ${res.status}`);
  }
  return (await res.json()) as QrCodeStartResponse;
}

/**
 * Poll QR code login status.
 * Note: WeChat server may not respond quickly, uses short timeout to avoid blocking.
 */
export async function pollLoginQrStatus(qrcode: string): Promise<QrCodeStatusResponse> {
  const url = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await undiciFetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(QR_STATUS_POLL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[WeChat] QR status poll failed: ${res.status}`);
  }
  return (await res.json()) as QrCodeStatusResponse;
}
