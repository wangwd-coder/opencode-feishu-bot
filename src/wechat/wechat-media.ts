/**
 * WeChat media download with AES decryption
 *
 * AES-128-ECB encryption/decryption for CDN media.
 * CDN downloads are encrypted and must be decrypted using the
 * key provided in the message's CDNMedia field.
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import type { CDNMedia } from './wechat-types.js';

const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100 MB

// ──────────────────────────────────────────────
// Encryption / Decryption
// ──────────────────────────────────────────────

/**
 * Generate a random 16-byte AES key for media encryption
 */
export function generateMediaKey(): Buffer {
  return crypto.randomBytes(16);
}

/**
 * AES-128-ECB encrypt with PKCS7 padding
 */
export function encryptMedia(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-ECB decrypt with PKCS7 unpadding
 */
export function decryptMedia(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Calculate padded ciphertext size for a given plaintext size
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ──────────────────────────────────────────────
// CDN download + decrypt
// ──────────────────────────────────────────────

/**
 * Download encrypted media from CDN and decrypt it.
 *
 * @param cdnBaseUrl - CDN base URL (e.g. https://novac2c.cdn.weixin.qq.com/c2c)
 * @param media - CDN media descriptor containing encrypt_query_param and aes_key
 * @returns Decrypted media buffer
 */
export async function downloadMedia(cdnBaseUrl: string, media: CDNMedia): Promise<Buffer> {
  const aesKey = Buffer.from(media.aes_key, 'base64');
  const url = `${cdnBaseUrl}?${media.encrypt_query_param}`;

  console.log(`[WeChat] Downloading media from CDN: ${cdnBaseUrl}?...`);

  const res = await undiciFetch(url, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`[WeChat] CDN download failed: ${res.status} ${res.statusText}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());

  if (encrypted.length > MAX_MEDIA_SIZE) {
    throw new Error(`[WeChat] Media too large: ${encrypted.length} bytes (max ${MAX_MEDIA_SIZE})`);
  }

  console.log(`[WeChat] Downloaded ${encrypted.length} encrypted bytes, decrypting...`);
  return decryptMedia(encrypted, aesKey);
}
