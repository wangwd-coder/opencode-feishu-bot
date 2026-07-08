import * as Lark from '@larksuiteoapi/node-sdk'
import { appConfig } from './config.js'
import { opencodeClient, getLastTokenStats } from './opencode.js'
import { sessionManager } from './session.js'
import { StreamingCardController } from './streaming.js'
import { parseCommand, handleCommand, handleCardAction, getModelForChat, getAgentForChat, buildSessionExpiryCard, buildCdPanelCard, buildCdBrowserCard, shortenPath, getChatState, setWorkingDir, getWorkingDir, deleteChatState } from './commands.js'
import { interactionHandler } from './interaction-handler.js'
import { ConversationService } from './conversation-service.js'

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
    option?: string  // select_static selected value
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
      text?: { tag: string; content: string }
      type?: string
      value?: { action: string }
      placeholder?: { tag: string; content: string }
      options?: Array<{ text: { tag: string; content: string }; value: string }>
    }>
  }>
}

export class FeishuBot {
  private client: Lark.Client
  private wsClient: Lark.WSClient
  private botName: string = 'OpenCode Bot'
  private conv: ConversationService = new ConversationService()
  // Track pending custom question inputs: chatId -> requestId
  private pendingCustomInput: Map<string, string> = new Map()
  // Periodic health check of OpenCode server
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private opencodeHealthy: boolean = true  // assume healthy until proven otherwise

  constructor() {
    const baseConfig = {
      appId: appConfig.feishu.app_id,
      appSecret: appConfig.feishu.app_secret,
      domain: appConfig.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    }

    this.client = new Lark.Client(baseConfig)
    this.wsClient = new Lark.WSClient(baseConfig)

    // Set up session expiry warning callback
    sessionManager.setExpiryWarningCallback(async (chatId: string, remainingSeconds: number) => {
      try {
        const cardData = buildSessionExpiryCard(remainingSeconds)
        await this.sendCardResult(chatId, cardData)
      } catch (error) {
        console.error('[Bot] Failed to send session expiry warning:', error)
      }
    })

    // Set up chat state cleanup callback to break circular dependency
    sessionManager.setChatStateCleanupCallback(deleteChatState)
  }

  async start(): Promise<void> {
    console.log('[Bot] Starting Feishu bot...')

    // Check OpenCode health with retry — do NOT exit on failure
    // The bot can start without OpenCode and will retry when messages arrive
    let isHealthy = await opencodeClient.healthCheck()
    if (!isHealthy) {
      console.error(`[Bot] WARNING: OpenCode server is not reachable at ${appConfig.opencode.server_url}`)
      console.error(`[Bot] Bot will start and retry connecting. Make sure OpenCode is running: opencode serve --port 4096`)

      // Retry a few times with backoff before giving up on initial health check
      for (let i = 1; i <= 5; i++) {
        const delay = Math.min(i * 2000, 10000)
        console.log(`[Bot] Retrying health check in ${delay}ms (attempt ${i}/5)...`)
        await new Promise(r => setTimeout(r, delay))
        isHealthy = await opencodeClient.healthCheck()
        if (isHealthy) break
      }
    }
    if (isHealthy) {
      console.log('[Bot] OpenCode server is healthy')
    } else {
      console.warn('[Bot] OpenCode server is still unreachable after retries. Bot will start but won\'t process messages until OpenCode is ready.')
    }
    this.opencodeHealthy = isHealthy

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

    // Start periodic OpenCode health check (every 30s)
    this.healthCheckInterval = setInterval(async () => {
      const healthy = await opencodeClient.healthCheck()
      if (healthy !== this.opencodeHealthy) {
        if (healthy) {
          console.log('[Bot] ✅ OpenCode server is back! Resuming normal operation.')
        } else {
          console.error(`[Bot] ❌ OpenCode server is DOWN at ${appConfig.opencode.server_url}`)
          console.error('[Bot] Messages will fail until OpenCode recovers.')
        }
        this.opencodeHealthy = healthy
      }
    }, 30_000)

    console.log('[Bot] WebSocket connected, listening for messages...')
    console.log('[Bot] Send a message to your bot in Feishu to start chatting!')
  }

