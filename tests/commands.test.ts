import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseCommand,
  handleCommand,
  handleCardAction,
  getChatState,
  setModel,
  deleteChatState,
  getModelForChat,
  getAgentForChat,
} from '../src/commands.js'

// Mock opencodeClient
const mockGetModelList = vi.fn(() => [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'deepseek-v3', name: 'DeepSeek V3' },
  { id: 'gpt-4', name: 'GPT-4' },
  { id: 'claude-3', name: 'Claude 3' },
])

const mockGetAgents = vi.fn(async () => [
  { name: 'orchestrator', mode: 'primary' },
  { name: 'plan', mode: 'primary' },
  { name: 'internal', mode: 'internal' },
])

const mockCreateSession = vi.fn(async () => 'new-session-id-12345')
const mockAbortSession = vi.fn(async () => {})
const mockRenameSession = vi.fn(async () => {})
const mockSummarizeSession = vi.fn(async () => {})
const mockListSessions = vi.fn(async () => [
  { id: 'session-1', title: 'Test Session', slug: 'test-session', time: { updated: Date.now() - 60000 } },
  { id: 'session-2', title: 'Another Session', slug: 'another-session', time: { updated: Date.now() - 3600000 } },
])

vi.mock('../src/opencode.js', () => ({
  opencodeClient: {
    getModelList: () => mockGetModelList(),
    getAgents: (providerID: string, modelID: string) => mockGetAgents(providerID, modelID),
    createSession: (name: string) => mockCreateSession(name),
    abortSession: (sessionId: string) => mockAbortSession(sessionId),
    renameSession: (sessionId: string, name: string) => mockRenameSession(sessionId, name),
    summarizeSession: (sessionId: string, providerID: string, modelID: string) => mockSummarizeSession(sessionId, providerID, modelID),
    listSessions: () => mockListSessions(),
  },
}))

// Mock sessionManager
const mockGetSession = vi.fn(() => null)
const mockSetSession = vi.fn()
const mockUpdateActivity = vi.fn()

vi.mock('../src/session.js', () => ({
  sessionManager: {
    getSession: (chatId: string) => mockGetSession(chatId),
    setSession: (chatId: string, sessionId: string) => mockSetSession(chatId, sessionId),
    updateActivity: (chatId: string) => mockUpdateActivity(chatId),
  },
}))

describe('parseCommand', () => {
  it('returns isCommand: false for non-command text (no leading /)', () => {
    const result = parseCommand('hello world')
    expect(result).toEqual({ isCommand: false, command: '', args: [] })
  })

  it('returns isCommand: false for empty string', () => {
    const result = parseCommand('')
    expect(result).toEqual({ isCommand: false, command: '', args: [] })
  })

  it('returns isCommand: false for whitespace only', () => {
    const result = parseCommand('   ')
    expect(result).toEqual({ isCommand: false, command: '', args: [] })
  })

  it('parses /help correctly', () => {
    const result = parseCommand('/help')
    expect(result).toEqual({ isCommand: true, command: 'help', args: [] })
  })

  it('parses /model deepseek with args', () => {
    const result = parseCommand('/model deepseek')
    expect(result).toEqual({ isCommand: true, command: 'model', args: ['deepseek'] })
  })

  it('parses /session new with multiple args', () => {
    const result = parseCommand('/session new extra')
    expect(result).toEqual({ isCommand: true, command: 'session', args: ['new', 'extra'] })
  })

  it('handles trimming and multiple spaces like /model  deepseek  v3', () => {
    const result = parseCommand('/model  deepseek  v3')
    expect(result).toEqual({ isCommand: true, command: 'model', args: ['deepseek', 'v3'] })
  })

  it('handles leading and trailing whitespace', () => {
    const result = parseCommand('   /help   ')
    expect(result).toEqual({ isCommand: true, command: 'help', args: [] })
  })

  it('converts command to lowercase', () => {
    const result = parseCommand('/HELP')
    expect(result).toEqual({ isCommand: true, command: 'help', args: [] })
  })

  it('handles command with single character', () => {
    const result = parseCommand('/a')
    expect(result).toEqual({ isCommand: true, command: 'a', args: [] })
  })

  it('handles command with special characters in args', () => {
    const result = parseCommand('/rename my-session-name_v2')
    expect(result).toEqual({ isCommand: true, command: 'rename', args: ['my-session-name_v2'] })
  })
})

