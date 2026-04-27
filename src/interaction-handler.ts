import { opencodeClient } from './opencode.js'
import { buildPermissionCard, buildQuestionCard } from './commands.js'

/**
 * Manages interactive permission/question cards.
 * Tracks which cards have been sent and handles user responses.
 */
export class InteractionHandler {
  private sentIds: Map<string, Set<string>> = new Map()
  private repliedIds: Set<string> = new Set()
  private cardMessages: Map<string, string> = new Map()

  private getSentIdsForSource(source: string): Set<string> {
    let ids = this.sentIds.get(source)
    if (!ids) {
      ids = new Set<string>()
      this.sentIds.set(source, ids)
    }
    return ids
  }

  async checkPending(sessionId: string, source: string = 'default'): Promise<Array<{
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

    const sourceSentIds = this.getSentIdsForSource(source)

    const [permissionsResult, questionsResult] = await Promise.allSettled([
      opencodeClient.getPendingPermissions(),
      opencodeClient.getPendingQuestions(),
    ])

    if (permissionsResult.status === 'fulfilled') {
      for (const perm of permissionsResult.value) {
        if (perm.sessionID === sessionId && !sourceSentIds.has(perm.id)) {
          sourceSentIds.add(perm.id)
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
    }

    if (questionsResult.status === 'fulfilled') {
      for (const q of questionsResult.value) {
        if (q.sessionID === sessionId && !sourceSentIds.has(q.id)) {
          sourceSentIds.add(q.id)
          results.push({
            type: 'question',
            requestId: q.id,
            cardData: buildQuestionCard({
              requestId: q.id,
              questions: q.questions || [{ question: '', header: '问题', options: [{ label: 'Yes' }, { label: 'No' }] }],
            }),
          })
        }
      }
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

  clearRequest(requestId: string): void {
    this.cardMessages.delete(requestId)
    for (const ids of this.sentIds.values()) {
      ids.delete(requestId)
    }
  }

  /** Handle a permission reply action. Returns update card data. */
  async handlePermissionReply(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<{
    title: string
    template: 'green' | 'red' | 'grey'
    content: string
  }> {
    // Prevent duplicate replies
    if (this.repliedIds.has(requestId)) {
      console.log(`[Interaction] Permission ${requestId} already replied, skipping`)
      return { title: '✅ 已处理', template: 'grey' as const, content: '该权限请求已处理完毕，无需重复操作' }
    }
    this.repliedIds.add(requestId)
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
    template: 'green' | 'grey'
    content: string
  }> {
    // Prevent duplicate replies
    if (this.repliedIds.has(requestId)) {
      console.log(`[Interaction] Question ${requestId} already replied, skipping`)
      return { title: '✅ 已处理', template: 'grey' as const, content: '该问题已回答完毕，无需重复操作' }
    }
    this.repliedIds.add(requestId)
    await opencodeClient.replyQuestion(requestId, answers)
    console.log(`[Interaction] Question ${requestId} answered`)
    this.clearRequest(requestId)
    return {
      title: '✅ 已回复',
      template: 'green' as const,
      content: `已选择: ${answers[0]?.[0] || ''}`,
    }
  }

  reset(): void {
    this.sentIds.clear()
    this.repliedIds.clear()
    this.cardMessages.clear()
  }
}

export const interactionHandler = new InteractionHandler()