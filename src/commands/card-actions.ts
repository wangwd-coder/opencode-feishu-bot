import { opencodeClient } from '../opencode.js'
import { sessionManager } from '../session.js'
import { CommandResult, ChatState } from './types.js'
import { getChatState, setModel } from './chat-state.js'

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

  if (actionValue === 'renew_session') {
    sessionManager.updateActivity(chatId)
    return {
      type: 'command' as const,
      cardData: {
        title: '✅ 会话已续期',
        template: 'green',
        content: '会话时间已重置，可以继续对话',
      },
    }
  }

  return null
}
