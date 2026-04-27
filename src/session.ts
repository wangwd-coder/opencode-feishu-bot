import { appConfig } from './config.js'
import { deleteChatState } from './commands.js'

interface SessionInfo {
  opencodeSessionId: string
  chatId: string
  lastActivity: number
}

export type ExpiryWarningCallback = (chatId: string, remainingSeconds: number) => void

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null
  private warnedSessions: Set<string> = new Set() // Track sessions that have been warned
  private activeChats: Set<string> = new Set() // Track chats with active tasks
  private expiryWarningCallback: ExpiryWarningCallback | null = null

  constructor() {
    this.startCleanup()
  }

  setExpiryWarningCallback(callback: ExpiryWarningCallback): void {
    this.expiryWarningCallback = callback
  }

  /** Mark a chat as having an active task (prevent expiry warning) */
  markActive(chatId: string): void {
    this.activeChats.add(chatId)
  }

  /** Mark a chat as idle (allow expiry warning again) */
  markIdle(chatId: string): void {
    this.activeChats.delete(chatId)
  }

  /** Check if a chat has an active task */
  isActive(chatId: string): boolean {
    return this.activeChats.has(chatId)
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      const ttl = appConfig.session.ttl * 1000
      const warningTime = (appConfig.session.warning_before_ttl ?? 300) * 1000

      for (const [chatId, session] of this.sessions.entries()) {
        // Skip chats with active tasks
        if (this.activeChats.has(chatId)) {
          continue
        }

        const age = now - session.lastActivity
        
        // Check if session is expired
        if (age > ttl) {
          this.sessions.delete(chatId)
          deleteChatState(chatId)
          this.warnedSessions.delete(chatId)
          console.log(`[Session] Cleaned up expired session for chat: ${chatId}`)
        }
        // Check if session is about to expire (and hasn't been warned yet)
        else if (age > ttl - warningTime && !this.warnedSessions.has(chatId)) {
          this.warnedSessions.add(chatId)
          const remainingSeconds = Math.floor((ttl - age) / 1000)
          console.log(`[Session] Session expiring soon for chat: ${chatId}, remaining: ${remainingSeconds}s`)
          if (this.expiryWarningCallback) {
            this.expiryWarningCallback(chatId, remainingSeconds)
          }
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

    // Clear any previous state for this chatId to ensure clean start
    this.warnedSessions.delete(chatId)
    this.activeChats.delete(chatId)

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
      this.warnedSessions.delete(chatId) // Reset warning state on activity
    }
  }

  deleteSession(chatId: string): void {
    this.sessions.delete(chatId)
    this.warnedSessions.delete(chatId)
    this.activeChats.delete(chatId)
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

  getStats(): { total: number; active: number; sessions: Array<{ chatId: string; age: number; isActive: boolean }> } {
    const now = Date.now()
    return {
      total: this.sessions.size,
      active: this.activeChats.size,
      sessions: Array.from(this.sessions.entries()).map(([chatId, session]) => ({
        chatId,
        age: Math.floor((now - session.lastActivity) / 1000),
        isActive: this.activeChats.has(chatId),
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
