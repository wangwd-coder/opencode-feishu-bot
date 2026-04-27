/**
 * WeChat ChatId encoding/decoding
 *
 * Format: weixin::<accountId>::<peerUserId>
 * Ensures each (account, peer) pair maps to a unique conversation identifier.
 */

const WEIXIN_PREFIX = 'weixin::';
const SEPARATOR = '::';

/**
 * Encode accountId + peerUserId into a ChatId string
 */
export function encodeWeixinChatId(accountId: string, peerUserId: string): string {
  return `${WEIXIN_PREFIX}${accountId}${SEPARATOR}${peerUserId}`;
}

/**
 * Decode a ChatId string into accountId + peerUserId.
 * Returns null if the format is invalid.
 */
export function decodeWeixinChatId(chatId: string): { accountId: string; peerUserId: string } | null {
  if (!chatId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = chatId.slice(WEIXIN_PREFIX.length);
  const sepIdx = rest.indexOf(SEPARATOR);
  if (sepIdx < 0) return null;
  const accountId = rest.slice(0, sepIdx);
  const peerUserId = rest.slice(sepIdx + SEPARATOR.length);
  if (!accountId || !peerUserId) return null;
  return { accountId, peerUserId };
}

/**
 * Check if a ChatId is a valid Weixin format
 */
export function isWeixinChatId(chatId: string): boolean {
  return chatId.startsWith(WEIXIN_PREFIX) && decodeWeixinChatId(chatId) !== null;
}
