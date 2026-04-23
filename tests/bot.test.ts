import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock all dependencies before importing the module
vi.mock('../src/config.js', () => ({
  appConfig: {
    feishu: { app_id: 'test-app-id', app_secret: 'test-secret', domain: 'feishu' },
    opencode: { server_url: 'http://localhost:4096', username: 'opencode', password: '' },
    streaming: { update_interval: 500, min_chunk_size: 100 },
    session: { ttl: 3600, max_sessions: 100 },
  },
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  const mockClientInstance = {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({}),
        patch: vi.fn().mockResolvedValue({}),
      },
      messageReaction: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
    request: vi.fn().mockResolvedValue({}),
  }
  
  const MockClient = vi.fn(function() {
    return mockClientInstance
  }) as ReturnType<typeof vi.fn> & { mockInstance: typeof mockClientInstance }
  MockClient.mockInstance = mockClientInstance
  
  const MockWSClient = vi.fn(function() {
    return { start: vi.fn() }
  })
  
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    EventDispatcher: vi.fn(function() {
      return { register: vi.fn().mockReturnThis() }
    }),
  }
})

vi.mock('../src/opencode.js', () => ({
  opencodeClient: {
    healthCheck: vi.fn(async () => true),
    createSession: vi.fn(async () => 'test-session-id'),
    streamMessage: vi.fn(async function* () {
      yield 'Test response'
    }),
    sendMessage: vi.fn(async () => 'Test response'),
    getSessionProgress: vi.fn(async () => ({ status: 'idle' })),
  },
  getLastTokenStats: vi.fn(() => null),
}))

vi.mock('../src/session.js', () => ({
  sessionManager: {
    getSession: vi.fn(() => ({
      opencodeSessionId: 'test-session-id',
      chatId: 'test-chat-id',
      lastActivity: Date.now(),
    })),
    setSession: vi.fn(),
    updateActivity: vi.fn(),
    stop: vi.fn(),
  },
}))

vi.mock('../src/streaming.js', () => {
  const mockStreamingInstance = {
    init: vi.fn(async () => 'test-msg-id'),
    appendText: vi.fn(),
    updateStatus: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
  }
  
  const MockStreamingCardController = vi.fn(function() {
    return mockStreamingInstance
  })
  
  return {
    StreamingCardController: MockStreamingCardController,
  }
})

vi.mock('../src/commands.js', () => ({
  parseCommand: vi.fn(() => ({ isCommand: false, command: '', args: [] })),
  handleCommand: vi.fn(async () => ({ cardData: null })),
  handleCardAction: vi.fn(() => ({ cardData: null })),
  getModelForChat: vi.fn(() => null),
  getAgentForChat: vi.fn(() => null),
}))

// Import after mocks are set up
import { FeishuBot } from '../src/bot.js'

// Helper to create message data
function createMessageData(overrides: Partial<{
  message_id: string
  chat_id: string
  open_id: string
  content: string
  chat_type: 'p2p' | 'group'
  sender_type: string
}> = {}): {
  sender: {
    sender_id: { open_id: string; union_id?: string; user_id?: string }
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
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>
  }
} {
  return {
    sender: {
      sender_id: { open_id: overrides.open_id || 'user-1' },
      sender_type: overrides.sender_type || 'user',
      tenant_key: 'tenant-1',
    },
    message: {
      message_id: overrides.message_id || 'msg-1',
      chat_id: overrides.chat_id || 'chat-1',
      chat_type: overrides.chat_type || 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: overrides.content || 'Hello' }),
      create_time: new Date().toISOString(),
    },
  }
}

