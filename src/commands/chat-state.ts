import { ChatState } from './types.js'

const chatStates: Map<string, ChatState> = new Map()

export function getChatState(chatId: string): ChatState {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, { model: null, agent: null, effort: 'high', workingDir: null })
  }
  return chatStates.get(chatId)!
}

export function setModel(chatId: string, model: string): void {
  getChatState(chatId).model = model
}

export function setWorkingDir(chatId: string, dir: string): void {
  getChatState(chatId).workingDir = dir
}

export function getWorkingDir(chatId: string): string | null {
  return getChatState(chatId).workingDir
}

export function deleteChatState(chatId: string): void {
  chatStates.delete(chatId)
}

export function getModelForChat(chatId: string): string | null {
  return getChatState(chatId).model
}

export function getAgentForChat(chatId: string): string | null {
  return getChatState(chatId).agent
}