describe('handleCommand', () => {
  const chatId = 'test-chat-id'

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset chat state by deleting it
    deleteChatState(chatId)
    mockGetSession.mockReturnValue(null)
  })

  describe('/help', () => {
    it('returns correct cardData with help content', async () => {
      const result = await handleCommand(chatId, 'help', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('📖 帮助')
      expect(result.cardData?.template).toBe('blue')
      expect(result.cardData?.content).toContain('/help')
      expect(result.cardData?.content).toContain('/model')
      expect(result.cardData?.content).toContain('/status')
    })
  })

  describe('/status', () => {
    it('shows current state with default values', async () => {
      const result = await handleCommand(chatId, 'status', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('📊 状态')
      expect(result.cardData?.template).toBe('blue')
      expect(result.cardData?.content).toContain('**模型:** 默认')
      expect(result.cardData?.content).toContain('**角色:** 默认 (orchestrator)')
      expect(result.cardData?.content).toContain('**推理强度:** 高 🚀')
      expect(result.cardData?.content).toContain('**Session:** \`无\`')
    })

    it('shows current state with custom values', async () => {
      setModel(chatId, 'deepseek')
      const state = getChatState(chatId)
      state.agent = 'plan'
      state.effort = 'low'
      mockGetSession.mockReturnValue({ opencodeSessionId: 'existing-session-id' })

      const result = await handleCommand(chatId, 'status', [])
      expect(result.cardData?.content).toContain('**模型:** DeepSeek')
      expect(result.cardData?.content).toContain('**角色:** plan')
      expect(result.cardData?.content).toContain('**推理强度:** 低 🐢')
      expect(result.cardData?.content).toContain('existing-session-id')
    })
  })

  describe('/model', () => {
    it('shows current model when no args provided', async () => {
      const result = await handleCommand(chatId, 'model', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🤖 当前模型')
      expect(result.cardData?.content).toContain('**当前模型:** 默认')
    })

    it('shows custom model when set', async () => {
      setModel(chatId, 'deepseek')
      const result = await handleCommand(chatId, 'model', [])
      expect(result.cardData?.content).toContain('**当前模型:** DeepSeek')
    })

    it('switches model by exact id match', async () => {
      const result = await handleCommand(chatId, 'model', ['deepseek'])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('✅ 模型已切换')
      expect(result.cardData?.template).toBe('green')
      expect(result.cardData?.content).toContain('DeepSeek')
      expect(getChatState(chatId).model).toBe('deepseek')
    })

    it('switches model by exact name match', async () => {
      const result = await handleCommand(chatId, 'model', ['DeepSeek'])
      expect(result.cardData?.title).toBe('✅ 模型已切换')
      expect(getChatState(chatId).model).toBe('deepseek')
    })

    it('switches model by partial id match', async () => {
      const result = await handleCommand(chatId, 'model', ['deep'])
      expect(result.cardData?.title).toBe('✅ 模型已切换')
      expect(getChatState(chatId).model).toBe('deepseek')
    })

    it('switches model by partial name match', async () => {
      const result = await handleCommand(chatId, 'model', ['Claude'])
      expect(result.cardData?.title).toBe('✅ 模型已切换')
      expect(getChatState(chatId).model).toBe('claude-3')
    })

    it('switches model with multiple args joined', async () => {
      const result = await handleCommand(chatId, 'model', ['deepseek', 'v3'])
      expect(result.cardData?.title).toBe('✅ 模型已切换')
      expect(getChatState(chatId).model).toBe('deepseek-v3')
    })

    it('returns error when model not found', async () => {
      const result = await handleCommand(chatId, 'model', ['nonexistent'])
      expect(result.cardData?.title).toBe('❌ 未找到模型')
      expect(result.cardData?.template).toBe('red')
      expect(result.cardData?.content).toContain('nonexistent')
    })
  })

  describe('/models', () => {
    it('shows list of models with buttons', async () => {
      const result = await handleCommand(chatId, 'models', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🤖 可用模型')
      expect(result.cardData?.template).toBe('blue')
      expect(result.cardData?.content).toContain('deepseek')
      expect(result.cardData?.content).toContain('gpt-4')
      expect(result.cardData?.buttons).toBeDefined()
      expect(result.cardData?.buttons?.length).toBe(4)
    })

    it('marks current model with checkmark in buttons', async () => {
      setModel(chatId, 'deepseek')
      const result = await handleCommand(chatId, 'models', [])
      const currentButton = result.cardData?.buttons?.find(b => b.value === 'model_select:deepseek')
      expect(currentButton?.text).toContain('✅')
    })

    it('marks current model with arrow in content', async () => {
      setModel(chatId, 'gpt-4')
      const result = await handleCommand(chatId, 'models', [])
      expect(result.cardData?.content).toContain('👉 `gpt-4`')
    })
  })

  describe('/agent', () => {
    it('shows current agent when no args provided', async () => {
      const result = await handleCommand(chatId, 'agent', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🎭 当前角色')
      expect(result.cardData?.content).toContain('默认 (orchestrator)')
    })

    it('shows custom agent when set', async () => {
      const state = getChatState(chatId)
      state.agent = 'plan'
      const result = await handleCommand(chatId, 'agent', [])
      expect(result.cardData?.content).toContain('**当前角色:** plan')
    })

    it('switches agent by exact name match', async () => {
      const result = await handleCommand(chatId, 'agent', ['orchestrator'])
      expect(result.cardData?.title).toBe('✅ 角色已切换')
      expect(result.cardData?.template).toBe('green')
      expect(getChatState(chatId).agent).toBe('orchestrator')
    })

    it('switches agent by partial name match', async () => {
      const result = await handleCommand(chatId, 'agent', ['plan'])
      expect(result.cardData?.title).toBe('✅ 角色已切换')
      expect(getChatState(chatId).agent).toBe('plan')
    })

    it('returns error when agent not found', async () => {
      const result = await handleCommand(chatId, 'agent', ['nonexistent'])
      expect(result.cardData?.title).toBe('❌ 未找到角色')
      expect(result.cardData?.template).toBe('red')
    })

    it('handles getAgents error gracefully', async () => {
      mockGetAgents.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'agent', ['test'])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('获取角色列表失败')
    })

    it('only matches primary agents', async () => {
      const result = await handleCommand(chatId, 'agent', ['internal'])
      // 'internal' agent has mode: 'internal', not 'primary', so it should not match
      expect(result.cardData?.title).toBe('❌ 未找到角色')
    })
  })

  describe('/agents', () => {
    it('shows list of primary agents with buttons', async () => {
      const result = await handleCommand(chatId, 'agents', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🎭 可用角色')
      expect(result.cardData?.content).toContain('orchestrator')
      expect(result.cardData?.content).toContain('plan')
      // Should not contain internal agents
      expect(result.cardData?.content).not.toContain('internal')
      expect(result.cardData?.buttons).toBeDefined()
    })

    it('marks current agent with checkmark', async () => {
      const state = getChatState(chatId)
      state.agent = 'plan'
      const result = await handleCommand(chatId, 'agents', [])
      const currentButton = result.cardData?.buttons?.find(b => b.value === 'agent_select:plan')
      expect(currentButton?.text).toContain('✅')
      expect(result.cardData?.content).toContain('👉 `plan`')
    })

    it('handles getAgents error gracefully', async () => {
      mockGetAgents.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'agents', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('获取角色列表失败')
    })
  })

  describe('/effort', () => {
    it('shows current effort when no args provided', async () => {
      const result = await handleCommand(chatId, 'effort', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🧠 推理强度')
      expect(result.cardData?.content).toContain('高 🚀')
      expect(result.cardData?.buttons).toBeDefined()
      expect(result.cardData?.buttons?.length).toBe(3)
    })

    it('sets effort to low', async () => {
      const result = await handleCommand(chatId, 'effort', ['low'])
      expect(result.cardData?.title).toBe('✅ 推理强度已调整')
      expect(result.cardData?.template).toBe('green')
      expect(result.cardData?.content).toContain('低 🐢')
      expect(getChatState(chatId).effort).toBe('low')
    })

    it('sets effort to medium', async () => {
      const result = await handleCommand(chatId, 'effort', ['medium'])
      expect(result.cardData?.content).toContain('中 ⚡')
      expect(getChatState(chatId).effort).toBe('medium')
    })

    it('sets effort to high', async () => {
      // First set to something else
      const state = getChatState(chatId)
      state.effort = 'low'
      const result = await handleCommand(chatId, 'effort', ['high'])
      expect(result.cardData?.content).toContain('高 🚀')
      expect(getChatState(chatId).effort).toBe('high')
    })

    it('returns error for invalid effort level', async () => {
      const result = await handleCommand(chatId, 'effort', ['invalid'])
      expect(result.cardData?.title).toBe('❌ 无效档位')
      expect(result.cardData?.template).toBe('red')
      expect(result.cardData?.content).toContain('low')
      expect(result.cardData?.content).toContain('medium')
      expect(result.cardData?.content).toContain('high')
    })

    it('handles effort case-insensitively', async () => {
      const result = await handleCommand(chatId, 'effort', ['LOW'])
      expect(result.cardData?.title).toBe('✅ 推理强度已调整')
      expect(getChatState(chatId).effort).toBe('low')
    })
  })

  describe('/session', () => {
    it('shows session info when no args', async () => {
      mockGetSession.mockReturnValue(null)
      const result = await handleCommand(chatId, 'session', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('📝 Session')
      expect(result.cardData?.content).toContain('**Session:** 无')
    })

    it('shows existing session info', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'existing-session-123' })
      const result = await handleCommand(chatId, 'session', [])
      expect(result.cardData?.content).toContain('existing-session-123')
    })

    it('creates new session with "new" arg', async () => {
      const result = await handleCommand(chatId, 'session', ['new'])
      expect(result.cardData?.title).toBe('✅ 新 Session')
      expect(result.cardData?.template).toBe('green')
      expect(mockCreateSession).toHaveBeenCalled()
      expect(mockSetSession).toHaveBeenCalledWith(chatId, 'new-session-id-12345')
    })

    it('resets model and agent when creating new session', async () => {
      setModel(chatId, 'deepseek')
      const state = getChatState(chatId)
      state.agent = 'plan'
      
      await handleCommand(chatId, 'session', ['new'])
      
      const newState = getChatState(chatId)
      expect(newState.model).toBe(null)
      expect(newState.agent).toBe(null)
    })
  })

  describe('/sessions', () => {
    it('lists sessions', async () => {
      const result = await handleCommand(chatId, 'sessions', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('📋 会话列表')
      expect(result.cardData?.content).toContain('Test Session')
      expect(result.cardData?.content).toContain('Another Session')
    })

    it('marks current session with arrow', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-1' })
      const result = await handleCommand(chatId, 'sessions', [])
      expect(result.cardData?.content).toContain('👉 **Test Session**')
    })

    it('handles listSessions error', async () => {
      mockListSessions.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'sessions', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('获取会话列表失败')
    })
  })

  describe('/rename', () => {
    it('returns error when no args', async () => {
      const result = await handleCommand(chatId, 'rename', [])
      expect(result.cardData?.title).toBe('❌ 缺少参数')
      expect(result.cardData?.template).toBe('red')
    })

    it('returns error when no active session', async () => {
      mockGetSession.mockReturnValue(null)
      const result = await handleCommand(chatId, 'rename', ['new-name'])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('当前无活跃会话')
    })

    it('renames session successfully', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      const result = await handleCommand(chatId, 'rename', ['My', 'New', 'Name'])
      expect(result.cardData?.title).toBe('✅ 已重命名')
      expect(result.cardData?.template).toBe('green')
      expect(mockRenameSession).toHaveBeenCalledWith('session-123', 'My New Name')
    })

    it('handles renameSession error', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      mockRenameSession.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'rename', ['new-name'])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('重命名失败')
    })
  })

  describe('/stop', () => {
    it('returns error when no active session', async () => {
      mockGetSession.mockReturnValue(null)
      const result = await handleCommand(chatId, 'stop', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('当前无活跃会话')
    })

    it('stops session successfully', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      const result = await handleCommand(chatId, 'stop', [])
      expect(result.cardData?.title).toBe('⏹ 已停止')
      expect(result.cardData?.template).toBe('orange')
      expect(mockAbortSession).toHaveBeenCalledWith('session-123')
    })

    it('handles abortSession error', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      mockAbortSession.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'stop', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('停止失败')
    })
  })

  describe('/compact', () => {
    it('returns error when no active session', async () => {
      mockGetSession.mockReturnValue(null)
      const result = await handleCommand(chatId, 'compact', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('当前无活跃会话')
    })

    it('compacts session successfully with default model', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      const result = await handleCommand(chatId, 'compact', [])
      expect(result.cardData?.title).toBe('✅ 上下文已压缩')
      expect(result.cardData?.template).toBe('green')
      expect(mockSummarizeSession).toHaveBeenCalledWith('session-123', 'anthropic', 'anthropic/claude-sonnet')
    })

    it('compacts session with custom model', async () => {
      setModel(chatId, 'deepseek')
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      const result = await handleCommand(chatId, 'compact', [])
      expect(mockSummarizeSession).toHaveBeenCalledWith('session-123', 'deepseek', 'deepseek')
    })

    it('handles summarizeSession error', async () => {
      mockGetSession.mockReturnValue({ opencodeSessionId: 'session-123' })
      mockSummarizeSession.mockRejectedValueOnce(new Error('API error'))
      const result = await handleCommand(chatId, 'compact', [])
      expect(result.cardData?.title).toBe('❌ 错误')
      expect(result.cardData?.content).toBe('压缩失败')
    })
  })

  describe('/clear', () => {
    it('creates new session and resets state', async () => {
      setModel(chatId, 'deepseek')
      const state = getChatState(chatId)
      state.agent = 'plan'
      
      const result = await handleCommand(chatId, 'clear', [])
      
      expect(result.cardData?.title).toBe('🗑 已重置')
      expect(result.cardData?.template).toBe('green')
      expect(mockCreateSession).toHaveBeenCalled()
      expect(mockSetSession).toHaveBeenCalled()
      
      const newState = getChatState(chatId)
      expect(newState.model).toBe(null)
      expect(newState.agent).toBe(null)
    })
  })

  describe('/panel', () => {
    it('returns control panel with buttons', async () => {
      const result = await handleCommand(chatId, 'panel', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('🎛 控制面板')
      expect(result.cardData?.template).toBe('blue')
      expect(result.cardData?.buttons).toBeDefined()
      expect(result.cardData?.buttons?.length).toBe(6)
      expect(result.cardData?.buttons).toEqual(expect.arrayContaining([
        { text: '🤖 选模型', value: 'panel:models' },
        { text: '🎭 选角色', value: 'panel:agents' },
      ]))
    })
  })

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const result = await handleCommand(chatId, 'unknowncommand', [])
      expect(result.type).toBe('command')
      expect(result.cardData?.title).toBe('❌ 未知命令')
      expect(result.cardData?.template).toBe('red')
      expect(result.cardData?.content).toContain('unknowncommand')
    })
  })
})

