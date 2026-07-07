export interface CommandResult {
  type: 'command' | 'message'
  response?: string
  shouldProcess?: boolean
  cardData?: {
    title: string
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
    content: string
    buttons?: Array<{ text: string; value: string }>
    actions?: Array<{ tag: string; placeholder?: string; value: string; options?: Array<{ text: string; value: string }> }>
  }
  pendingAction?: { type: string; requestId: string; reply?: string; answers?: string[][] }
}

export interface ChatState {
  model: string | null
  agent: string | null
  effort: 'low' | 'medium' | 'high'
  workingDir: string | null
}
