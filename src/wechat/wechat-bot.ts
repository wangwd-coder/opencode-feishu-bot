/**
 * WeChat Bot — core long-polling message processor
 *
 * Mirrors FeishuBot patterns (dedup, rate limiting, chat serialization)
 * but uses text-only interactions via WeChatApiClient.
 */

import { appConfig } from '../config.js'
import { opencodeClient, getLastTokenStats } from '../opencode.js'
import { sessionManager } from '../session.js'
import { parseCommand, handleCommand, handleCardAction, getModelForChat, getAgentForChat } from '../commands.js'
import { interactionHandler } from '../interaction-handler.js'
import { WeChatApiClient } from './wechat-api.js'
import { startQrLoginSession, pollQrLoginStatus } from './wechat-auth.js'
import { loadAccount, saveAccount, loadPollOffset, savePollOffset } from './wechat-store.js'
import {
  renderCommandAsText,
  renderPermissionAsText,
  renderQuestionAsText,
  chunkText,
  resolveNumberReply,
} from './commands-text.js'
import type { WeixinMessage, WeixinAccount } from './wechat-types.js'
import { MessageType, ERRCODE_SESSION_EXPIRED } from './wechat-types.js'

export class WeChatBot {
  // Same patterns as FeishuBot:
  private processedMessages: Set<string> = new Set()
  private userMessageCounts: Map<string, { count: number; resetAt: number }> = new Map()
  private chatQueues: Map<string, Array<() => void>> = new Map()
  private chatProcessing: Set<string> = new Set()
  private chatAbortControllers: Map<string, AbortController> = new Map()
  private pendingCustomInput: Map<string, string> = new Map()
  // Active options maps for permission/question reply matching: peerUserId -> options
  private activeOptions: Map<string, Map<number, { action: string; value: string }>> = new Map()

  private readonly DEDUP_TTL = 60_000
  private readonly RATE_LIMIT = 20
  private readonly RATE_WINDOW = 60_000

  // WeChat-specific:
  private apiClient: WeChatApiClient
  private account: WeixinAccount | null = null
  private pollOffset: string | null = null
  private running = false
  private rateLimitCleanupInterval: NodeJS.Timeout | null = null
  private pollRetryDelay = 5_000

