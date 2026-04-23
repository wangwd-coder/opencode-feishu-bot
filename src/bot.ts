import * as Lark from '@larksuiteoapi/node-sdk'
import { appConfig } from './config.js'
import { opencodeClient } from './opencode.js'
import { sessionManager } from './session.js'
import { StreamingCardController } from './streaming.js'
import { parseCommand, handleCommand, handleCardAction, getModelForChat } from './commands.js'

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
      await new Promise<void>((resolve) => {
        const queue = this.chatQueues.get(chatId) || []
        queue.push(resolve)
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

  // Handle card button actions
  private async handleCardAction(data: CardActionData): Promise<void> {
    const chatId = data.context.open_chat_id
    const actionValue = data.action.value
    
    console.log(`[Bot] Card action:`, JSON.stringify(actionValue), `in chat ${chatId}`)
    
    // 飞书卡片按钮 value 是对象，需要提取 action 字段
    const action = actionValue.action || actionValue.value || ''
    
    const result = handleCardAction(action, chatId)
    if (result?.cardData) {
      await this.sendCardResult(chatId, result.cardData)
    }
  }

  private async sendCardResult(chatId: string, cardData: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
    buttons?: Array<{ text: string; value: string }>
  }): Promise<void> {
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
    
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
  }

  private async processMessage(chatId: string, text: string, userId: string): Promise<void> {
    const controller = new StreamingCardController(this.client)
    const model = getModelForChat(chatId)

    try {
      await controller.init(chatId)

      let session = sessionManager.getSession(chatId)
      if (!session) {
        const opencodeSessionId = await opencodeClient.createSession(`Feishu Chat: ${chatId.substring(0, 8)}`)
        sessionManager.setSession(chatId, opencodeSessionId)
        session = sessionManager.getSession(chatId)
      }

      sessionManager.updateActivity(chatId)

      let fullResponse = ''
      try {
        for await (const chunk of opencodeClient.streamMessage(session!.opencodeSessionId, text, model)) {
          fullResponse += chunk
        }
      } catch (streamError) {
        if (fullResponse.length > 0) {
          console.warn(`[Bot] Stream interrupted after ${fullResponse.length} chars, using partial response`)
        } else {
          console.error('[Bot] Streaming failed, falling back to sync:', streamError)
          try {
            fullResponse = await opencodeClient.sendMessage(session!.opencodeSessionId, text, model)
          } catch (syncError) {
            console.error('[Bot] Sync fallback also failed:', syncError)
            throw syncError
          }
        }
      }

      // Simulate streaming by feeding text in chunks for typewriter effect
      if (fullResponse.length > 0) {
        await this.simulateStreaming(controller, fullResponse)
      }

      await controller.complete(fullResponse)
      console.log(`[Bot] Response sent: ${fullResponse.length} chars`)

    } catch (error) {
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
