/**
 * WeChat file-based persistence
 *
 * Stores account credentials and poll offsets as JSON files
 * in ./data/wechat/. Uses atomic writes (write to .tmp then rename).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WeixinAccount } from './wechat-types.js';

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function ensureDir(filepath: string): void {
  mkdirSync(dirname(filepath), { recursive: true });
}

// ──────────────────────────────────────────────
// Account persistence
// ──────────────────────────────────────────────

/**
 * Load a WeixinAccount from a JSON file.
 * Returns null if the file does not exist or is invalid.
 */
export function loadAccount(filepath: string): WeixinAccount | null {
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as WeixinAccount;
  } catch {
    return null;
  }
}

/**
 * Save a WeixinAccount to a JSON file atomically.
 * Writes to a .tmp file first, then renames to the target path.
 * Ensures the parent directory exists.
 */
export function saveAccount(filepath: string, data: WeixinAccount): void {
  ensureDir(filepath);
  const tmp = filepath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filepath);
}

// ──────────────────────────────────────────────
// Poll offset persistence
// ──────────────────────────────────────────────

/**
 * Load a poll offset string from a JSON file.
 * Returns null if the file does not exist or has no offset field.
 */
export function loadPollOffset(filepath: string): string | null {
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw) as { offset?: string };
    return data.offset ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a poll offset string to a JSON file atomically.
 * Ensures the parent directory exists.
 */
export function savePollOffset(filepath: string, offset: string): void {
  ensureDir(filepath);
  const tmp = filepath + '.tmp';
  writeFileSync(tmp, JSON.stringify({ offset }, null, 2), 'utf-8');
  renameSync(tmp, filepath);
}