  constructor() {
    this.apiClient = new WeChatApiClient(appConfig.wechat.api_base_url)

    // Periodic cleanup for rate limiter (same as FeishuBot)
    this.rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now()
      for (const [userId, rate] of this.userMessageCounts.entries()) {
        if (now >= rate.resetAt) {
          this.userMessageCounts.delete(userId)
        }
      }
    }, 60_000)
  }

  async start(): Promise<void> {
    console.log('[WeChat] Starting WeChat bot...')

    if (!appConfig.wechat.enabled) {
      console.log('[WeChat] WeChat is disabled in config, skipping.')
      return
    }

    // Health check
    const isHealthy = await opencodeClient.healthCheck()
    if (!isHealthy) {
      console.error('[WeChat] ERROR: OpenCode server is not reachable at', appConfig.opencode.server_url)
      console.error('[WeChat] Please start OpenCode server first: opencode serve --port 4096')
      process.exit(1)
    }
    console.log('[WeChat] OpenCode server is healthy')

    // Load saved account
    const tokensPath = `${appConfig.wechat.data_dir}/tokens.json`
    this.account = loadAccount(tokensPath)

    if (!this.account) {
      // QR login flow
      console.log('[WeChat] No saved account, starting QR login...')
      this.account = await this.performQrLogin()
      if (!this.account) {
        console.error('[WeChat] QR login failed or timed out')
        process.exit(1)
      }
    }

    console.log(`[WeChat] Using account: ${this.account.accountId}`)

    // Verify connection
    try {
      const config = await this.apiClient.getConfig(this.account.token)
      if (config.errcode && config.errcode !== 0) {
        console.error('[WeChat] Config check failed:', config.errmsg)
        // Token may be expired, re-login
        console.log('[WeChat] Re-authenticating via QR login...')
        this.account = await this.performQrLogin()
        if (!this.account) {
          console.error('[WeChat] Re-authentication failed')
          process.exit(1)
        }
      }
    } catch (err) {
      console.warn('[WeChat] Config check error (non-fatal):', err)
    }

    // Load saved poll offset
    const offsetPath = `${appConfig.wechat.data_dir}/offset.json`
    this.pollOffset = loadPollOffset(offsetPath)

    this.running = true
    console.log('[WeChat] Starting long-poll loop...')

    // Start polling
    this.pollLoop().catch((err) => {
      console.error('[WeChat] Poll loop crashed:', err)
      this.running = false
    })
  }

  stop(): void {
    this.running = false
    if (this.rateLimitCleanupInterval) {
      clearInterval(this.rateLimitCleanupInterval)
      this.rateLimitCleanupInterval = null
    }
    sessionManager.stop()
    this.userMessageCounts.clear()
    this.processedMessages.clear()
    console.log('[WeChat] Stopped')
  }

  // ──────────────────────────────────────────────
  // QR Login
  // ──────────────────────────────────────────────

  private async performQrLogin(): Promise<WeixinAccount | null> {
    try {
      const { sessionId } = await startQrLoginSession()

      // Poll until confirmed or failed
      for (let i = 0; i < 120; i++) { // max ~10 minutes at 5s intervals
        const session = await pollQrLoginStatus(sessionId)

        if (session.status === 'confirmed' && session.accountId) {
          // Account was saved by wechat-auth.ts, load it
          const tokensPath = `${appConfig.wechat.data_dir}/tokens.json`
          const account = loadAccount(tokensPath)
          if (account) {
            console.log('[WeChat] Login successful!')
            return account
          }
          // Fallback: try loading by accountId
          const accountPath = `${appConfig.wechat.data_dir}/${session.accountId}.json`
          return loadAccount(accountPath)
        }

        if (session.status === 'failed') {
          console.error('[WeChat] QR login failed:', session.error)
          return null
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, 5_000))
      }

      console.error('[WeChat] QR login timed out')
      return null
    } catch (err) {
      console.error('[WeChat] QR login error:', err)
      return null
    }
  }

  // ──────────────────────────────────────────────
  // Long-poll loop
  // ──────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.apiClient.getUpdates(
          this.account!.token,
          this.pollOffset ?? undefined,
        )

        // Handle session expiry
        if (response.errcode === ERRCODE_SESSION_EXPIRED) {
          console.error('[WeChat] Session expired, re-authenticating...')
          this.account = await this.performQrLogin()
          if (!this.account) {
            console.error('[WeChat] Re-authentication failed, stopping')
            this.running = false
            return
          }
          continue
        }

        // Update poll offset
        if (response.get_updates_buf) {
          this.pollOffset = response.get_updates_buf
          const offsetPath = `${appConfig.wechat.data_dir}/offset.json`
          savePollOffset(offsetPath, this.pollOffset)
        }

        // Process messages
        const msgs = response.msgs || []
        for (const msg of msgs) {
          try {
            await this.handleMessage(msg)
          } catch (err) {
            console.error('[WeChat] Error handling message:', err)
          }
        }

        // Reset retry delay on success
        this.pollRetryDelay = 5_000
      } catch (err) {
        console.error('[WeChat] Poll error:', err)
        if (this.running) {
          console.log(`[WeChat] Retrying in ${this.pollRetryDelay / 1000}s...`)
          await new Promise(resolve => setTimeout(resolve, this.pollRetryDelay))
          this.pollRetryDelay = Math.min(this.pollRetryDelay * 2, 60_000)
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  // Message handling pipeline
  // ──────────────────────────────────────────────

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    // Only handle user text messages
    if (!msg.from_user_id || msg.msg_type !== MessageType.USER) {
      return
    }

    const msgId = msg.message_id || `wx_${msg.from_user_id}_${msg.create_time}_${Math.random().toString(36).slice(2, 8)}`

    // Dedup
    if (this.processedMessages.has(msgId)) {
      console.log(`[WeChat] Duplicate message ignored: ${msgId}`)
      return
    }
    this.processedMessages.add(msgId)
    setTimeout(() => this.processedMessages.delete(msgId), this.DEDUP_TTL)
    // Memory leak protection: evict oldest entries when cap is reached
    if (this.processedMessages.size > 10_000) {
      let count = 0
      for (const id of this.processedMessages) {
        if (count++ >= 5_000) break
        this.processedMessages.delete(id)
      }
    }

    // Extract text
    const text = this.extractText(msg)
    if (!text.trim()) {
      return
    }

    const peerUserId = msg.from_user_id

    // Rate limiting per user
    const now = Date.now()
    const userRate = this.userMessageCounts.get(peerUserId)
    if (userRate && now < userRate.resetAt) {
      if (userRate.count >= this.RATE_LIMIT) {
        console.log(`[WeChat] Rate limited user: ${peerUserId}`)
        await this.sendText(peerUserId, '⚠️ 消息过于频繁，请稍后再试。')
        return
      }
      userRate.count++
    } else {
      this.userMessageCounts.set(peerUserId, { count: 1, resetAt: now + this.RATE_WINDOW })
    }

    // User whitelist
    const allowedUsers = appConfig.wechat.allowed_users
    if (allowedUsers.length > 0 && !allowedUsers.includes(peerUserId)) {
      console.log(`[WeChat] User ${peerUserId} not in whitelist, ignoring`)
      return
    }

    console.log(`[WeChat] Received message from ${peerUserId}: ${text.substring(0, 50)}...`)

    // Check if this is a number reply matching active options (permission/question)
    const activeOpts = this.activeOptions.get(peerUserId)
    if (activeOpts && activeOpts.size > 0) {
      const actionValue = resolveNumberReply(text, activeOpts)
      if (actionValue !== null) {
        // Clear options after use
        this.activeOptions.delete(peerUserId)
        console.log(`[WeChat] Number reply resolved: ${actionValue}`)
        await this.handleInteractionReply(peerUserId, actionValue)
        return
      }
    }

    // Check if this is a custom question answer
    const pendingQuestionId = this.pendingCustomInput.get(peerUserId)
    if (pendingQuestionId) {
      this.pendingCustomInput.delete(peerUserId)
      console.log(`[WeChat] Custom question answer: ${pendingQuestionId} -> ${text.substring(0, 50)}`)
      try {
        await interactionHandler.handleQuestionReply(pendingQuestionId, [[text]])
        await this.sendText(peerUserId, '✅ 回答已提交')
      } catch (err) {
        console.error('[WeChat] Custom question reply failed:', err)
        await this.sendText(peerUserId, '❌ 回答提交失败，请重试')
      }
      return
    }

    // Command detection
    const { isCommand, command, args } = parseCommand(text)

    if (isCommand) {
      console.log(`[WeChat] Detected command: /${command}`)
      // Abort in-flight request for /clear and /stop
      if (command === 'clear' || command === 'stop') {
        this.abortChat(peerUserId)
      }
      const result = await handleCommand(peerUserId, command, args)
      const textResponse = renderCommandAsText(result)
      if (textResponse) {
        await this.sendText(peerUserId, textResponse)
      }
      return
    }

    // Regular message - process with OpenCode (serialized per chat)
    await this.withChatLock(peerUserId, () =>
      this.processMessage(peerUserId, text)
    )
  }

  // ──────────────────────────────────────────────
  // Interaction reply handler (permissions/questions)
  // ──────────────────────────────────────────────

  private async handleInteractionReply(peerUserId: string, actionValue: string): Promise<void> {
    const result = handleCardAction(actionValue, peerUserId)

    if (!result) {
      console.warn(`[WeChat] Unknown interaction action: ${actionValue}`)
      return
    }

    // Send immediate feedback
    if (result.cardData) {
      const feedback = renderCommandAsText(result)
      if (feedback) {
        await this.sendText(peerUserId, feedback)
      }
    }

    // Handle pending actions (permission_reply, question_answer)
    if (result.pendingAction) {
      const { requestId } = result.pendingAction
      console.log(`[WeChat] Handling ${result.pendingAction.type}: requestId=${requestId}`)

      try {
        if (result.pendingAction.type === 'permission_reply') {
          await interactionHandler.handlePermissionReply(
            requestId,
            result.pendingAction.reply as 'once' | 'always' | 'reject',
          )
        } else if (result.pendingAction.type === 'question_answer') {
          await interactionHandler.handleQuestionReply(
            requestId,
            result.pendingAction.answers || [],
          )
        }
      } catch (err) {
        console.error(`[WeChat] ${result.pendingAction.type} failed:`, err)
        await this.sendText(peerUserId, '❌ 操作失败，请稍后重试')
      }
    }
  }

  // ──────────────────────────────────────────────
  // Process message with OpenCode (adapted from FeishuBot.processMessage)
  // ──────────────────────────────────────────────

  private async processMessage(peerUserId: string, text: string): Promise<void> {
    const model = getModelForChat(peerUserId)
    const agent = getAgentForChat(peerUserId)
    let progressInterval: ReturnType<typeof setInterval> | undefined
    let completed = false

    // Register abort controller for this chat so /clear and /stop can cancel
    const chatAbort = new AbortController()
    this.chatAbortControllers.set(peerUserId, chatAbort)

    try {
      // Check if already aborted
      if (chatAbort.signal.aborted) {
        throw new Error('已取消')
      }

      let session = sessionManager.getSession(peerUserId)
      if (!session) {
        const opencodeSessionId = await opencodeClient.createSession(`WeChat: ${peerUserId.substring(0, 8)}`)
        sessionManager.setSession(peerUserId, opencodeSessionId)
        session = sessionManager.getSession(peerUserId)
      }

      sessionManager.updateActivity(peerUserId)

      // Send "processing" indicator
      await this.sendText(peerUserId, '⏳ 正在处理中...')

      // Start progress polling — checks for permissions/questions during long tasks
      const startTime = Date.now()
      progressInterval = setInterval(async () => {
        if (chatAbort.signal.aborted || completed) {
          if (progressInterval) clearInterval(progressInterval)
          return
        }
        try {
          const elapsed = Math.floor((Date.now() - startTime) / 1000)
          const progress = await opencodeClient.getSessionProgress(session!.opencodeSessionId)
          if (!progress || completed) return

          // Check permissions/questions only when tools are active
          if (progress.status === 'running' || progress.status === 'pending' || progress.status === 'thinking') {
            const pending = await interactionHandler.checkPending(session!.opencodeSessionId)
            for (const item of pending) {
              if (item.type === 'permission') {
                const { text: permText, options } = renderPermissionAsText({
                  requestId: item.requestId,
                  permissionType: item.cardData.title.replace('🔐 权限请求: ', ''),
                  title: item.cardData.content,
                })
                this.activeOptions.set(peerUserId, options)
                await this.sendText(peerUserId, permText)
              } else {
                // Build question data from cardData
                const { text: qText, options } = renderQuestionAsText({
                  requestId: item.requestId,
                  questions: [{
                    question: item.cardData.content,
                    header: item.cardData.title.replace('❓ ', ''),
                    options: (item.cardData.buttons || []).map(btn => ({
                      label: btn.text,
                    })),
                    custom: true,
                  }],
                })
                this.activeOptions.set(peerUserId, options)
                await this.sendText(peerUserId, qText)
              }
              console.log(`[WeChat] ${item.type} request sent: ${item.requestId}`)
            }
          }
        } catch (pollError) {
          console.warn('[WeChat] Progress poll error:', pollError)
        }
      }, 5_000)

      // Stream message via OpenCode
      let fullResponse = ''
      try {
        for await (const chunk of opencodeClient.streamMessage(
          session!.opencodeSessionId,
          text,
          model,
          agent,
          undefined,
          chatAbort.signal,
        )) {
          fullResponse += chunk
        }
      } catch (streamError) {
        if (fullResponse.length > 0) {
          console.warn(`[WeChat] Stream interrupted after ${fullResponse.length} chars, using partial response`)
        } else {
          console.error('[WeChat] Request failed:', streamError)
          const isTimeout = streamError instanceof DOMException || (streamError as Error)?.name === 'AbortError'
          throw new Error(isTimeout
            ? '请求超时，OpenCode 可能仍在执行中。请稍后查看或使用 /stop 停止。'
            : `请求失败: ${(streamError as Error).message}`)
        }
      }

      // Build footer with token stats
      const stats = getLastTokenStats()
      let footer = ''
      if (stats && stats.total > 0) {
        const parts: string[] = []
        parts.push(`输入 ${stats.input}`)
        parts.push(`输出 ${stats.output}`)
        if (stats.reasoning > 0) parts.push(`思考 ${stats.reasoning}`)
        if (stats.cacheRead > 0) parts.push(`缓存命中 ${stats.cacheRead}`)
        footer = `\n\n---\n📊 tokens: ${parts.join(' / ')} (共 ${stats.total})`
      }

      clearInterval(progressInterval)
      completed = true
      this.chatAbortControllers.delete(peerUserId)

      // Send full response as text chunks
      if (fullResponse.length > 0) {
        await this.sendText(peerUserId, fullResponse + footer)
        console.log(`[WeChat] Response sent: ${fullResponse.length} chars`)
      }
    } catch (error) {
      if (progressInterval) clearInterval(progressInterval)
      completed = true
      this.chatAbortControllers.delete(peerUserId)
      console.error('[WeChat] Error processing message:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await this.sendText(peerUserId, `❌ 处理失败: ${errorMessage}`)
    }
  }

  // ──────────────────────────────────────────────
  // Chat serialization (same as FeishuBot)
  // ──────────────────────────────────────────────

  /** Serialize message processing per chatId using a simple queue */
  private async withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
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

  /** Abort any in-flight request for this chat (called by /clear, /stop) */
  abortChat(chatId: string): void {
    const ac = this.chatAbortControllers.get(chatId)
    if (ac) {
      console.log(`[WeChat] Aborting in-flight request for chat: ${chatId}`)
      ac.abort()
      this.chatAbortControllers.delete(chatId)
    }
    if (this.chatProcessing.has(chatId)) {
      console.log(`[WeChat] Clearing chatProcessing for ${chatId}`)
      this.chatProcessing.delete(chatId)
    }
    const queue = this.chatQueues.get(chatId)
    if (queue && queue.length > 0) {
      console.log(`[WeChat] Clearing ${queue.length} queued messages for chat: ${chatId}`)
      while (queue.length > 0) {
        const next = queue.shift()!
        next()
      }
      this.chatQueues.delete(chatId)
    }
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  /** Extract text content from a WeixinMessage */
  private extractText(msg: WeixinMessage): string {
    if (!msg.item_list || msg.item_list.length === 0) {
      return ''
    }
    // Concatenate all text items
    const parts: string[] = []
    for (const item of msg.item_list) {
      if (item.text_item?.text) {
        parts.push(item.text_item.text)
      }
    }
    return parts.join('\n')
  }

  /** Send text in chunks respecting WeChat's character limit */
  private async sendText(peerUserId: string, text: string): Promise<void> {
    if (!this.account) return
    const chunks = chunkText(text)
    for (const chunk of chunks) {
      try {
        await this.apiClient.sendTextMessage(this.account.token, peerUserId, chunk)
      } catch (err) {
        console.error('[WeChat] Failed to send text message:', err)
        // If session expired, don't keep trying remaining chunks
        break
      }
    }
  }
}
