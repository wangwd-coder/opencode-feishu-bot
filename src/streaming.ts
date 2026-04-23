import * as Lark from '@larksuiteoapi/node-sdk'
import { appConfig } from './config.js'

interface StreamingCardState {
  messageId: string
  accumulatedText: string
  lastUpdate: number
  updateTimeout: NodeJS.Timeout | null
}

export class StreamingCardController {
  private client: Lark.Client
  private state: StreamingCardState | null = null
  private updateInterval: number
  private minChunkSize: number

  constructor(client: Lark.Client) {
    this.client = client
    this.updateInterval = appConfig.streaming.update_interval
    this.minChunkSize = appConfig.streaming.min_chunk_size
  }

  private buildCard(content: string, title: string = '🤔 Thinking...', template: string = 'blue') {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template,
      },
      elements: [
        {
          tag: 'markdown',
          content: content || ' ',
        },
      ],
    }
  }

  async init(chatId: string): Promise<string> {
    const card = this.buildCard(' ')

    const msgRes = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })

    const messageId = msgRes.data?.message_id || ''

    this.state = {
      messageId,
      accumulatedText: '',
      lastUpdate: Date.now(),
      updateTimeout: null,
    }

    console.log(`[StreamingCard] Initialized: messageId=${messageId}`)
    return messageId
  }

  async appendText(chunk: string): Promise<void> {
    if (!this.state) return

    this.state.accumulatedText += chunk

    const now = Date.now()
    const shouldUpdate =
      now - this.state.lastUpdate >= this.updateInterval ||
      this.state.accumulatedText.length >= this.minChunkSize

    if (shouldUpdate) {
      await this.patchCard(this.state.accumulatedText)
    }
  }

  /** Replace the entire card content with a status message (for progress updates) */
  async updateStatus(statusText: string): Promise<void> {
    if (!this.state) {
      console.log('[StreamingCard] updateStatus: no state')
      return
    }
    await this.patchCard(statusText, '⏳ Processing...')
    console.log(`[StreamingCard] Status updated: ${statusText.substring(0, 60)}`)
  }

  async complete(finalText?: string): Promise<void> {
    if (!this.state) return

    if (this.state.updateTimeout) {
      clearTimeout(this.state.updateTimeout)
      this.state.updateTimeout = null
    }

    const text = finalText || this.state.accumulatedText
    await this.patchCard(text, '✅ OpenCode')

    console.log(`[StreamingCard] Completed with ${text.length} chars`)
    this.state = null
  }

  async error(message: string): Promise<void> {
    if (!this.state) return
    await this.patchCard(message, '❌ Error', 'red')
    this.state = null
  }

  private async patchCard(content: string, title: string = '🤔 Thinking...', template: string = 'blue'): Promise<void> {
    if (!this.state?.messageId) return

    const card = this.buildCard(content, title, template)

    try {
      await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: JSON.stringify(card) },
      })
      this.state.lastUpdate = Date.now()
    } catch (error) {
      console.error('[StreamingCard] Failed to patch card:', error)
    }
  }
}
