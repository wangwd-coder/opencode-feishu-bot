/**
 * WeChat file-based persistence
 *
 * Stores account credentials and poll offsets as JSON files
 * in ./data/wechat/. Uses atomic writes (write to .tmp then rename).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WeixinAccount } from './wechat-types.js';

function ensureDirSync(filepath: string): void {
  mkdirSync(dirname(filepath), { recursive: true });
}

async function ensureDir(filepath: string): Promise<void> {
  await mkdir(dirname(filepath), { recursive: true });
}

export function loadAccount(filepath: string): WeixinAccount | null {
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as WeixinAccount;
  } catch {
    return null;
  }
}

export function saveAccount(filepath: string, data: WeixinAccount): void {
  ensureDirSync(filepath);
  const tmp = filepath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filepath);
  try {
    chmodSync(filepath, 0o600);
  } catch {
    // Non-fatal on Windows
  }
}

export function loadPollOffset(filepath: string): string | null {
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw) as { offset?: string };
    return data.offset ?? null;
  } catch {
    return null;
  }
}

export async function savePollOffsetAsync(filepath: string, offset: string): Promise<void> {
  await ensureDir(filepath);
  const tmp = filepath + '.tmp';
  await writeFile(tmp, JSON.stringify({ offset }, null, 2), 'utf-8');
  await rename(tmp, filepath);
}

export function savePollOffset(filepath: string, offset: string): void {
  ensureDirSync(filepath);
  const tmp = filepath + '.tmp';
  writeFileSync(tmp, JSON.stringify({ offset }, null, 2), 'utf-8');
  renameSync(tmp, filepath);
}
