import { opencodeClient } from './opencode.js'
import { buildPermissionCard, buildQuestionCard } from './commands.js'

/**
 * Manages interactive permission/question cards.
 * Tracks which cards have been sent and handles user responses.
 */
export class InteractionHandler {
  // Track sent permission/question IDs to avoid duplicates
  private sentIds: Set<string> = new Set()
  // Map requestId -> feishu messageId for updating cards after user action
  private cardMessages: Map<string, string> = new Map()

  /**
   * Check for pending permissions/questions and return card data for any new ones.
   * Returns array of { cardData, requestId } for cards that need to be sent.
   */
  async checkPending(sessionId: string): Promise<Array<{
    type: 'permission' | 'question'
    requestId: string
    cardData: {
      title: string
      template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
      content: string
      buttons: Array<{ text: string; value: string }>
    }
  }>> {
    const results: Array<{
      type: 'permission' | 'question'
      requestId: string
      cardData: {
        title: string
        template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
        content: string
        buttons: Array<{ text: string; value: string }>
      }
    }> = []

    // Check permissions
    try {
      const permissions = await opencodeClient.getPendingPermissions()
      for (const perm of permissions) {
        if (perm.sessionID === sessionId && !this.sentIds.has(perm.id)) {
          this.sentIds.add(perm.id)
          results.push({
            type: 'permission',
            requestId: perm.id,
            cardData: buildPermissionCard({
              requestId: perm.id,
              permissionType: perm.permission,
              title: (perm.metadata?.filepath as string) || perm.permission,
            }),
          })
        }
      }
    } catch {
      // Ignore permission check errors
    }

    // Check questions
    try {
      const questions = await opencodeClient.getPendingQuestions()
      for (const q of questions) {
        if (q.sessionID === sessionId && !this.sentIds.has(q.id)) {
          this.sentIds.add(q.id)
          results.push({
            type: 'question',
            requestId: q.id,
            cardData: buildQuestionCard({
              requestId: q.id,
              header: q.header || '问题',
              question: q.question || '',
              options: q.options || [{ label: 'Yes' }, { label: 'No' }],
            }),
          })
        }
      }
    } catch {
      // Ignore question check errors
    }

    return results
  }

  /** Record that a card was sent for a requestId */
  recordCardSent(requestId: string, messageId: string): void {
    this.cardMessages.set(requestId, messageId)
  }

  /** Get the feishu message ID for a requestId (for updating the card) */
  getCardMessageId(requestId: string): string | undefined {
    return this.cardMessages.get(requestId)
  }

  /** Remove tracking for a requestId after it's been handled */
  clearRequest(requestId: string): void {
    this.cardMessages.delete(requestId)
    this.sentIds.delete(requestId)
  }

  /** Handle a permission reply action. Returns update card data. */
  async handlePermissionReply(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<{
    title: string
    template: 'green' | 'red'
    content: string
  }> {
    await opencodeClient.replyPermission(requestId, reply)
    console.log(`[Interaction] Permission ${requestId} replied: ${reply}`)
    this.clearRequest(requestId)
    return {
      title: reply === 'reject' ? '❌ 已拒绝' : '✅ 已授权',
      template: reply === 'reject' ? 'red' : 'green',
      content: reply === 'reject'
        ? '权限请求已拒绝'
        : `权限已${reply === 'once' ? '临时' : '永久'}授权`,
    }
  }

  /** Handle a question answer action. Returns update card data. */
  async handleQuestionReply(requestId: string, answers: string[][]): Promise<{
    title: string
    template: 'green'
    content: string
  }> {
    await opencodeClient.replyQuestion(requestId, answers)
    console.log(`[Interaction] Question ${requestId} answered`)
    this.clearRequest(requestId)
    return {
      title: '✅ 已回复',
      template: 'green' as const,
      content: `已选择: ${answers[0]?.[0] || ''}`,
    }
  }

  /** Reset state (e.g. on /clear) */
  reset(): void {
    this.sentIds.clear()
    this.cardMessages.clear()
  }
}

export const interactionHandler = new InteractionHandler()