describe('handleCardAction', () => {
  const chatId = 'test-chat-action'

  beforeEach(() => {
    vi.clearAllMocks()
    deleteChatState(chatId)
  })

  describe('model_select action', () => {
    it('sets model and returns success card', () => {
      const result = handleCardAction('model_select:deepseek', chatId)
      
      expect(result).not.toBeNull()
      expect(result?.type).toBe('command')
      expect(result?.cardData?.title).toBe('✅ 模型已切换')
      expect(result?.cardData?.template).toBe('green')
      expect(result?.cardData?.content).toContain('DeepSeek')
      expect(getChatState(chatId).model).toBe('deepseek')
    })

    it('handles model id with colons', () => {
      const result = handleCardAction('model_select:provider:model-id', chatId)
      
      expect(getChatState(chatId).model).toBe('provider:model-id')
    })
  })

  describe('agent_select action', () => {
    it('sets agent and returns success card', () => {
      const result = handleCardAction('agent_select:plan', chatId)
      
      expect(result).not.toBeNull()
      expect(result?.type).toBe('command')
      expect(result?.cardData?.title).toBe('✅ 角色已切换')
      expect(result?.cardData?.template).toBe('green')
      expect(result?.cardData?.content).toContain('plan')
      expect(getChatState(chatId).agent).toBe('plan')
    })

    it('handles agent name with colons', () => {
      const result = handleCardAction('agent_select:some:agent:name', chatId)
      
      expect(getChatState(chatId).agent).toBe('some:agent:name')
    })
  })

  describe('effort_select action', () => {
    it('sets effort to low', () => {
      const result = handleCardAction('effort_select:low', chatId)
      
      expect(result).not.toBeNull()
      expect(result?.cardData?.title).toBe('✅ 推理强度已调整')
      expect(result?.cardData?.content).toContain('低 🐢')
      expect(getChatState(chatId).effort).toBe('low')
    })

    it('sets effort to medium', () => {
      const result = handleCardAction('effort_select:medium', chatId)
      
      expect(getChatState(chatId).effort).toBe('medium')
      expect(result?.cardData?.content).toContain('中 ⚡')
    })

    it('sets effort to high', () => {
      // First set to something else
      getChatState(chatId).effort = 'low'
      
      const result = handleCardAction('effort_select:high', chatId)
      
      expect(getChatState(chatId).effort).toBe('high')
      expect(result?.cardData?.content).toContain('高 🚀')
    })
  })

  describe('panel action', () => {
    it('returns null for panel actions', () => {
      const result = handleCardAction('panel:models', chatId)
      expect(result).toBeNull()
    })

    it('returns null for panel:agents', () => {
      const result = handleCardAction('panel:agents', chatId)
      expect(result).toBeNull()
    })

    it('returns null for panel:effort', () => {
      const result = handleCardAction('panel:effort', chatId)
      expect(result).toBeNull()
    })
  })

  describe('unknown action', () => {
    it('returns null for unknown action', () => {
      const result = handleCardAction('unknown_action', chatId)
      expect(result).toBeNull()
    })
  })
})

