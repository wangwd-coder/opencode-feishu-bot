import { appConfig } from './config.js'
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
}

export interface ChatState {
  model: string | null
}

const chatStates: Map<string, ChatState> = new Map()

export function getChatState(chatId: string): ChatState {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, { model: null })
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
    case 'help':
      return {
        type: 'command',
        cardData: {
          title: '📖 帮助',
          template: 'blue',
          content: `**命令列表：**

• \`/model\` - 选择模型（交互式按钮）
• \`/session\` - 查看/新建 session
• \`/status\` - 显示当前状态
• \`/help\` - 显示帮助

---

💡 **群聊中使用：** @机器人 + 命令`,
        },
      }
    
    case 'model':
      const models = opencodeClient.getModelList()
      const currentModel = state.model 
        ? models.find(m => m.id === state.model)?.name || state.model
        : '默认'
      
      // Build model selection buttons
      const modelButtons = models.slice(0, 6).map(m => ({
        text: m.name,
        value: `model_select:${m.id}`,
      }))
      
      return {
        type: 'command',
        cardData: {
          title: '🤖 选择模型',
          template: 'blue',
          content: `**当前:** ${currentModel}

点击切换模型：`,
          buttons: modelButtons,
        },
      }
    
    case 'session':
      if (args[0]?.toLowerCase() === 'new') {
        const newSessionId = await opencodeClient.createSession(`Feishu: ${chatId.substring(0, 8)}`)
        sessionManager.setSession(chatId, newSessionId)
        state.model = null
        
        return {
          type: 'command',
          cardData: {
            title: '✅ 新 Session',
            template: 'green',
            content: `已创建新 session，历史已清空`,
          },
        }
      }
      
      const session = sessionManager.getSession(chatId)
      return {
        type: 'command',
        cardData: {
          title: '📝 Session',
          template: 'blue',
          content: `**Session:** ${session?.opencodeSessionId || '无'}

• \`/session new\` - 创建新 session`,
        },
      }
    
    case 'status':
      const sess = sessionManager.getSession(chatId)
      const mdl = state.model 
        ? opencodeClient.getModelList().find(m => m.id === state.model)?.name || state.model
        : '默认'
      
      return {
        type: 'command',
        cardData: {
          title: '📊 状态',
          template: 'blue',
          content: `**模型:** ${mdl}
**Session:** ${sess?.opencodeSessionId?.substring(0, 20) || '无'}...`,
        },
      }
    
    default:
      return {
        type: 'command',
        cardData: {
          title: '❌ 未知命令',
          template: 'red',
          content: `输入 \`/help\` 查看帮助`,
        },
      }
  }
}

export function getModelForChat(chatId: string): string | null {
  return getChatState(chatId).model
}

export function handleCardAction(actionValue: string, chatId: string): CommandResult | null {
  if (actionValue.startsWith('model_select:')) {
    const modelId = actionValue.split(':')[1]
    const models = opencodeClient.getModelList()
    const model = models.find(m => m.id === modelId)
    
    setModel(chatId, modelId)
    
    return {
      type: 'command',
      cardData: {
        title: '✅ 模型已切换',
        template: 'green',
        content: `已切换为 **${model?.name || modelId}**

继续对话即可使用新模型`,
      },
    }
  }
  
  return null
}