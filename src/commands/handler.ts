import { opencodeClient } from '../opencode.js'
import { sessionManager } from '../session.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { CommandResult, ChatState } from './types.js'
import { buildCdBrowserCard } from './card-builders.js'
import { getChatState, setModel, setWorkingDir } from './chat-state.js'
import { expandHome, HOME, shortenPath } from './path-utils.js'

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
          content: `点击下方按钮查看详情或执行操作。\n\n**文本命令：** 直接发送以 \`/\` 开头的消息即可`,
          buttons: [
            { text: '🎛️ 控制面板', value: 'panel:panel' },
            { text: '📊 查看状态', value: 'panel:status' },
            { text: '🤖 模型列表', value: 'panel:models' },
            { text: '🧑‍💻 角色列表', value: 'panel:agents' },
            { text: '⚡ 推理强度', value: 'panel:effort' },
            { text: '📂 切换目录', value: 'panel:cd' },
            { text: '💬 会话列表', value: 'panel:sessions' },
            { text: '🆕 新建会话', value: 'panel:new_session' },
          ],
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

        // Fetch directory for top 20 sessions in parallel, fall back to title/slug for the rest
        const detailLimit = 20
        const fetchTargets = sessions.slice(0, detailLimit)
        const detailResults = await Promise.allSettled(
          fetchTargets.map(s => opencodeClient.getSession(s.id))
        )
        const dirMap = new Map<string, string | null>()
        fetchTargets.forEach((s, i) => {
          const result = detailResults[i]
          if (result?.status === 'fulfilled' && result.value.directory) {
            const short = result.value.directory.replace(/^\/Users\/\w+/, '~').replace(/\/$/, '').split('/').slice(-2).join('/')
            dirMap.set(s.id, short)
          } else {
            dirMap.set(s.id, null)
          }
        })

        const list = sessions.map((s, i) => {
          const isCurrent = s.id === currentSessionId ? ' 👈' : ''
          const age = Math.floor((Date.now() - s.time.updated) / 60000)
          const ageStr = age < 60 ? `${age}分钟前` : `${Math.floor(age / 60)}小时前`
          const dir = dirMap.get(s.id)
          const desc = dir || s.title || s.slug
          return `${i + 1}. ${isCurrent ? '👉 ' : ''}📁 **${desc}**\n　　 ${ageStr} — \`${s.slug}\`${isCurrent}`
        }).join('\n\n')
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
      // Resolve base directory: current session dir → home
      let baseDir = HOME
      const currentSessionId = sessionManager.getSession(chatId)?.opencodeSessionId
      if (currentSessionId) {
        try {
          const info = await opencodeClient.getSession(currentSessionId)
          if (info.directory) baseDir = info.directory
        } catch { /* use home as fallback */ }
      }

      let targetDir = args.join(' ')
      if (!targetDir) {
        targetDir = baseDir
      } else if (targetDir.startsWith('~')) {
        targetDir = expandHome(targetDir)
      } else if (targetDir === '.' || targetDir === '..' || !targetDir.startsWith('/')) {
        // relative path: resolve from baseDir
        targetDir = path.resolve(baseDir, targetDir)
      }

      const card = await buildCdBrowserCard(targetDir)
      if (card) {
        return { type: 'command', cardData: card }
      }
      return {
        type: 'command',
        cardData: {
          title: '❌ 目录不存在',
          template: 'red',
          content: `无法访问 \`${targetDir}\`\n\n请检查路径，或输入 \`/cd\` 从主目录开始浏览`,
        },
      }
    }

    case 'mkdir': {
      if (args.length === 0) {
        return {
          type: 'command',
          cardData: {
            title: '❌ 缺少目录名',
            template: 'red',
            content: '用法: `/mkdir <目录名>`\n\n在当前工作目录下创建新文件夹',
          },
        }
      }
      const dirName = args.join(' ')
      // Resolve base directory from current session
      let baseDir = HOME
      const currentId = sessionManager.getSession(chatId)?.opencodeSessionId
      if (currentId) {
        try {
          const info = await opencodeClient.getSession(currentId)
          if (info.directory) baseDir = info.directory
        } catch { /* fallback */ }
      }
      const newDir = path.join(baseDir, dirName)
      try {
        await fs.mkdir(newDir)
        return {
          type: 'command',
          cardData: {
            title: '✅ 目录已创建',
            template: 'green',
            content: `已创建: \`${shortenPath(newDir)}\`\n\n输入 \`/cd ${shortenPath(newDir)}\` 切换到该目录`,
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误'
        return {
          type: 'command',
          cardData: {
            title: '❌ 创建失败',
            template: 'red',
            content: `无法创建 \`${dirName}\`\n\n${msg}`,
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
            { text: '📁 切换目录', value: 'panel:cd' },
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
