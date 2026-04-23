import * as Lark from '@larksuiteoapi/node-sdk'
import { appConfig } from './config.js'
import { opencodeClient, getLastTokenStats } from './opencode.js'
import { sessionManager } from './session.js'
import { StreamingCardController } from './streaming.js'
import { parseCommand, handleCommand, handleCardAction, getModelForChat, getAgentForChat, buildPermissionCard, buildQuestionCard } from './commands.js'

interface MessageData {
  sender: {
    sender_id: {
      open_id: string
      union_id?: string
      user_id?: string
    }
    sender_type: string
    tenant_key: string
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: 'p2p' | 'group'
    message_type: string
    content: string
    create_time: string
    mentions?: Array<{
      key: string
      id: { open_id: string }
      name: string
    }>
  }
}

interface CardActionData {
  action: {
    value: Record<string, string>  // 飞书卡片 value 是对象
  }
  context: {
    open_message_id: string
    open_chat_id: string
  }
}

interface FeishuCard {
  config: { wide_screen_mode: boolean }
  header: {
    title: { tag: string; content: string }
    template: string
  }
  elements: Array<{
    tag: string
    content?: string
    actions?: Array<{
      tag: string
      text: { tag: string; content: string }
      type: string
      value: { action: string }
    }>
  }>
}

export class FeishuBot {
  private client: Lark.Client
  private wsClient: Lark.WSClient
  private botName: string = 'OpenCode Bot'
  private processedMessages: Set<string> = new Set()
  private readonly DEDUP_TTL = 60_000 // 1 minute
  // Rate limiting: max messages per user per window
  private userMessageCounts: Map<string, { count: number; resetAt: number }> = new Map()
  private readonly RATE_LIMIT = 20 // max messages per window
  private readonly RATE_WINDOW = 60_000 // 1 minute window
  // Per-chat mutex: ensures only one message is processed at a time per chat
  private chatQueues: Map<string, Array<() => void>> = new Map()
  private chatProcessing: Set<string> = new Set()
  // Per-chat abort controller: allows /clear and /stop to cancel in-flight requests
  private chatAbortControllers: Map<string, AbortController> = new Map()
  // Track interactive card message IDs so we can update them after user action
  private interactiveCardMessages: Map<string, string> = new Map() // requestId -> messageId
  private rateLimitCleanupInterval: NodeJS.Timeout | null = null

