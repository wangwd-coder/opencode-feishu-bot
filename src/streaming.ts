import * as Lark from '@larksuiteoapi/node-sdk'
import { appConfig } from './config.js'

interface StreamingCardState {
  cardId: string | null
  messageId: string | null
  sequence: number
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

  async init(chatId: string): Promise<string> {
    const cardJson = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🤔 Thinking...' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: ' ',
          element_id: 'content',
        },
      ],
    }

    let cardId: string | null = null

    try {
      const createRes = await this.client.request({
        method: 'POST',
        url: '/open-apis/cardkit/v1/cards',
        data: {
          type: 'template',
          data: JSON.stringify(cardJson),
        },
      })
      cardId = (createRes as any).data?.card_id || null

      if (!cardId) {
        return await this.fallbackSend(chatId, 'Thinking...')
      }
    } catch (error) {
      console.error('[StreamingCard] Failed to create card, using fallback:', error)
      return await this.fallbackSend(chatId, 'Thinking...')
    }

    const msgRes = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({ card_id: cardId }),
      },
    })

    const messageId = msgRes.data?.message_id || null

    this.state = {
      cardId,
      messageId,
      sequence: 1,
      accumulatedText: '',
      lastUpdate: Date.now(),
      updateTimeout: null,
    }

    console.log(`[StreamingCard] Initialized: cardId=${cardId}, messageId=${messageId}`)
    return messageId || ''
  }

  async appendText(chunk: string): Promise<void> {
    if (!this.state) return

    this.state.accumulatedText += chunk

    const now = Date.now()
    const shouldUpdate =
      now - this.state.lastUpdate >= this.updateInterval ||
      this.state.accumulatedText.length >= this.minChunkSize

    if (shouldUpdate) {
      await this.flushText()
    }
  }

  /** Replace the entire card content with a status message (for progress updates) */
  async updateStatus(statusText: string): Promise<void> {
    if (!this.state) {
      console.log('[StreamingCard] updateStatus: no state')
      return
    }
    if (!this.state.cardId) {
      console.log('[StreamingCard] updateStatus: no cardId, using fallback')
      // Fallback: update via message patch if no cardId
      if (this.state.messageId) {
        const card = {
          config: { wide_screen_mode: true, update_multi: true },
          header: {
            title: { tag: 'plain_text', content: '🤔 Processing...' },
            template: 'blue',
          },
          elements: [{ tag: 'markdown', content: statusText }],
        }
        try {
          await this.client.im.message.patch({
            path: { message_id: this.state.messageId },
            data: { content: JSON.stringify(card) },
          })
        } catch (error) {
          console.error('[StreamingCard] Failed to patch message with status:', error)
        }
      }
      return
    }

    this.state.sequence++

    try {
      await this.client.request({
        method: 'PUT',
        url: `/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        data: {
          content: statusText,
          sequence: this.state.sequence,
        },
      })
      this.state.lastUpdate = Date.now()
      console.log(`[StreamingCard] Status updated: ${statusText.substring(0, 50)}`)
    } catch (error) {
      console.error('[StreamingCard] Failed to update status:', error)
    }
  }

  private async flushText(): Promise<void> {
    if (!this.state || !this.state.cardId) return

    this.state.sequence++

    try {
      await this.client.request({
        method: 'PUT',
        url: `/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        data: {
          content: this.state.accumulatedText,
          sequence: this.state.sequence,
        },
      })
      this.state.lastUpdate = Date.now()
    } catch (error) {
      console.error('[StreamingCard] Failed to update card:', error)
    }
  }

  async complete(finalText?: string): Promise<void> {
    if (!this.state) return

    if (this.state.updateTimeout) {
      clearTimeout(this.state.updateTimeout)
      this.state.updateTimeout = null
    }

    const text = finalText || this.state.accumulatedText

    if (this.state.cardId) {
      try {
        this.state.sequence++
        await this.client.request({
          method: 'PUT',
          url: `/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
          data: {
            content: text,
            sequence: this.state.sequence,
          },
        })

        this.state.sequence++
        await this.client.request({
          method: 'PATCH',
          url: `/open-apis/cardkit/v1/cards/${this.state.cardId}/settings`,
          data: {
            streaming_mode: false,
            sequence: this.state.sequence,
          },
        })
      } catch (error) {
        console.error('[StreamingCard] Failed to complete card:', error)
        await this.fallbackUpdate(text)
      }
    } else {
      await this.fallbackUpdate(text)
    }

    console.log(`[StreamingCard] Completed with ${text.length} chars`)
    this.state = null
  }

  async error(message: string): Promise<void> {
    if (!this.state) return

    const errorCard = {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '❌ Error' },
        template: 'red',
      },
      elements: [
        {
          tag: 'markdown',
          content: message,
        },
      ],
    }

    if (this.state.messageId) {
      try {
        await this.client.im.message.patch({
          path: { message_id: this.state.messageId },
          data: { content: JSON.stringify(errorCard) },
        })
      } catch {
        console.error('[StreamingCard] Failed to update error card')
      }
    }

    this.state = null
  }

  private async fallbackSend(chatId: string, text: string): Promise<string> {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🤖 OpenCode' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    }

    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })

    const messageId = res.data?.message_id || null
    this.state = {
      cardId: null,
      messageId,
      sequence: 0,
      accumulatedText: text,
      lastUpdate: Date.now(),
      updateTimeout: null,
    }

    return messageId || ''
  }

  private async fallbackUpdate(text: string): Promise<void> {
    if (!this.state?.messageId) return

    const card = {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '✅ OpenCode' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    }

    await this.client.im.message.patch({
      path: { message_id: this.state.messageId },
      data: { content: JSON.stringify(card) },
    })
  }
}