  private async handleMessage(data: MessageData): Promise<void> {
    const { message, sender } = data

    // Extract text early for content-based dedup
    let text: string
    try {
      const content = JSON.parse(message.content)
      text = content.text || ''
    } catch {
      text = message.content
    }

    // Dual dedup: message_id (primary) + content hash (safety net)
    // Feishu at-least-once delivery may re-send with a different message_id
    const msgId = message.message_id
    const isDupByMsgId = this.conv.isDuplicate(msgId)
    if (isDupByMsgId) {
      console.log(`[Bot] Duplicate message ignored (message_id): msgId=${msgId}`)
      return
    }
    // Content-based dedup with short TTL (3s) to catch same-content re-delivery
    // Feishu create_time can be millisecond timestamp string like "1720442800000"
    const createTimeMs = message.create_time
      ? (isNaN(Number(message.create_time)) ? Date.parse(message.create_time) : parseInt(message.create_time, 10))
      : Date.now()
    const contentKey = `${message.chat_id}:${text}:${createTimeMs}`
    if (this.conv.isDuplicateContent(contentKey, 3000)) {
      console.log(`[Bot] Duplicate message ignored (content): msgId=${msgId}, text=${text.substring(0, 40)}`)
      return
    }

    if (sender.sender_type !== 'user') {
      return
    }

    // Rate limiting per user
    const userId = sender.sender_id.open_id
    if (this.conv.isRateLimited(userId)) {
      console.log(`[Bot] Rate limited user: ${userId}`)
      await this.sendTextMessage(message.chat_id, '⚠️ 消息过于频繁，请稍后再试。')
      return
    }

    if (message.message_type !== 'text') {
      await this.sendTextMessage(
        message.chat_id,
        'Currently only text messages are supported. Please send text.'
      )
      return
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

    console.log(`[Bot] Received message from ${sender.sender_id.open_id}: ${text.substring(0, 50)}... (msgId=${msgId})`)
    console.log(`[Bot] === PROCESSING MESSAGE (PID: ${process.pid}) ===`)

    // Add "received" reaction to user's message
    this.client.im.messageReaction.create({
      data: {
        reaction_type: { emoji_type: 'Get' }
      },
      path: { message_id: message.message_id }
    }).catch((err) => {
      console.warn('[Bot] Failed to add reaction:', err.message)
    })

    // Check if it's a command — must come BEFORE custom answer check
    // so slash commands like /help, /model are not swallowed as question answers
    const { isCommand, command, args } = parseCommand(text)
    
    if (isCommand) {
      // Clear any pending custom input so commands aren't treated as answers
      this.pendingCustomInput.delete(message.chat_id)
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

    // Check if this message is a custom question answer (only non-commands reach here)
    const pendingQuestionId = this.pendingCustomInput.get(message.chat_id)
    if (pendingQuestionId) {
      this.pendingCustomInput.delete(message.chat_id)
      console.log(`[Bot] Custom question answer: ${pendingQuestionId} -> ${text.substring(0, 50)}`)
      try {
        const updateData = await interactionHandler.handleQuestionReply(pendingQuestionId, [[text]])
        const cardMsgId = interactionHandler.getCardMessageId(pendingQuestionId)
        if (cardMsgId) {
          await this.updateCardResult(cardMsgId, updateData as {
            title: string; template: 'blue' | 'green' | 'orange' | 'red' | 'grey'; content: string
          })
          setTimeout(async () => {
            try { await this.client.im.message.delete({ path: { message_id: cardMsgId } }) } catch (err) { console.warn('[Bot] Failed to delete card:', (err as Error).message) }
          }, 2000)
        }
      } catch (err) {
        console.error('[Bot] Custom question reply failed:', err)
        await this.sendTextMessage(message.chat_id, '❌ 回答提交失败，请重试')
      }
      return
    }

    // Regular message - process with OpenCode (serialized per chat)
    // Quick check: if OpenCode is known to be down, fail fast with a clear message
    if (!this.opencodeHealthy) {
      await this.sendTextMessage(message.chat_id, '⚠️ OpenCode 服务不可用，请稍后重试或联系管理员。')
      console.warn('[Bot] OpenCode is unhealthy, rejecting message from', sender.sender_id.open_id)
      return
    }
    await this.withChatLock(message.chat_id, () =>
      this.processMessage(message.chat_id, text, sender.sender_id.open_id)
    )
  }

  /** Serialize message processing per chatId using ConversationService */
  private async withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
    return this.conv.withChatLock(chatId, fn)
  }

  /** Abort any in-flight request for this chat (called by /clear, /stop) */
  abortChat(chatId: string): void {
    this.conv.abort(chatId)
    // Mark as idle so new sessions start with clean state
    sessionManager.markIdle(chatId)
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

      // Special case: cd panel — show recent directories from sessions
      if (panelAction === 'cd') {
        const cardData = await buildCdPanelCard()
        if (cardData) {
          await this.sendCardResult(chatId, cardData)
        }
        return
      }

      const commandMap: Record<string, { command: string; args: string[] }> = {
        panel: { command: 'panel', args: [] },
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

    // Handle cd_browse: navigate directory browser (click into subdir or ../)
    if (action.startsWith('cd_browse:')) {
      const raw = action.slice('cd_browse:'.length)
      const pipeIdx = raw.lastIndexOf('|')
      let targetDir: string
      let page = 0
      if (pipeIdx > 0 && /^\d+$/.test(raw.slice(pipeIdx + 1))) {
        targetDir = raw.slice(0, pipeIdx)
        page = parseInt(raw.slice(pipeIdx + 1), 10)
      } else {
        targetDir = raw
      }
      console.log(`[Bot] cd_browse: navigating to ${targetDir} page=${page}`)
      try {
        const card = await buildCdBrowserCard(targetDir, page)
        if (card) {
          await this.sendCardResult(chatId, card)
        } else {
          await this.sendCardResult(chatId, {
            title: '❌ 无法访问',
            template: 'red',
            content: `目录 \`${shortenPath(targetDir)}\` 不存在或无权限访问`,
          })
        }
      } catch (err) {
        await this.sendCardResult(chatId, {
          title: '❌ 浏览失败',
          template: 'red',
          content: err instanceof Error ? err.message : '未知错误',
        })
      }
      return
    }

    // Handle cd_select: switch to selected directory
    if (action.startsWith('cd_select:')) {
      const targetDir = action.slice('cd_select:'.length)
      try {
        const cdSessionId = await opencodeClient.createSession(`IM: ${chatId.substring(0, 8)}`, targetDir)
        sessionManager.setSession(chatId, cdSessionId)
        const state = getChatState(chatId)
        state.model = null
        state.agent = null
        setWorkingDir(chatId, targetDir)
        const shortDir = targetDir.replace(/^\/Users\/(\w+)/, '~')
        await this.sendCardResult(chatId, {
          title: '✅ 工作目录已切换',
          template: 'green',
          content: `**目录:** \`${shortDir}\`\n**会话:** \`${cdSessionId.slice(0, 20)}...\`\n\n💬 现在发送消息即可开始新对话`,
        })
      } catch (err) {
        await this.sendCardResult(chatId, {
          title: '❌ 切换失败',
          template: 'red',
          content: `无法切换到 \`${targetDir}\`\n\n${err instanceof Error ? err.message : '请检查路径是否正确'}`,
        })
      }
      return
    }

    // Handle cd_custom: prompt user to type a path
    if (action === 'cd_custom') {
      await this.sendTextMessage(chatId, '📁 请直接输入工作目录路径（如 `/Users/me/project`）：')
      return
    }

    // Handle custom question input request
    if (action.startsWith('question_custom:')) {
      const requestId = action.split(':').slice(1).join(':')
      this.pendingCustomInput.set(chatId, requestId)
      await this.sendTextMessage(chatId, '💬 请直接输入你的回答：')
      console.log(`[Bot] Custom question input mode for ${requestId}`)
      return
    }

    // Handle select_static dropdown selection for question (6+ options)
    if (action.startsWith('question_select:')) {
      const requestId = action.split(':').slice(1).join(':')
      const selectedValue = data.action.option
      if (selectedValue) {
        console.log(`[Bot] question_select: ${requestId} -> ${selectedValue}`)
        // selectedValue is "question_answer:{requestId}:{label}" — delegate to handleCardAction
        const result = handleCardAction(selectedValue, chatId)
        if (result?.cardData && !result.pendingAction) {
          await this.sendCardResult(chatId, result.cardData)
        }
        if (result?.pendingAction) {
          const cardMsgId = interactionHandler.getCardMessageId(result.pendingAction.requestId)
          if (cardMsgId) {
            await this.updateCardResult(cardMsgId, {
              title: '⏳ 处理中...',
              template: 'blue',
              content: `正在提交回答...`,
            })
          }
          try {
            const updateData = await interactionHandler.handleQuestionReply(
              result.pendingAction.requestId,
              result.pendingAction.answers || []
            )
            if (cardMsgId) {
              await this.updateCardResult(cardMsgId, updateData as {
                title: string; template: 'blue' | 'green' | 'orange' | 'red' | 'grey'; content: string
              })
              setTimeout(async () => {
                try { await this.client.im.message.delete({ path: { message_id: cardMsgId } }) } catch (err) { console.warn('[Bot] Failed to delete card:', (err as Error).message) }
              }, 2000)
            }
          } catch (err) {
            console.error('[Bot] question_select reply failed:', err)
            if (cardMsgId) {
              await this.updateCardResult(cardMsgId, {
                title: '❌ 操作失败',
                template: 'red',
                content: '请稍后重试',
              })
            }
          }
        }
      } else {
        console.warn('[Bot] question_select: no option value in callback')
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
      const cardMsgId = interactionHandler.getCardMessageId(requestId)
      console.log(`[Bot] Handling ${result.pendingAction.type}: requestId=${requestId}, cardMsgId=${cardMsgId || 'none'}`)

      // Optimistic UI: immediately update card to show processing
      if (cardMsgId) {
        await this.updateCardResult(cardMsgId, {
          title: '⏳ 处理中...',
          template: 'blue',
          content: result.pendingAction.type === 'permission_reply'
            ? `正在${result.pendingAction.reply === 'reject' ? '拒绝' : '授权'}...`
            : `正在提交回答...`,
        })
      }

      try {
        let updateData: { title: string; template: string; content: string }
        if (result.pendingAction.type === 'permission_reply') {
          updateData = await interactionHandler.handlePermissionReply(
            requestId,
            result.pendingAction.reply as 'once' | 'always' | 'reject'
          )
        } else {
          updateData = await interactionHandler.handleQuestionReply(
            requestId,
            result.pendingAction.answers || []
          )
        }
        // Update card to show final result
        if (cardMsgId) {
          console.log(`[Bot] Updating card ${cardMsgId} -> ${updateData.title}`)
          await this.updateCardResult(cardMsgId, updateData as {
            title: string
            template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
            content: string
          })
          // Delete the card after 2s to keep chat clean
          setTimeout(async () => {
            try { await this.client.im.message.delete({ path: { message_id: cardMsgId } }) } catch (err) { console.warn('[Bot] Failed to delete card:', (err as Error).message) }
          }, 2000)
        }
      } catch (err) {
        console.error(`[Bot] ${result.pendingAction.type} failed:`, err)
        // Show error on the card
        if (cardMsgId) {
          await this.updateCardResult(cardMsgId, {
            title: '❌ 操作失败',
            template: 'red',
            content: '请稍后重试',
          })
        }
      }
    }

    if (!result) {
      console.warn(`[Bot] Unknown card action: ${action}`)
    }
  }

  private async sendCardResult(chatId: string, cardData: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
    buttons?: Array<{ text: string; value: string }>
    actions?: Array<{ tag: string; placeholder?: string; value: string; options?: Array<{ text: string; value: string }> }>
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
    
    // Add select_static actions if provided (for 6+ options dropdown)
    if (cardData.actions?.length) {
      for (const act of cardData.actions) {
        if (act.tag === 'select_static') {
          card.elements.push({
            tag: 'action',
            actions: [{
              tag: 'select_static',
              placeholder: { tag: 'plain_text', content: act.placeholder || '请选择...' },
              value: { action: act.value },
              options: act.options?.map(o => ({
                text: { tag: 'plain_text', content: o.text },
                value: o.value,
              })),
            }],
          })
        }
      }
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
    const msgId = res.data?.message_id || undefined
    console.log(`[Bot] Card sent: "${cardData.title}" -> ${msgId || 'FAILED'} (${cardData.content.length} chars, ${cardData.buttons?.length || 0} buttons)`)
    return msgId
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
    const controller = new StreamingCardController(this.client)
    const model = getModelForChat(chatId)
    const agent = getAgentForChat(chatId)
    let progressInterval: ReturnType<typeof setInterval> | undefined
    let completed = false // Prevent progress poll from updating after complete

    // Register abort controller for this chat so /clear and /stop can cancel
    const chatAbort = new AbortController()
    this.conv.registerAbort(chatId, chatAbort)

    // Mark this chat as active (prevent session expiry during task execution)
    sessionManager.markActive(chatId)

    try {
      await controller.init(chatId)

      // Check if already aborted (e.g. user sent /clear before init finished)
      if (chatAbort.signal.aborted) {
        throw new Error('已取消')
      }

      let session = sessionManager.getSession(chatId)
      if (!session) {
        const opencodeSessionId = await opencodeClient.createSession(`Feishu Chat: ${chatId.substring(0, 8)}`)
        sessionManager.setSession(chatId, opencodeSessionId)
        session = sessionManager.getSession(chatId)
      }

      // Start progress polling — updates the card every 8s during long tasks
      const startTime = Date.now()
      let lastStatusKey = ''
      progressInterval = setInterval(async () => {
        if (chatAbort.signal.aborted || completed) {
          clearInterval(progressInterval)
          return
        }
        try {
          const elapsed = Math.floor((Date.now() - startTime) / 1000)
          const progress = await opencodeClient.getSessionProgress(session!.opencodeSessionId)
          if (!progress || completed) return

          // Build status key (without elapsed time) to detect actual changes
          const statusKey = `${progress.status}|${progress.toolName || ''}|${progress.toolSummary || ''}`

          let statusText = `⏳ 正在处理中... (${elapsed}秒)`
          if (progress.status === 'running' && progress.toolName) {
            const toolDesc = progress.toolInput
              ? Object.values(progress.toolInput)
                  .filter(v => typeof v === 'string' || typeof v === 'number')
                  .map(v => String(v).substring(0, 50))
                  .join(', ')
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
          if (!completed && (statusKey !== lastStatusKey || elapsed % 30 < 8)) {
            if (statusKey !== lastStatusKey) {
              console.log(`[Bot] Progress poll: ${progress.status} -> updating card`)
            }
            lastStatusKey = statusKey
            await controller.updateStatus(statusText)
          }

          // Check permissions/questions only when tools are active (not idle/waiting)
          if (!completed && (progress.status === 'running' || progress.status === 'pending' || progress.status === 'thinking')) {
            const pending = await interactionHandler.checkPending(session!.opencodeSessionId, 'feishu')
            for (const item of pending) {
              if (item.type === 'permission') {
                await controller.updateStatus(`🔐 需要权限确认: ${item.cardData.content}\n请查看下方卡片操作...`)
              } else {
                await controller.updateStatus(`❓ 需要回答问题\n请查看下方卡片操作...`)
              }
              const msgId = await this.sendCardResult(chatId, item.cardData)
              if (msgId) interactionHandler.recordCardSent(item.requestId, msgId)
              console.log(`[Bot] ${item.type} request sent: ${item.requestId}`)
            }
          }
        } catch (pollError) {
          console.warn('[Bot] Progress poll error:', pollError)
        }
      }, 5_000)

      let fullResponse = ''
      try {
        // Inject working directory context so OpenCode knows where to operate
        const workingDir = getWorkingDir(chatId)
        const contextText = workingDir ? `<working_directory>\n${workingDir}\n</working_directory>\n\n` : ''
        const messageText = contextText + text
        for await (const chunk of opencodeClient.streamMessage(session!.opencodeSessionId, messageText, model, agent, undefined, chatAbort.signal)) {
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
      this.conv.deregisterAbort(chatId)
      await controller.complete(fullResponse + footer)
      console.log(`[Bot] Response sent: ${fullResponse.length} chars`)

    } catch (error) {
      clearInterval(progressInterval)
      completed = true
      this.conv.deregisterAbort(chatId)
      console.error('[Bot] Error processing message:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await controller.error(`Failed to process message: ${errorMessage}`)
    } finally {
      // Mark chat as idle and update activity (reset session timer)
      sessionManager.markIdle(chatId)
      sessionManager.updateActivity(chatId)
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
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    this.conv.stop()
    sessionManager.stop()
    console.log('[Bot] Stopped')
  }
}
