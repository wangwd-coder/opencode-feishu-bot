import { appConfig } from './config.js'
import { deleteChatState } from './commands.js'

interface SessionInfo {
  opencodeSessionId: string
  chatId: string
  lastActivity: number
}

class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor() {
    this.startCleanup()
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      const ttl = appConfig.session.ttl * 1000

      for (const [chatId, session] of this.sessions.entries()) {
        if (now - session.lastActivity > ttl) {
          this.sessions.delete(chatId)
          deleteChatState(chatId)
          console.log(`[Session] Cleaned up expired session for chat: ${chatId}`)
        }
      }
    }, 60000)
  }

  getSession(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId)
  }

  setSession(chatId: string, opencodeSessionId: string): void {
    if (this.sessions.size >= appConfig.session.max_sessions) {
      const oldestKey = this.findOldestSession()
      if (oldestKey) {
        this.sessions.delete(oldestKey)
        console.log(`[Session] Evicted oldest session: ${oldestKey}`)
      }
    }

    this.sessions.set(chatId, {
      opencodeSessionId,
      chatId,
      lastActivity: Date.now(),
    })
    console.log(`[Session] Created session mapping: ${chatId} -> ${opencodeSessionId}`)
  }

  updateActivity(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (session) {
      session.lastActivity = Date.now()
    }
  }

  deleteSession(chatId: string): void {
    this.sessions.delete(chatId)
    deleteChatState(chatId)
    console.log(`[Session] Deleted session for chat: ${chatId}`)
  }

  private findOldestSession(): string | null {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, session] of this.sessions.entries()) {
      if (session.lastActivity < oldestTime) {
        oldestTime = session.lastActivity
        oldestKey = key
      }
    }

    return oldestKey
  }

  getStats(): { total: number; sessions: Array<{ chatId: string; age: number }> } {
    const now = Date.now()
    return {
      total: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([chatId, session]) => ({
        chatId,
        age: Math.floor((now - session.lastActivity) / 1000),
      })),
    }
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export const sessionManager = new SessionManager()
