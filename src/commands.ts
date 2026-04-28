import { opencodeClient } from './opencode.js'
import { sessionManager } from './session.js'

export interface CommandResult {
  type: 'command' | 'message'
  response?: string
  shouldProcess?: boolean
  cardData?: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
    buttons?: Array<{ text: string; value: string }>
  }
  pendingAction?: { type: string; requestId: string; reply?: string; answers?: string[][] }
}

export interface ChatState {
  model: string | null
  agent: string | null
  effort: 'low' | 'medium' | 'high'
}

// Permission card builder
export function buildPermissionCard(data: {
  requestId: string
  permissionType: string
  title: string
}): {
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} {
  return {
    title: `🔐 权限请求: ${data.permissionType}`,
    template: 'orange',
    content: data.title,
    buttons: [
      { text: '✅ 允许一次', value: `permission_reply:${data.requestId}:once` },
      { text: '✅ 始终允许', value: `permission_reply:${data.requestId}:always` },
      { text: '❌ 拒绝', value: `permission_reply:${data.requestId}:reject` },
    ],
  }
}

// Question card builder
export function buildQuestionCard(data: {
  requestId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiple?: boolean
    custom?: boolean
  }>
}): {
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} {
  const firstQ = data.questions[0]
  const header = firstQ?.header || '问题'
  const question = firstQ?.question || ''
  const options = firstQ?.options || [{ label: 'Yes' }, { label: 'No' }]
  const isCustom = firstQ?.custom ?? false

  // Build content with option descriptions
  let content = question
  if (options.some(o => o.description)) {
    content += '\n\n' + options.map((o, i) => `**${i + 1}. ${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n')
  }
  if (isCustom) {
    content += '\n\n💡 支持自定义回答：点击下方「自定义回答」按钮后，直接发送文字即可'
  }

  // Build buttons
  const buttons = options.slice(0, 5).map(opt => ({
    text: opt.label,
    value: `question_answer:${data.requestId}:${opt.label}`,
  }))

  // Add custom input button if allowed
  if (isCustom) {
    buttons.push({
      text: '💬 自定义回答',
      value: `question_custom:${data.requestId}`,
    })
  }

  // Always add skip button
  buttons.push({
    text: '⏭ 跳过',
    value: `question_answer:${data.requestId}:skip`,
  })

  return {
    title: `❓ ${header}`,
    template: 'blue',
    content,
    buttons,
  }
}

const chatStates: Map<string, ChatState> = new Map()

export function getChatState(chatId: string): ChatState {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, { model: null, agent: null, effort: 'high' })
  }
  return chatStates.get(chatId)!
}

export function setModel(chatId: string, model: string): void {
  getChatState(chatId).model = model
}

export function deleteChatState(chatId: string): void {
  chatStates.delete(chatId)
}

export function parseCommand(text: string): { isCommand: boolean; command: string; args: string[] } {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return { isCommand: false, command: '', args: [] }
  }
  const parts = trimmed.slice(1).split(/\s+/)
  const command = parts[0]?.toLowerCase() || ''
  const args = parts.slice(1)
  return { isCommand: true, command, args }
}

export async function handleCommand(
  chatId: string,
  command: string,
  args: string[]
): Promise<CommandResult> {
  const state = getChatState(chatId)

  switch (command) {
    // ─── Help ───
    case 'help':
      return {
        type: 'command',
        cardData: {
          title: '📖 帮助',
          template: 'blue',
          content: `**基础命令：**
• \`/help\` — 查看帮助
• \`/status\` — 查看当前状态
• \`/panel\` — 显示控制面板

**模型相关：**
• \`/model\` — 查看当前模型
• \`/model <名称>\` — 切换模型
• \`/models\` — 列出所有可用模型

**角色相关：**
• \`/agent\` — 查看当前角色
• \`/agent <名称>\` — 切换角色
• \`/agents\` — 列出所有可用角色

**推理强度：**
• \`/effort\` — 查看当前推理强度
• \`/effort <low|medium|high>\` — 设置推理强度

**会话管理：**
• \`/session new [路径]\` — 开启新话题（可选指定目录）
• \`/sessions\` — 列出会话
• \`/rename <名称>\` — 重命名会话
• \`/stop\` — 停止当前回答
• \`/compact\` — 压缩上下文
• \`/clear\` — 重置对话上下文

**工作目录：**
• \`/cd <路径>\` — 切换工作目录并新建会话
• \`/pwd\` — 查看当前工作目录`,
        },
      }

    // ─── Model ───
    case 'model': {
      if (args.length > 0) {
        // /model <name> — switch model
        const query = args.join(' ').toLowerCase()
        const models = opencodeClient.getModelList()
        const match = models.find(
          m => m.id.toLowerCase() === query || m.name.toLowerCase() === query ||
               m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)
        )
        if (match) {
          setModel(chatId, match.id)
          return {
            type: 'command',
            cardData: {
              title: '✅ 模型已切换',
              template: 'green',
              content: `已切换为 **${match.name}** (\`${match.id}\`)`,
            },
          }
        }
        return {
          type: 'command',
          cardData: {
            title: '❌ 未找到模型',
            template: 'red',
            content: `未找到匹配 "${args.join(' ')}" 的模型\n\n输入 \`/models\` 查看可用模型`,
          },
        }
      }
      // /model — show current
      const currentModel = state.model
        ? opencodeClient.getModelList().find(m => m.id === state.model)?.name || state.model
        : '默认'
      return {
        type: 'command',
        cardData: {
          title: '🤖 当前模型',
          template: 'blue',
          content: `**当前模型:** ${currentModel}\n\n输入 \`/models\` 查看所有可用模型`,
        },
      }
    }

    case 'models': {
      const models = opencodeClient.getModelList()
      const currentId = state.model
      const modelButtons = models.slice(0, 8).map(m => ({
        text: m.id === currentId ? `✅ ${m.name}` : m.name,
        value: `model_select:${m.id}`,
      }))
      const modelList = models
        .map(m => `${m.id === currentId ? '👉 ' : '• '}\`${m.id}\` — ${m.name}`)
        .join('\n')
      return {
        type: 'command',
        cardData: {
          title: '🤖 可用模型',
          template: 'blue',
          content: modelList,
          buttons: modelButtons,
        },
      }
    }

    // ─── Agent ───
    case 'agent': {
      if (args.length > 0) {
        const query = args.join(' ').toLowerCase()
        try {
          const agents = await opencodeClient.getAgents()
          const primaryAgents = agents.filter(a => a.mode === 'primary')
          const match = primaryAgents.find(
            a => a.name.toLowerCase() === query || a.name.toLowerCase().includes(query)
          )
          if (match) {
            state.agent = match.name
            return {
              type: 'command',
              cardData: {
                title: '✅ 角色已切换',
                template: 'green',
                content: `已切换为 **${match.name}**`,
              },
            }
          }
          return {
            type: 'command',
            cardData: {
              title: '❌ 未找到角色',
              template: 'red',
              content: `未找到匹配 "${args.join(' ')}" 的角色\n\n输入 \`/agents\` 查看可用角色`,
            },
          }
        } catch {
          return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '获取角色列表失败' } }
        }
      }
      return {
        type: 'command',
        cardData: {
          title: '🎭 当前角色',
          template: 'blue',
          content: `**当前角色:** ${state.agent || '默认 (orchestrator)'}\n\n输入 \`/agents\` 查看所有可用角色`,
        },
      }
    }

    case 'agents': {
      try {
        const agents = await opencodeClient.getAgents()
        const primaryAgents = agents.filter(a => a.mode === 'primary')
        const agentList = primaryAgents
          .map(a => `${a.name === state.agent ? '👉 ' : '• '}\`${a.name}\``)
          .join('\n')
        const agentButtons = primaryAgents.slice(0, 8).map(a => ({
          text: a.name === state.agent ? `✅ ${a.name}` : a.name,
          value: `agent_select:${a.name}`,
        }))
        return {
          type: 'command',
          cardData: {
            title: '🎭 可用角色',
            template: 'blue',
            content: agentList,
            buttons: agentButtons,
          },
        }
      } catch {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '获取角色列表失败' } }
      }
    }

    // ─── Effort ───
    case 'effort': {
      if (args.length > 0) {
        const level = args[0].toLowerCase()
        if (level === 'low' || level === 'medium' || level === 'high') {
          state.effort = level
          const labels: Record<string, string> = { low: '低 🐢', medium: '中 ⚡', high: '高 🚀' }
          return {
            type: 'command',
            cardData: {
              title: '✅ 推理强度已调整',
              template: 'green',
              content: `当前推理强度: **${labels[level]}**`,
            },
          }
        }
        return {
          type: 'command',
          cardData: {
            title: '❌ 无效档位',
            template: 'red',
            content: '有效值: `low` / `medium` / `high`',
          },
        }
      }
      const labels: Record<string, string> = { low: '低 🐢', medium: '中 ⚡', high: '高 🚀' }
      return {
        type: 'command',
        cardData: {
          title: '🧠 推理强度',
          template: 'blue',
          content: `**当前:** ${labels[state.effort]}`,
          buttons: [
            { text: '🐢 低', value: 'effort_select:low' },
            { text: '⚡ 中', value: 'effort_select:medium' },
            { text: '🚀 高', value: 'effort_select:high' },
          ],
        },
      }
    }

    // ─── Session management ───
    case 'session': {
      if (args[0]?.toLowerCase() === 'new') {
        const dirPath = args.length > 1 ? args.slice(1).join(' ') : undefined
        const newSessionId = await opencodeClient.createSession(`IM: ${chatId.substring(0, 8)}`, dirPath)
        sessionManager.setSession(chatId, newSessionId)
        state.model = null
        state.agent = null
        const dirInfo = dirPath ? `\n**目录:** \`${dirPath}\`` : ''
        return {
          type: 'command',
          cardData: {
            title: '✅ 新 Session',
            template: 'green',
            content: `已创建新 session，历史已清空${dirInfo}`,
          },
        }
      }
      const session = sessionManager.getSession(chatId)
      return {
        type: 'command',
        cardData: {
          title: '📝 Session',
          template: 'blue',
          content: `**Session:** ${session?.opencodeSessionId || '无'}\n\n• \`/session new\` — 创建新 session\n• \`/sessions\` — 列出所有 session`,
        },
      }
    }

    case 'sessions': {
      try {
        const sessions = await opencodeClient.listSessions()
        const currentSessionId = sessionManager.getSession(chatId)?.opencodeSessionId
        const list = sessions.slice(0, 10).map(s => {
          const isCurrent = s.id === currentSessionId ? ' 👈' : ''
          const age = Math.floor((Date.now() - s.time.updated) / 60000)
          const ageStr = age < 60 ? `${age}分钟前` : `${Math.floor(age / 60)}小时前`
          return `${isCurrent ? '👉 ' : '• '}**${s.title || s.slug}** — ${ageStr}${isCurrent}`
        }).join('\n')
        return {
          type: 'command',
          cardData: {
            title: '📋 会话列表',
            template: 'blue',
            content: list || '暂无会话',
          },
        }
      } catch {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '获取会话列表失败' } }
      }
    }

    case 'rename': {
      if (args.length === 0) {
        return {
          type: 'command',
          cardData: {
            title: '❌ 缺少参数',
            template: 'red',
            content: '用法: `/rename <新名称>`',
          },
        }
      }
      const session = sessionManager.getSession(chatId)
      if (!session) {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '当前无活跃会话' } }
      }
      try {
        await opencodeClient.renameSession(session.opencodeSessionId, args.join(' '))
        return {
          type: 'command',
          cardData: {
            title: '✅ 已重命名',
            template: 'green',
            content: `会话已重命名为 **${args.join(' ')}**`,
          },
        }
      } catch {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '重命名失败' } }
      }
    }

    case 'stop': {
      const session = sessionManager.getSession(chatId)
      if (!session) {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '当前无活跃会话' } }
      }
      try {
        await opencodeClient.abortSession(session.opencodeSessionId)
        return {
          type: 'command',
          cardData: {
            title: '⏹ 已停止',
            template: 'orange',
            content: '当前回答已停止',
          },
        }
      } catch {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '停止失败' } }
      }
    }

    case 'compact': {
      const session = sessionManager.getSession(chatId)
      if (!session) {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '当前无活跃会话' } }
      }
      try {
        const modelId = state.model || 'anthropic/claude-sonnet'
        const [providerID, ...rest] = modelId.split('/')
        await opencodeClient.summarizeSession(session.opencodeSessionId, providerID, modelId)
        return {
          type: 'command',
          cardData: {
            title: '✅ 上下文已压缩',
            template: 'green',
            content: '对话上下文已压缩，可以继续对话',
          },
        }
      } catch {
        return { type: 'command', cardData: { title: '❌ 错误', template: 'red', content: '压缩失败' } }
      }
    }

    case 'clear': {
      const clearSessionId = await opencodeClient.createSession(`IM: ${chatId.substring(0, 8)}`)
      sessionManager.setSession(chatId, clearSessionId)
      state.model = null
      state.agent = null
      return {
        type: 'command',
        cardData: {
          title: '🗑 已重置',
          template: 'green',
          content: '对话上下文已清空，开始全新对话',
        },
      }
    }

    // ─── Working directory ───
    case 'cd': {
      if (args.length === 0) {
        return {
          type: 'command',
          cardData: {
            title: '❌ 缺少路径',
            template: 'red',
            content: '用法: `/cd <目录路径>`\n\n示例:\n• `/cd /Users/me/project`\n• `/cd ~/my-app`',
          },
        }
      }
      const targetDir = args.join(' ')
      try {
        const cdSessionId = await opencodeClient.createSession(`IM: ${chatId.substring(0, 8)}`, targetDir)
        sessionManager.setSession(chatId, cdSessionId)
        state.model = null
        state.agent = null
        return {
          type: 'command',
          cardData: {
            title: '📁 已切换工作目录',
            template: 'green',
            content: `已切换到 \`${targetDir}\`\n\n新会话已创建，历史已清空`,
          },
        }
      } catch (err) {
        return {
          type: 'command',
          cardData: {
            title: '❌ 切换失败',
            template: 'red',
            content: `无法切换到 \`${targetDir}\`\n\n${err instanceof Error ? err.message : '请检查路径是否正确'}`,
          },
        }
      }
    }

    case 'pwd': {
      const currentSession = sessionManager.getSession(chatId)
      if (!currentSession) {
        return {
          type: 'command',
          cardData: {
            title: '📂 工作目录',
            template: 'blue',
            content: '当前无活跃会话\n\n使用 `/cd <路径>` 指定工作目录',
          },
        }
      }
      try {
        const sessionInfo = await opencodeClient.getSession(currentSession.opencodeSessionId)
        return {
          type: 'command',
          cardData: {
            title: '📂 工作目录',
            template: 'blue',
            content: `**目录:** \`${sessionInfo.directory}\`\n**Session:** \`${currentSession.opencodeSessionId.substring(0, 20)}\``,
          },
        }
      } catch {
        return {
          type: 'command',
          cardData: {
            title: '📂 工作目录',
            template: 'blue',
            content: '无法获取当前目录信息',
          },
        }
      }
    }

    // ─── Status ───
    case 'status': {
      const sess = sessionManager.getSession(chatId)
      const mdl = state.model
        ? opencodeClient.getModelList().find(m => m.id === state.model)?.name || state.model
        : '默认'
      const labels: Record<string, string> = { low: '低 🐢', medium: '中 ⚡', high: '高 🚀' }
      return {
        type: 'command',
        cardData: {
          title: '📊 状态',
          template: 'blue',
          content: `**模型:** ${mdl}
**角色:** ${state.agent || '默认 (orchestrator)'}
**推理强度:** ${labels[state.effort]}
**Session:** \`${sess?.opencodeSessionId?.substring(0, 20) || '无'}\``,
        },
      }
    }

    // ─── Panel ───
    case 'panel':
      return {
        type: 'command',
        cardData: {
          title: '🎛 控制面板',
          template: 'blue',
          content: '选择操作：',
          buttons: [
            { text: '🤖 选模型', value: 'panel:models' },
            { text: '🎭 选角色', value: 'panel:agents' },
            { text: '🧠 推理强度', value: 'panel:effort' },
            { text: '📋 会话列表', value: 'panel:sessions' },
            { text: '🆕 新会话', value: 'panel:new_session' },
            { text: '📊 状态', value: 'panel:status' },
          ],
        },
      }

    default:
      return {
        type: 'command',
        cardData: {
          title: '❌ 未知命令',
          template: 'red',
          content: `未知命令 \`/${command}\`\n\n输入 \`/help\` 查看帮助`,
        },
      }
  }
}