describe('ChatState management', () => {
  const chatId1 = 'chat-1'
  const chatId2 = 'chat-2'

  beforeEach(() => {
    vi.clearAllMocks()
    // Clean up any existing states
    deleteChatState(chatId1)
    deleteChatState(chatId2)
  })

  afterEach(() => {
    // Clean up after tests
    deleteChatState(chatId1)
    deleteChatState(chatId2)
  })

  describe('getChatState', () => {
    it('creates default state for new chat', () => {
      const state = getChatState(chatId1)
      
      expect(state).toEqual({
        model: null,
        agent: null,
        effort: 'high',
      })
    })

    it('returns existing state for known chat', () => {
      const state1 = getChatState(chatId1)
      state1.model = 'deepseek'
      state1.agent = 'plan'
      state1.effort = 'low'
      
      const state2 = getChatState(chatId1)
      
      expect(state2.model).toBe('deepseek')
      expect(state2.agent).toBe('plan')
      expect(state2.effort).toBe('low')
    })

    it('maintains separate states for different chats', () => {
      const state1 = getChatState(chatId1)
      const state2 = getChatState(chatId2)
      
      state1.model = 'deepseek'
      state2.model = 'gpt-4'
      
      expect(getChatState(chatId1).model).toBe('deepseek')
      expect(getChatState(chatId2).model).toBe('gpt-4')
    })
  })

  describe('setModel', () => {
    it('sets model for a chat', () => {
      setModel(chatId1, 'claude-3')
      
      expect(getChatState(chatId1).model).toBe('claude-3')
    })

    it('creates state if not exists', () => {
      // Don't call getChatState first
      setModel(chatId1, 'deepseek')
      
      expect(getChatState(chatId1).model).toBe('deepseek')
    })

    it('overwrites existing model', () => {
      setModel(chatId1, 'deepseek')
      setModel(chatId1, 'gpt-4')
      
      expect(getChatState(chatId1).model).toBe('gpt-4')
    })
  })

  describe('deleteChatState', () => {
    it('removes state for a chat', () => {
      const state = getChatState(chatId1)
      state.model = 'deepseek'
      state.agent = 'plan'
      
      deleteChatState(chatId1)
      
      // After deletion, should return fresh default state
      const newState = getChatState(chatId1)
      expect(newState.model).toBe(null)
      expect(newState.agent).toBe(null)
      expect(newState.effort).toBe('high')
    })

    it('does not affect other chats', () => {
      const state1 = getChatState(chatId1)
      state1.model = 'deepseek'
      
      const state2 = getChatState(chatId2)
      state2.model = 'gpt-4'
      
      deleteChatState(chatId1)
      
      expect(getChatState(chatId2).model).toBe('gpt-4')
    })

    it('handles deleting non-existent state', () => {
      // Should not throw
      expect(() => deleteChatState('non-existent-chat')).not.toThrow()
    })
  })

  describe('getModelForChat', () => {
    it('returns null for chat without model', () => {
      expect(getModelForChat(chatId1)).toBe(null)
    })

    it('returns model when set', () => {
      setModel(chatId1, 'deepseek')
      expect(getModelForChat(chatId1)).toBe('deepseek')
    })
  })

  describe('getAgentForChat', () => {
    it('returns null for chat without agent', () => {
      expect(getAgentForChat(chatId1)).toBe(null)
    })

    it('returns agent when set', () => {
      const state = getChatState(chatId1)
      state.agent = 'plan'
      expect(getAgentForChat(chatId1)).toBe('plan')
    })
  })
})