  constructor() {
    const baseConfig = {
      appId: appConfig.feishu.app_id,
      appSecret: appConfig.feishu.app_secret,
      domain: appConfig.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    }

    this.client = new Lark.Client(baseConfig)
    this.wsClient = new Lark.WSClient(baseConfig)

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

  async start(): Promise<void> {
    console.log('[Bot] Starting Feishu bot...')

    const isHealthy = await opencodeClient.healthCheck()
    if (!isHealthy) {
      console.error('[Bot] ERROR: OpenCode server is not reachable at', appConfig.opencode.server_url)
      console.error('[Bot] Please start OpenCode server first: opencode serve --port 4096')
      process.exit(1)
    }
    console.log('[Bot] OpenCode server is healthy')

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessage(data as MessageData)
        } catch (error) {
          console.error('[Bot] Unhandled error in message handler:', error)
        }
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.handleCardAction(data as CardActionData)
        } catch (error) {
          console.error('[Bot] Unhandled error in card action handler:', error)
        }
      },
    })

    this.wsClient.start({ eventDispatcher })

    console.log('[Bot] WebSocket connected, listening for messages...')
    console.log('[Bot] Send a message to your bot in Feishu to start chatting!')
  }

  private async handleMessage(data: MessageData): Promise<void> {
    const { message, sender } = data

    // Dedup: Feishu uses at-least-once delivery, skip already-processed messages
    const msgId = message.message_id
    if (this.processedMessages.has(msgId)) {
      console.log(`[Bot] Duplicate message ignored: ${msgId}`)
      return
    }
    this.processedMessages.add(msgId)
    setTimeout(() => this.processedMessages.delete(msgId), this.DEDUP_TTL)
    // Memory leak protection: evict oldest entries when cap is reached
    if (this.processedMessages.size > 10_000) {
      // Delete the first (oldest) 5000 entries
      let count = 0
      for (const id of this.processedMessages) {
        if (count++ >= 5_000) break
        this.processedMessages.delete(id)
      }
    }

    if (sender.sender_type !== 'user') {
      return
    }

    // Rate limiting per user
    const userId = sender.sender_id.open_id
    const now = Date.now()
    const userRate = this.userMessageCounts.get(userId)
    if (userRate && now < userRate.resetAt) {
      if (userRate.count >= this.RATE_LIMIT) {
        console.log(`[Bot] Rate limited user: ${userId}`)
        await this.sendTextMessage(message.chat_id, '⚠️ 消息过于频繁，请稍后再试。')
        return
      }
      userRate.count++
    } else {
      this.userMessageCounts.set(userId, { count: 1, resetAt: now + this.RATE_WINDOW })
    }

    if (message.message_type !== 'text') {
      await this.sendTextMessage(
        message.chat_id,
        'Currently only text messages are supported. Please send text.'
      )
      return
    }

    let text: string
    try {
      const content = JSON.parse(message.content)
      text = content.text || ''
    } catch {
      text = message.content
    }

    if (message.chat_type === 'group') {
      const botMention = message.mentions?.find(
        m => m.key.includes('_user_') && m.id.open_id
      )
      if (!botMention) {
        return
      }
      text = text.replace(/@_user_\d+/g, '').trim()
    }

    if (!text.trim()) {
      return
    }

    console.log(`[Bot] Received message from ${sender.sender_id.open_id}: ${text.substring(0, 50)}...`)
    console.log(`[Bot] === PROCESSING MESSAGE (PID: ${process.pid}) ===`)

    // Add "received" reaction to user's message
    this.client.im.messageReaction.create({
      data: {
        reaction_type: { emoji_type: 'Get' }
      },
      path: { message_id: message.message_id }
    }).catch(() => {
      console.warn('[Bot] Failed to add reaction')
    })

    // Check if it's a command
    const { isCommand, command, args } = parseCommand(text)
    
    if (isCommand) {
      console.log(`[Bot] Detected command: /${command}`)
      // Abort in-flight request for /clear and /stop
      if (command === 'clear' || command === 'stop') {
        this.abortChat(message.chat_id)
      }
      const result = await handleCommand(message.chat_id, command, args)
      if (result.cardData) {
        await this.sendCardResult(message.chat_id, result.cardData)
      }
      return
    }

    // Regular message - process with OpenCode (serialized per chat)
    await this.withChatLock(message.chat_id, () =>
      this.processMessage(message.chat_id, text, sender.sender_id.open_id)
    )
  }

  /** Serialize message processing per chatId using a simple queue */
  private async withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
    // If already processing for this chat, queue up
    if (this.chatProcessing.has(chatId)) {
      console.log(`[Bot] withChatLock: ${chatId} is busy, queuing...`)
      await new Promise<void>((resolve, reject) => {
        const queue = this.chatQueues.get(chatId) || []
        // Store both resolve and reject so we can cancel queued messages
        queue.push(() => {
          console.log(`[Bot] withChatLock: ${chatId} queue callback executed`)
          resolve()
        })
        this.chatQueues.set(chatId, queue)
      })
    }

    console.log(`[Bot] withChatLock: ${chatId} starting processing`)
    this.chatProcessing.add(chatId)
    try {
      await fn()
    } finally {
      console.log(`[Bot] withChatLock: ${chatId} done, cleaning up`)
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
      console.log(`[Bot] Aborting in-flight request for chat: ${chatId}`)
      ac.abort()
      this.chatAbortControllers.delete(chatId)
    }
    // Clear the processing flag so new messages don't queue
    if (this.chatProcessing.has(chatId)) {
      console.log(`[Bot] Clearing chatProcessing for ${chatId}`)
      this.chatProcessing.delete(chatId)
    }
    // Clear the queue so waiting messages fail immediately instead of blocking
    const queue = this.chatQueues.get(chatId)
    if (queue && queue.length > 0) {
      console.log(`[Bot] Clearing ${queue.length} queued messages for chat: ${chatId}`)
      // Resolve all queued callbacks so they can proceed (and fail fast due to abort)
      while (queue.length > 0) {
        const next = queue.shift()!
        next()
      }
      this.chatQueues.delete(chatId)
    }
  }

  // Handle card button actions
  private async handleCardAction(data: CardActionData): Promise<void> {
    const chatId = data.context.open_chat_id
    const actionValue = data.action.value

    console.log(`[Bot] Card action:`, JSON.stringify(actionValue), `in chat ${chatId}`)

    const action = actionValue.action || actionValue.value || ''

    // Handle panel actions — these need async command execution
    if (action.startsWith('panel:')) {
      const panelAction = action.split(':')[1]
      const commandMap: Record<string, { command: string; args: string[] }> = {
        models: { command: 'models', args: [] },
        agents: { command: 'agents', args: [] },
        effort: { command: 'effort', args: [] },
        sessions: { command: 'sessions', args: [] },
        new_session: { command: 'session', args: ['new'] },
        status: { command: 'status', args: [] },
      }
      const cmd = commandMap[panelAction]
      if (cmd) {
        const result = await handleCommand(chatId, cmd.command, cmd.args)
        if (result.cardData) {
          await this.sendCardResult(chatId, result.cardData)
        }
      }
      return
    }

    const result = handleCardAction(action, chatId)
    // For permission/question actions, don't send a new card — we update the existing one below
    if (result?.cardData && !result.pendingAction) {
      await this.sendCardResult(chatId, result.cardData)
    }

    // Handle pending actions (permission_reply, question_answer)
    if (result?.pendingAction) {
      const { requestId } = result.pendingAction
      const cardMsgId = this.interactiveCardMessages.get(requestId)

      if (result.pendingAction.type === 'permission_reply') {
        try {
          await opencodeClient.replyPermission(
            requestId,
            result.pendingAction.reply as 'once' | 'always' | 'reject'
          )
          console.log(`[Bot] Permission reply sent: ${result.pendingAction.reply}`)
          // Update the permission card to show result (no buttons)
          if (cardMsgId) {
            const reply = result.pendingAction.reply as string
            await this.updateCardResult(cardMsgId, {
              title: reply === 'reject' ? '❌ 已拒绝' : '✅ 已授权',
              template: reply === 'reject' ? 'red' : 'green',
              content: reply === 'reject'
                ? '权限请求已拒绝'
                : `权限已${reply === 'once' ? '临时' : '永久'}授权`,
            })
            this.interactiveCardMessages.delete(requestId)
          }
        } catch (err) {
          console.error('[Bot] Permission reply failed:', err)
        }
      }
      if (result.pendingAction.type === 'question_answer') {
        try {
          await opencodeClient.replyQuestion(
            requestId,
            result.pendingAction.answers || []
          )
          console.log(`[Bot] Question reply sent`)
          // Update the question card to show result (no buttons)
          if (cardMsgId) {
            const answer = result.pendingAction.answers?.[0]?.[0] || ''
            await this.updateCardResult(cardMsgId, {
              title: '✅ 已回复',
              template: 'green',
              content: `已选择: ${answer}`,
            })
            this.interactiveCardMessages.delete(requestId)
          }
        } catch (err) {
          console.error('[Bot] Question reply failed:', err)
        }
      }
    }
  }

  private async sendCardResult(chatId: string, cardData: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
    buttons?: Array<{ text: string; value: string }>
  }): Promise<string | undefined> {
    // Build interactive card with buttons
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: cardData.title },
        template: cardData.template,
      },
      elements: [
        {
          tag: 'markdown',
          content: cardData.content,
        },
      ],
    }
    
    // Add action buttons if provided
    if (cardData.buttons?.length) {
      card.elements.push({
        tag: 'action',
        actions: cardData.buttons.map(btn => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.text },
          type: 'primary',
          value: { action: btn.value },
        })),
      })
    }
    
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return res.data?.message_id || undefined
  }

  /** Update an existing card (remove buttons, change status) */
  private async updateCardResult(messageId: string, cardData: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
  }): Promise<void> {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: cardData.title },
        template: cardData.template,
      },
      elements: [
        { tag: 'markdown', content: cardData.content },
      ],
    }
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    } catch (err) {
      console.warn('[Bot] Failed to update card:', err)
    }
  }

  private async processMessage(chatId: string, text: string, userId: string): Promise<void> {
    console.log(`[Bot] processMessage START: ${chatId}`)
    const controller = new StreamingCardController(this.client)
    const model = getModelForChat(chatId)
    const agent = getAgentForChat(chatId)
    let progressInterval: ReturnType<typeof setInterval> | undefined
    let completed = false // Prevent progress poll from updating after complete

    // Register abort controller for this chat so /clear and /stop can cancel
    const chatAbort = new AbortController()
    this.chatAbortControllers.set(chatId, chatAbort)
    console.log(`[Bot] Created AbortController for ${chatId}, aborted=${chatAbort.signal.aborted}`)

    try {
      await controller.init(chatId)
      console.log(`[Bot] controller.init done, checking abort...`)

      // Check if already aborted (e.g. user sent /clear before init finished)
      if (chatAbort.signal.aborted) {
        console.log(`[Bot] Aborted before stream, throwing`)
        throw new Error('已取消')
      }

      let session = sessionManager.getSession(chatId)
      if (!session) {
        const opencodeSessionId = await opencodeClient.createSession(`Feishu Chat: ${chatId.substring(0, 8)}`)
        sessionManager.setSession(chatId, opencodeSessionId)
        session = sessionManager.getSession(chatId)
      }

      sessionManager.updateActivity(chatId)

      // Start progress polling — updates the card every 8s during long tasks
      const startTime = Date.now()
      const sentInteractiveIds = new Set<string>()
      let lastStatusKey = ''
      progressInterval = setInterval(async () => {
        if (chatAbort.signal.aborted || completed) {
          clearInterval(progressInterval)
          return
        }
        try {
          const elapsed = Math.floor((Date.now() - startTime) / 1000)
          const progress = await opencodeClient.getSessionProgress(session!.opencodeSessionId)
          if (!progress) return

          // Build status key (without elapsed time) to detect actual changes
          const statusKey = `${progress.status}|${progress.toolName || ''}|${progress.toolSummary || ''}`

          let statusText = `⏳ 正在处理中... (${elapsed}秒)`
          if (progress.status === 'running' && progress.toolName) {
            const toolDesc = progress.toolInput
              ? Object.values(progress.toolInput).map(v => String(v).substring(0, 50)).join(', ')
              : ''
            statusText = `🔧 ${progress.toolName}${toolDesc ? `: ${toolDesc}` : ''}`
            if (progress.toolSummary) statusText += `\n📋 ${progress.toolSummary}`
            statusText += ` (${elapsed}秒)`
          } else if (progress.status === 'pending' && progress.toolName) {
            statusText = `🔐 等待权限确认: \`${progress.toolName}\``
            if (progress.toolSummary) statusText += `\n📋 ${progress.toolSummary}`
            statusText += ` (${elapsed}秒)`
          } else if (progress.status === 'thinking') {
            statusText = `🤔 AI 正在思考中...`
            if (progress.toolSummary) statusText += `\n📋 ${progress.toolSummary}`
            statusText += ` (${elapsed}秒)`
          } else if (progress.status === 'waiting') {
            statusText = `⏳ 等待 OpenCode 响应... (${elapsed}秒)`
          }

          // Only update card if status changed, or every 30s as a heartbeat
          if (statusKey !== lastStatusKey || elapsed % 30 < 8) {
            if (statusKey !== lastStatusKey) {
              console.log(`[Bot] Progress poll: ${progress.status} -> updating card`)
            }
            lastStatusKey = statusKey
            await controller.updateStatus(statusText)
          }

          // Check permissions/questions every poll when not idle
          if (progress.status !== 'idle') {
            // Check for pending permissions
            try {
              const permissions = await opencodeClient.getPendingPermissions()
              for (const perm of permissions) {
                if (perm.sessionID === session!.opencodeSessionId && !sentInteractiveIds.has(perm.id)) {
                  sentInteractiveIds.add(perm.id)
                  const cardData = buildPermissionCard({
                    requestId: perm.id,
                    permissionType: perm.permission,
                    title: (perm.metadata?.filepath as string) || perm.permission,
                  })
                  await controller.updateStatus(`🔐 需要权限确认: ${perm.permission}\n请查看下方卡片操作...`)
                  const msgId = await this.sendCardResult(chatId, cardData)
                  if (msgId) this.interactiveCardMessages.set(perm.id, msgId)
                  console.log(`[Bot] Permission request sent: ${perm.id}`)
                }
              }
            } catch {
              // Ignore permission check errors
            }

            // Check for pending questions
            try {
              const questions = await opencodeClient.getPendingQuestions()
              for (const q of questions) {
                if (q.sessionID === session!.opencodeSessionId && !sentInteractiveIds.has(q.id)) {
                  sentInteractiveIds.add(q.id)
                  const cardData = buildQuestionCard({
                    requestId: q.id,
                    header: q.header || '问题',
                    question: q.question || '',
                    options: q.options || [{ label: 'Yes' }, { label: 'No' }],
                  })
                  await controller.updateStatus(`❓ 需要回答问题\n请查看下方卡片操作...`)
                  const msgId = await this.sendCardResult(chatId, cardData)
                  if (msgId) this.interactiveCardMessages.set(q.id, msgId)
                  console.log(`[Bot] Question request sent: ${q.id}`)
                }
              }
            } catch {
              // Ignore question check errors
            }
          }
        } catch (pollError) {
          console.warn('[Bot] Progress poll error:', pollError)
        }
      }, 8_000)

      let fullResponse = ''
      try {
        for await (const chunk of opencodeClient.streamMessage(session!.opencodeSessionId, text, model, agent)) {
          fullResponse += chunk
        }
      } catch (streamError) {
        if (fullResponse.length > 0) {
          console.warn(`[Bot] Stream interrupted after ${fullResponse.length} chars, using partial response`)
        } else {
          // Don't retry — OpenCode may still be executing (e.g. git clone, build)
          // Retrying would queue a duplicate request
          console.error('[Bot] Request failed:', streamError)
          const isTimeout = streamError instanceof DOMException || (streamError as Error)?.name === 'AbortError'
          throw new Error(isTimeout
            ? '请求超时，OpenCode 可能仍在执行中。请稍后查看或使用 /stop 停止。'
            : `请求失败: ${(streamError as Error).message}`)
        }
      }

      // Simulate streaming by feeding text in chunks for typewriter effect
      if (fullResponse.length > 0) {
        await this.simulateStreaming(controller, fullResponse)
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
      this.chatAbortControllers.delete(chatId)
      await controller.complete(fullResponse + footer)
      console.log(`[Bot] Response sent: ${fullResponse.length} chars`)

    } catch (error) {
      clearInterval(progressInterval)
      completed = true
      this.chatAbortControllers.delete(chatId)
      console.error('[Bot] Error processing message:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await controller.error(`Failed to process message: ${errorMessage}`)
    }
  }

  /** Feed text to streaming card in chunks to create typewriter effect */
  private async simulateStreaming(controller: StreamingCardController, text: string): Promise<void> {
    const CHUNK_SIZE = 120 // characters per chunk (larger for faster feel)
    const CHUNK_DELAY = 30 // ms between chunks (faster)

    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const chunk = text.slice(i, i + CHUNK_SIZE)
      await controller.appendText(chunk)
      if (i + CHUNK_SIZE < text.length) {
        await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY))
      }
    }
  }

  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }

  stop(): void {
    if (this.rateLimitCleanupInterval) {
      clearInterval(this.rateLimitCleanupInterval)
      this.rateLimitCleanupInterval = null
    }
    sessionManager.stop()
    this.userMessageCounts.clear()
    this.processedMessages.clear()
    console.log('[Bot] Stopped')
  }
}