export function getModelForChat(chatId: string): string | null {
  return getChatState(chatId).model
}

export function getAgentForChat(chatId: string): string | null {
  return getChatState(chatId).agent
}

export function handleCardAction(actionValue: string, chatId: string): CommandResult | null {
  const state = getChatState(chatId)

  if (actionValue.startsWith('model_select:')) {
    const modelId = actionValue.split(':').slice(1).join(':')
    const models = opencodeClient.getModelList()
    const model = models.find(m => m.id === modelId)
    setModel(chatId, modelId)
    return {
      type: 'command',
      cardData: {
        title: '✅ 模型已切换',
        template: 'green',
        content: `已切换为 **${model?.name || modelId}**\n\n继续对话即可使用新模型`,
      },
    }
  }

  if (actionValue.startsWith('agent_select:')) {
    const agentName = actionValue.split(':').slice(1).join(':')
    state.agent = agentName
    return {
      type: 'command',
      cardData: {
        title: '✅ 角色已切换',
        template: 'green',
        content: `已切换为 **${agentName}**`,
      },
    }
  }

  if (actionValue.startsWith('effort_select:')) {
    const level = actionValue.split(':')[1] as 'low' | 'medium' | 'high'
    state.effort = level
    const labels: Record<string, string> = { low: '低 🐢', medium: '中 ⚡', high: '高 🚀' }
    return {
      type: 'command',
      cardData: {
        title: '✅ 推理强度已调整',
        template: 'green',
        content: `当前推理强度: **${labels[level]}**`,
      },
    }
  }

  if (actionValue.startsWith('permission_reply:')) {
    // Format: permission_reply:{requestId}:{reply}
    const parts = actionValue.split(':')
    if (parts.length >= 3) {
      const reply = parts[parts.length - 1] as 'once' | 'always' | 'reject'
      const requestId = parts.slice(1, -1).join(':')
      return {
        type: 'command' as const,
        cardData: {
          title: reply === 'reject' ? '❌ 已拒绝' : '✅ 已授权',
          template: reply === 'reject' ? 'red' : 'green',
          content: reply === 'reject'
            ? '权限请求已拒绝'
            : `权限已${reply === 'once' ? '临时' : '永久'}授权`,
        },
        pendingAction: { type: 'permission_reply', requestId, reply },
      }
    }
  }

  if (actionValue.startsWith('question_answer:')) {
    // Format: question_answer:{requestId}:{answer}
    const parts = actionValue.split(':')
    if (parts.length >= 3) {
      const requestId = parts[1]
      const answer = parts.slice(2).join(':') // answer might contain colons
      return {
        type: 'command' as const,
        cardData: {
          title: '✅ 已回复',
          template: 'green',
          content: `已选择: ${answer}`,
        },
        pendingAction: { type: 'question_answer', requestId, answers: [[answer]] },
      }
    }
  }

  if (actionValue.startsWith('question_custom:')) {
    // Format: question_custom:{requestId}
    const requestId = actionValue.slice('question_custom:'.length)
    return {
      type: 'command' as const,
      cardData: {
        title: '💬 自定义回答',
        template: 'blue',
        content: '请直接发送您的回答：',
      },
      pendingAction: { type: 'question_custom', requestId },
    }
  }

  return null
}