describe('FeishuBot', () => {
  let bot: FeishuBot

  beforeEach(() => {
    vi.clearAllMocks()
    bot = new FeishuBot()
  })

  afterEach(() => {
    if (bot) {
      bot.stop()
    }
  })

  describe('processedMessages dedup', () => {
    it('ignores duplicate message_id on second call', async () => {
      const data = createMessageData({ message_id: 'dup-msg-1' })
      
      // Access private handleMessage via reflection
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      // First call should process
      await handleMessage(data)
      
      // Second call with same message_id should be ignored
      await handleMessage(data)
      
      // Verify opencodeClient.streamMessage was called only once
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(1)
    })

    it('processes different message_ids', async () => {
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      // First message
      await handleMessage(createMessageData({ message_id: 'msg-a' }))
      
      // Second message with different ID
      await handleMessage(createMessageData({ message_id: 'msg-b' }))
      
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(2)
    })

    it('TTL cleanup removes old entries after timeout', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      const processedMessages = (bot as unknown as { processedMessages: Set<string> }).processedMessages
      
      await handleMessage(createMessageData({ message_id: 'ttl-msg-1' }))
      
      // Message should be in the set
      expect(processedMessages.has('ttl-msg-1')).toBe(true)
      
      // Advance time past TTL (60 seconds)
      vi.advanceTimersByTime(61_000)
      
      // Message should be removed by TTL cleanup
      expect(processedMessages.has('ttl-msg-1')).toBe(false)
      
      vi.useRealTimers()
    })

    it('size cap eviction removes oldest 5000 entries when >10000', async () => {
      const processedMessages = (bot as unknown as { processedMessages: Set<string> }).processedMessages
      
      // Add 10001 entries to trigger eviction
      for (let i = 0; i < 10001; i++) {
        processedMessages.add(`msg-${i.toString().padStart(5, '0')}`)
      }
      
      expect(processedMessages.size).toBe(10001)
      
      // Call handleMessage to trigger eviction check
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      await handleMessage(createMessageData({ message_id: 'trigger-eviction' }))
      
      // After eviction, size should be around 5001 (10001 - 5000 + 1 new)
      expect(processedMessages.size).toBeLessThanOrEqual(5002)
      
      // First 5000 entries should be removed (oldest)
      for (let i = 0; i < 5000; i++) {
        expect(processedMessages.has(`msg-${i.toString().padStart(5, '0')}`)).toBe(false)
      }
      
      // Later entries should still exist
      expect(processedMessages.has('msg-05000')).toBe(true)
    })
  })

  describe('rate limiting', () => {
    it('allows first message from user', async () => {
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      await handleMessage(createMessageData({ open_id: 'new-user' }))
      
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(1)
    })

    it('allows messages within limit (up to 20 per minute)', async () => {
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      // Send 20 messages (the limit)
      for (let i = 0; i < 20; i++) {
        await handleMessage(createMessageData({ 
          open_id: 'rate-user', 
          message_id: `rate-msg-${i}` 
        }))
      }
      
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(20)
    })

    it('blocks messages exceeding limit', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      // Send 20 messages (the limit)
      for (let i = 0; i < 20; i++) {
        await handleMessage(createMessageData({ 
          open_id: 'limited-user', 
          message_id: `limit-msg-${i}` 
        }))
      }
      
      // 21st message should be rate limited
      await handleMessage(createMessageData({ 
        open_id: 'limited-user', 
        message_id: 'limit-msg-20' 
      }))
      
      const { opencodeClient } = await import('../src/opencode.js')
      const lark = await import('@larksuiteoapi/node-sdk')
      const mockInstance = (lark.Client as unknown as { mockInstance: { im: { message: { create: ReturnType<typeof vi.fn> } } } }).mockInstance
      
      // streamMessage should still be 20 (21st was blocked)
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(20)
      
      // Rate limit message should be sent
      expect(mockInstance.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'text',
          }),
        })
      )
      
      vi.useRealTimers()
    })

    it('resets count after window expires', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      // Send 20 messages to reach limit
      for (let i = 0; i < 20; i++) {
        await handleMessage(createMessageData({ 
          open_id: 'window-user', 
          message_id: `window-msg-${i}` 
        }))
      }
      
      // Advance time past rate window (60 seconds)
      vi.advanceTimersByTime(61_000)
      
      // Next message should be allowed (new window)
      await handleMessage(createMessageData({ 
        open_id: 'window-user', 
        message_id: 'window-msg-20' 
      }))
      
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(21)
      
      vi.useRealTimers()
    })
  })

  describe('withChatLock mutex', () => {
    it('single message processes immediately', async () => {
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      
      await handleMessage(createMessageData({ chat_id: 'mutex-chat-1' }))
      
      const { opencodeClient } = await import('../src/opencode.js')
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(1)
    })

    it('multiple messages queue up and process sequentially', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      const { opencodeClient } = await import('../src/opencode.js')
      
      // Make streamMessage take some time
      let streamCallCount = 0
      ;(opencodeClient.streamMessage as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        streamCallCount++
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 100))
        yield `Response ${streamCallCount}`
      })
      
      // Start multiple messages for the same chat
      const promises = [
        handleMessage(createMessageData({ chat_id: 'mutex-chat-2', message_id: 'seq-1' })),
        handleMessage(createMessageData({ chat_id: 'mutex-chat-2', message_id: 'seq-2' })),
        handleMessage(createMessageData({ chat_id: 'mutex-chat-2', message_id: 'seq-3' })),
      ]
      
      // Let all timers run
      await vi.runAllTimersAsync()
      
      await Promise.all(promises)
      
      // All messages should be processed (sequentially)
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(3)
      
      vi.useRealTimers()
    })

    it('error in one message does not block others', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      const { opencodeClient } = await import('../src/opencode.js')
      
      let callCount = 0
      ;(opencodeClient.streamMessage as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        callCount++
        if (callCount === 1) {
          throw new Error('Simulated error')
        }
        yield 'Success response'
      })
      
      const promises = [
        handleMessage(createMessageData({ chat_id: 'error-chat', message_id: 'error-1' })).catch(() => {}),
        handleMessage(createMessageData({ chat_id: 'error-chat', message_id: 'error-2' })),
      ]
      
      await vi.runAllTimersAsync()
      await Promise.all(promises)
      
      // Both messages should have been attempted
      expect(opencodeClient.streamMessage).toHaveBeenCalledTimes(2)
      
      vi.useRealTimers()
    })

    it('queue is cleaned up after processing', async () => {
      vi.useFakeTimers()
      
      const handleMessage = (bot as unknown as { handleMessage: (data: unknown) => Promise<void> }).handleMessage.bind(bot)
      const chatQueues = (bot as unknown as { chatQueues: Map<string, Array<() => void>> }).chatQueues
      const chatProcessing = (bot as unknown as { chatProcessing: Set<string> }).chatProcessing
      
      // Process a message
      const promise = handleMessage(createMessageData({ chat_id: 'cleanup-chat', message_id: 'cleanup-1' }))
      
      await vi.runAllTimersAsync()
      await promise
      
      // Queue should be empty after processing
      expect(chatQueues.has('cleanup-chat')).toBe(false)
      expect(chatProcessing.has('cleanup-chat')).toBe(false)
      
      vi.useRealTimers()
    })
  })

  describe('abortChat', () => {
    it('calls abort on registered AbortController', async () => {
      const chatAbortControllers = (bot as unknown as { chatAbortControllers: Map<string, AbortController> }).chatAbortControllers
      
      // Register an AbortController
      const controller = new AbortController()
      chatAbortControllers.set('abort-chat-1', controller)
      
      // Spy on abort
      const abortSpy = vi.spyOn(controller, 'abort')
      
      // Call abortChat
      bot.abortChat('abort-chat-1')
      
      expect(abortSpy).toHaveBeenCalled()
    })

    it('removes controller from map after abort', async () => {
      const chatAbortControllers = (bot as unknown as { chatAbortControllers: Map<string, AbortController> }).chatAbortControllers
      
      // Register an AbortController
      const controller = new AbortController()
      chatAbortControllers.set('abort-chat-2', controller)
      
      expect(chatAbortControllers.has('abort-chat-2')).toBe(true)
      
      // Call abortChat
      bot.abortChat('abort-chat-2')
      
      // Controller should be removed
      expect(chatAbortControllers.has('abort-chat-2')).toBe(false)
    })

    it('does nothing if no controller exists', async () => {
      // Should not throw
      expect(() => bot.abortChat('non-existent-chat')).not.toThrow()
    })

    it('signals aborted state correctly', async () => {
      const chatAbortControllers = (bot as unknown as { chatAbortControllers: Map<string, AbortController> }).chatAbortControllers
      
      const controller = new AbortController()
      chatAbortControllers.set('abort-chat-3', controller)
      
      expect(controller.signal.aborted).toBe(false)
      
      bot.abortChat('abort-chat-3')
      
      expect(controller.signal.aborted).toBe(true)
    })
  })

  describe('stop', () => {
    it('clears all internal state', async () => {
      const processedMessages = (bot as unknown as { processedMessages: Set<string> }).processedMessages
      const userMessageCounts = (bot as unknown as { userMessageCounts: Map<string, { count: number; resetAt: number }> }).userMessageCounts
      
      // Add some state
      processedMessages.add('stop-msg-1')
      userMessageCounts.set('stop-user', { count: 5, resetAt: Date.now() + 60000 })
      
      // Stop the bot
      bot.stop()
      
      // State should be cleared
      expect(processedMessages.size).toBe(0)
      expect(userMessageCounts.size).toBe(0)
    })
  })
})
