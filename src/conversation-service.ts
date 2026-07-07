export class ConversationService {
  private processedMessages: Set<string> = new Set()
  private userMessageCounts: Map<string, { count: number; resetAt: number }> = new Map()
  private chatQueues: Map<string, Array<() => void>> = new Map()
  private chatProcessing: Set<string> = new Set()
  private chatAbortControllers: Map<string, AbortController> = new Map()

  private dedupTtl: number
  private rateLimit: number
  private rateWindow: number

  private rateLimitCleanupInterval: NodeJS.Timeout | null = null

  constructor(config?: { dedupTtl?: number; rateLimit?: number; rateWindow?: number }) {
    this.dedupTtl = config?.dedupTtl ?? 60_000
    this.rateLimit = config?.rateLimit ?? 20
    this.rateWindow = config?.rateWindow ?? 60_000

    // Periodic cleanup for rate limiter
    this.rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now()
      for (const [userId, rate] of this.userMessageCounts.entries()) {
        if (now >= rate.resetAt) {
          this.userMessageCounts.delete(userId)
        }
      }
    }, 60_000)
  }

  /**
   * Dedup: returns true if message should be skipped (already processed).
   * Registers the message and schedules cleanup via TTL.
   */
  isDuplicate(msgId: string): boolean {
    if (this.processedMessages.has(msgId)) {
      return true
    }
    this.processedMessages.add(msgId)
    setTimeout(() => this.processedMessages.delete(msgId), this.dedupTtl)

    // Memory leak protection: evict oldest entries when cap is reached
    if (this.processedMessages.size > 10_000) {
      let count = 0
      for (const id of this.processedMessages) {
        if (count++ >= 5_000) break
        this.processedMessages.delete(id)
      }
    }
    return false
  }

  /**
   * Rate limiting: returns true if the user has exceeded the rate limit
   * and should be rate-limited. Increments the counter on each call.
   */
  isRateLimited(userId: string): boolean {
    const now = Date.now()
    const userRate = this.userMessageCounts.get(userId)
    if (userRate && now < userRate.resetAt) {
      if (userRate.count >= this.rateLimit) {
        return true
      }
      userRate.count++
    } else {
      this.userMessageCounts.set(userId, { count: 1, resetAt: now + this.rateWindow })
    }
    return false
  }

  /**
   * Serialize message processing per chatId using a simple queue.
   * Guarantees only one fn() runs at a time per chatId.
   */
  async withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
    // If already processing for this chat, queue up
    if (this.chatProcessing.has(chatId)) {
      await new Promise<void>((resolve) => {
        const queue = this.chatQueues.get(chatId) || []
        queue.push(() => {
          resolve()
        })
        this.chatQueues.set(chatId, queue)
      })
    }

    this.chatProcessing.add(chatId)
    try {
      await fn()
    } finally {
      this.chatProcessing.delete(chatId)
      // Process next in queue
      const queue = this.chatQueues.get(chatId)
      if (queue && queue.length > 0) {
        const next = queue.shift()!
        if (queue.length === 0) {
          this.chatQueues.delete(chatId)
        }
        next()
      }
    }
  }

  /** Register an abort controller for a chat. */
  registerAbort(chatId: string, controller: AbortController): void {
    this.chatAbortControllers.set(chatId, controller)
  }

  /** Signal abort, clear the queue, and remove the processing flag for a chat. */
  abort(chatId: string): void {
    const ac = this.chatAbortControllers.get(chatId)
    if (ac) {
      console.log(`[ConvService] Aborting in-flight request for chat: ${chatId}`)
      ac.abort()
      this.chatAbortControllers.delete(chatId)
    }
    // Clear the processing flag so new messages don't queue
    if (this.chatProcessing.has(chatId)) {
      console.log(`[ConvService] Clearing chatProcessing for ${chatId}`)
      this.chatProcessing.delete(chatId)
    }
    // Clear the queue so waiting messages fail immediately instead of blocking
    const queue = this.chatQueues.get(chatId)
    if (queue && queue.length > 0) {
      console.log(`[ConvService] Clearing ${queue.length} queued messages for chat: ${chatId}`)
      while (queue.length > 0) {
        const next = queue.shift()!
        next()
      }
      this.chatQueues.delete(chatId)
    }
  }

  /** Remove an abort controller for a chat without signaling abort. */
  deregisterAbort(chatId: string): void {
    this.chatAbortControllers.delete(chatId)
  }

  /** Clear all state (dedup, rate limiting, queues, abort controllers). */
  clearAll(): void {
    this.processedMessages.clear()
    this.userMessageCounts.clear()
    this.chatQueues.clear()
    this.chatProcessing.clear()
    this.chatAbortControllers.clear()
  }

  /** Stop the rate limit cleanup interval and clear all state. */
  stop(): void {
    if (this.rateLimitCleanupInterval) {
      clearInterval(this.rateLimitCleanupInterval)
      this.rateLimitCleanupInterval = null
    }
    this.clearAll()
    console.log('[ConvService] Stopped')
  }
}
