import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock deleteChatState before importing session
const deleteChatStateMock = vi.fn()
vi.mock('../src/commands.js', () => ({
  deleteChatState: (...args: unknown[]) => deleteChatStateMock(...args),
}))

// Mock config with default values (will be overridden in some tests)
vi.mock('../src/config.js', () => ({
  appConfig: {
    session: {
      ttl: 60, // 60 seconds
      max_sessions: 5,
      warning_before_ttl: 5, // 5 seconds
    },
  },
}))

// Mock console.log to avoid noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

// Need to import after mocks are set up
import { SessionManager } from '../src/session.js'

describe('SessionManager', () => {
  let sessionManager: InstanceType<typeof SessionManager>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    deleteChatStateMock.mockClear()
    // Create a fresh instance for each test to ensure isolation
    sessionManager = new SessionManager()
  })

  afterEach(() => {
    sessionManager.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('getSession/setSession', () => {
    it('getSession returns undefined for non-existent chat', () => {
      const result = sessionManager.getSession('non-existent-chat-id')
      expect(result).toBeUndefined()
    })

    it('setSession creates mapping and getSession returns it', () => {
      const chatId = 'chat-123'
      const opencodeSessionId = 'opencode-session-456'

      sessionManager.setSession(chatId, opencodeSessionId)

      const result = sessionManager.getSession(chatId)
      expect(result).toBeDefined()
      expect(result?.chatId).toBe(chatId)
      expect(result?.opencodeSessionId).toBe(opencodeSessionId)
      expect(result?.lastActivity).toBeTypeOf('number')
    })

    it('setSession overwrites existing session for same chatId', () => {
      const chatId = 'chat-123'
      const firstSessionId = 'opencode-session-1'
      const secondSessionId = 'opencode-session-2'

      sessionManager.setSession(chatId, firstSessionId)
      sessionManager.setSession(chatId, secondSessionId)

      const result = sessionManager.getSession(chatId)
      expect(result?.opencodeSessionId).toBe(secondSessionId)
    })

    it('setSession sets lastActivity to current time', () => {
      const now = 1000000
      vi.setSystemTime(now)

      sessionManager.setSession('chat-1', 'session-1')

      const result = sessionManager.getSession('chat-1')
      expect(result?.lastActivity).toBe(now)
    })
  })

  describe('updateActivity', () => {
    it('updates lastActivity timestamp for existing session', () => {
      const chatId = 'chat-123'
      const initialTime = 1000000
      vi.setSystemTime(initialTime)

      sessionManager.setSession(chatId, 'session-1')
      expect(sessionManager.getSession(chatId)?.lastActivity).toBe(initialTime)

      // Advance time
      const newTime = 2000000
      vi.setSystemTime(newTime)
      sessionManager.updateActivity(chatId)

      expect(sessionManager.getSession(chatId)?.lastActivity).toBe(newTime)
    })

    it('does nothing for non-existent chat', () => {
      // Should not throw
      expect(() => sessionManager.updateActivity('non-existent-chat')).not.toThrow()
    })
  })

  describe('deleteSession', () => {
    it('removes the session', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      expect(sessionManager.getSession(chatId)).toBeDefined()

      sessionManager.deleteSession(chatId)

      expect(sessionManager.getSession(chatId)).toBeUndefined()
    })

    it('calls deleteChatState when deleting session', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      sessionManager.deleteSession(chatId)

      expect(deleteChatStateMock).toHaveBeenCalledWith(chatId)
    })

    it('does not throw when deleting non-existent session', () => {
      expect(() => sessionManager.deleteSession('non-existent')).not.toThrow()
    })
  })

  describe('TTL cleanup', () => {
    it('does not clean up sessions within TTL', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      // Advance time but stay within TTL (60 seconds)
      vi.advanceTimersByTime(59999)

      // Trigger cleanup manually by advancing past interval
      vi.advanceTimersByTime(1) // Now at 60000ms total

      // Session should still exist (cleanup interval runs but session is not expired)
      expect(sessionManager.getSession(chatId)).toBeDefined()
    })

    it('cleans up sessions older than TTL', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      // Advance time past TTL (60 seconds) + cleanup interval check
      vi.advanceTimersByTime(61000) // 61 seconds

      // Session should still exist (cleanup hasn't run yet, interval is 60s)
      expect(sessionManager.getSession(chatId)).toBeDefined()

      // Trigger the cleanup by advancing another full interval
      vi.advanceTimersByTime(60000) // Total: 121 seconds, well past TTL

      // Now session should be cleaned up
      expect(sessionManager.getSession(chatId)).toBeUndefined()
    })

    it('calls deleteChatState when cleaning up expired session', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      deleteChatStateMock.mockClear()

      // Advance past TTL and trigger cleanup
      vi.advanceTimersByTime(121000) // 121 seconds

      expect(deleteChatStateMock).toHaveBeenCalledWith(chatId)
    })

    it('only cleans up expired sessions, keeps active ones', () => {
      const oldChatId = 'old-chat'
      const newChatId = 'new-chat'

      // Create first session
      vi.setSystemTime(0)
      sessionManager.setSession(oldChatId, 'session-old')

      // Create second session later
      vi.setSystemTime(65000) // 65 seconds later
      sessionManager.setSession(newChatId, 'session-new')

      // Trigger cleanup (first session should be expired)
      vi.advanceTimersByTime(60000) // Total time: 125000ms

      // Old session should be cleaned up (created at 0, TTL is 60s)
      expect(sessionManager.getSession(oldChatId)).toBeUndefined()
      // New session should still exist (created at 65s, now at 125s, age is 60s, still within TTL)
      expect(sessionManager.getSession(newChatId)).toBeDefined()
    })

    it('cleanup interval runs every 60 seconds', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      // First cleanup (after 60s interval) - session is still fresh
      vi.advanceTimersByTime(60000)
      expect(sessionManager.getSession(chatId)).toBeDefined()

      // Second cleanup (after 120s total) - session should be expired (TTL is 60s)
      vi.advanceTimersByTime(60000)
      expect(sessionManager.getSession(chatId)).toBeUndefined()
    })
  })

  describe('max_sessions eviction', () => {
    it('evicts oldest session when max_sessions is reached', () => {
      // max_sessions is 5 (from mock)
      // Create 5 sessions with different timestamps
      vi.setSystemTime(1000)
      sessionManager.setSession('chat-1', 'session-1')

      vi.setSystemTime(2000)
      sessionManager.setSession('chat-2', 'session-2')

      vi.setSystemTime(3000)
      sessionManager.setSession('chat-3', 'session-3')

      vi.setSystemTime(4000)
      sessionManager.setSession('chat-4', 'session-4')

      vi.setSystemTime(5000)
      sessionManager.setSession('chat-5', 'session-5')

      // All 5 sessions should exist
      expect(sessionManager.getStats().total).toBe(5)

      // Add 6th session, should evict oldest (chat-1)
      vi.setSystemTime(6000)
      sessionManager.setSession('chat-6', 'session-6')

      // Still 5 sessions
      expect(sessionManager.getStats().total).toBe(5)

      // Oldest should be evicted
      expect(sessionManager.getSession('chat-1')).toBeUndefined()
      expect(sessionManager.getSession('chat-2')).toBeDefined()
      expect(sessionManager.getSession('chat-3')).toBeDefined()
      expect(sessionManager.getSession('chat-4')).toBeDefined()
      expect(sessionManager.getSession('chat-5')).toBeDefined()
      expect(sessionManager.getSession('chat-6')).toBeDefined()
    })

    it('new session is added successfully after eviction', () => {
      // Fill up to max_sessions
      for (let i = 1; i <= 5; i++) {
        vi.setSystemTime(i * 1000)
        sessionManager.setSession(`chat-${i}`, `session-${i}`)
      }

      // Add new session
      vi.setSystemTime(10000)
      sessionManager.setSession('chat-new', 'session-new')

      // New session should be retrievable
      const result = sessionManager.getSession('chat-new')
      expect(result).toBeDefined()
      expect(result?.opencodeSessionId).toBe('session-new')
    })

    it('evicts correct session when activities are updated', () => {
      // Create sessions
      vi.setSystemTime(1000)
      sessionManager.setSession('chat-1', 'session-1')

      vi.setSystemTime(2000)
      sessionManager.setSession('chat-2', 'session-2')

      vi.setSystemTime(3000)
      sessionManager.setSession('chat-3', 'session-3')

      vi.setSystemTime(4000)
      sessionManager.setSession('chat-4', 'session-4')

      vi.setSystemTime(5000)
      sessionManager.setSession('chat-5', 'session-5')

      // Update activity of chat-1 to make it newer
      vi.setSystemTime(6000)
      sessionManager.updateActivity('chat-1')

      // Add new session, chat-2 should be evicted (now oldest)
      vi.setSystemTime(7000)
      sessionManager.setSession('chat-6', 'session-6')

      // chat-1 should still exist (was updated)
      expect(sessionManager.getSession('chat-1')).toBeDefined()
      // chat-2 should be evicted (now oldest)
      expect(sessionManager.getSession('chat-2')).toBeUndefined()
    })

    it('does not evict when below max_sessions', () => {
      // Create 3 sessions (less than max_sessions of 5)
      for (let i = 1; i <= 3; i++) {
        sessionManager.setSession(`chat-${i}`, `session-${i}`)
      }

      // All should exist
      expect(sessionManager.getSession('chat-1')).toBeDefined()
      expect(sessionManager.getSession('chat-2')).toBeDefined()
      expect(sessionManager.getSession('chat-3')).toBeDefined()
      expect(sessionManager.getStats().total).toBe(3)
    })
  })

  describe('getStats', () => {
    it('returns correct count for empty sessions', () => {
      const stats = sessionManager.getStats()
      expect(stats.total).toBe(0)
      expect(stats.sessions).toEqual([])
    })

    it('returns correct count and age information', () => {
      vi.setSystemTime(10000)
      sessionManager.setSession('chat-1', 'session-1')

      vi.setSystemTime(20000)
      sessionManager.setSession('chat-2', 'session-2')

      // Check stats at time 35000
      vi.setSystemTime(35000)
      const stats = sessionManager.getStats()

      expect(stats.total).toBe(2)
      expect(stats.sessions).toHaveLength(2)

      // Find each session in stats
      const chat1Stats = stats.sessions.find((s) => s.chatId === 'chat-1')
      const chat2Stats = stats.sessions.find((s) => s.chatId === 'chat-2')

      expect(chat1Stats?.age).toBe(25) // 35000 - 10000 = 25000ms = 25s
      expect(chat2Stats?.age).toBe(15) // 35000 - 20000 = 15000ms = 15s
    })

    it('updates age correctly as time passes', () => {
      vi.setSystemTime(1000)
      sessionManager.setSession('chat-1', 'session-1')

      vi.setSystemTime(5000)
      let stats = sessionManager.getStats()
      expect(stats.sessions[0]?.age).toBe(4)

      vi.setSystemTime(10000)
      stats = sessionManager.getStats()
      expect(stats.sessions[0]?.age).toBe(9)
    })
  })

  describe('stop', () => {
    it('clears the cleanup interval', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')

      // Stop the session manager
      sessionManager.stop()

      // Advance time well past TTL and interval
      vi.advanceTimersByTime(180000) // 3 minutes

      // Session should still exist because cleanup was stopped
      expect(sessionManager.getSession(chatId)).toBeDefined()
    })

    it('can be called multiple times without error', () => {
      expect(() => {
        sessionManager.stop()
        sessionManager.stop()
        sessionManager.stop()
      }).not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('handles rapid setSession/deleteSession operations', () => {
      for (let i = 0; i < 100; i++) {
        sessionManager.setSession(`chat-${i}`, `session-${i}`)
        sessionManager.deleteSession(`chat-${i}`)
      }

      expect(sessionManager.getStats().total).toBe(0)
    })

    it('handles updateActivity before setSession gracefully', () => {
      expect(() => {
        sessionManager.updateActivity('non-existent-chat')
      }).not.toThrow()
    })

    it('handles deleteSession before setSession gracefully', () => {
      expect(() => {
        sessionManager.deleteSession('non-existent-chat')
      }).not.toThrow()
    })
  })

  describe('active task tracking', () => {
    it('markActive and markIdle track active chats', () => {
      const chatId = 'chat-123'
      expect(sessionManager.isActive(chatId)).toBe(false)
      
      sessionManager.markActive(chatId)
      expect(sessionManager.isActive(chatId)).toBe(true)
      
      sessionManager.markIdle(chatId)
      expect(sessionManager.isActive(chatId)).toBe(false)
    })

    it('does not cleanup session when marked as active', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')
      
      // Mark as active (simulating a long-running task)
      sessionManager.markActive(chatId)
      
      // Advance past TTL + cleanup interval
      vi.advanceTimersByTime(121000) // 121 seconds
      
      // Session should still exist because it's active
      expect(sessionManager.getSession(chatId)).toBeDefined()
    })

    it('does not send expiry warning when marked as active', () => {
      const chatId = 'chat-123'
      const warningCallback = vi.fn()
      sessionManager.setExpiryWarningCallback(warningCallback)
      
      sessionManager.setSession(chatId, 'session-1')
      sessionManager.markActive(chatId)
      
      // Advance past warning time (TTL is 60s, warning is at 55s based on config)
      // Warning time in mock is TTL - 5 seconds = 55 seconds
      vi.advanceTimersByTime(60000)
      
      // No warning should be sent for active session
      expect(warningCallback).not.toHaveBeenCalled()
    })

    it('deleteSession clears active state', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')
      sessionManager.markActive(chatId)
      
      expect(sessionManager.isActive(chatId)).toBe(true)
      
      sessionManager.deleteSession(chatId)
      
      expect(sessionManager.isActive(chatId)).toBe(false)
    })

    it('getStats includes active status', () => {
      const chatId = 'chat-123'
      sessionManager.setSession(chatId, 'session-1')
      
      let stats = sessionManager.getStats()
      expect(stats.active).toBe(0)
      expect(stats.sessions[0]?.isActive).toBe(false)
      
      sessionManager.markActive(chatId)
      
      stats = sessionManager.getStats()
      expect(stats.active).toBe(1)
      expect(stats.sessions[0]?.isActive).toBe(true)
    })
  })

  describe('advanced scenarios', () => {
    describe('scenario 1: task execution exceeds TTL', () => {
      it('should not cleanup session when task runs longer than TTL', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Simulate task running for 5 minutes (way past TTL of 60s)
        vi.advanceTimersByTime(300000) // 5 minutes
        
        // Session should still exist
        expect(sessionManager.getSession(chatId)).toBeDefined()
        
        // No warning should have been sent
        expect(warningCallback).not.toHaveBeenCalled()
        
        // Session should still be marked as active
        expect(sessionManager.isActive(chatId)).toBe(true)
      })

      it('should not cleanup session even after multiple cleanup cycles', () => {
        const chatId = 'chat-123'
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Run through multiple cleanup cycles (each 60s)
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(60000)
        }
        
        // Session should still exist after 10 minutes
        expect(sessionManager.getSession(chatId)).toBeDefined()
        expect(sessionManager.isActive(chatId)).toBe(true)
      })
    })

    describe('scenario 2: user executes /clear during task execution', () => {
      it('should start with clean state when new session is created during active task', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create initial session and mark as active
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Simulate time passing and warning being sent
        vi.advanceTimersByTime(60000) // Trigger warning time
        
        // Session is active, so no warning
        expect(warningCallback).not.toHaveBeenCalled()
        
        // User executes /clear - creates a new session
        const newSessionId = 'session-2'
        sessionManager.setSession(chatId, newSessionId)
        
        // New session should exist with new ID
        const session = sessionManager.getSession(chatId)
        expect(session?.opencodeSessionId).toBe(newSessionId)
        
        // Active state should be cleared (new clean state)
        expect(sessionManager.isActive(chatId)).toBe(false)
        
        // Should be able to mark active again for new task
        sessionManager.markActive(chatId)
        expect(sessionManager.isActive(chatId)).toBe(true)
      })

      it('should clear warned state when creating new session', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session and let it get close to expiry
        sessionManager.setSession(chatId, 'session-1')
        // Cleanup runs every 60s, so advance 60s to trigger first cleanup
        // At t=60s, age=60s which is > ttl-warningTime (55s), so warning is sent
        vi.advanceTimersByTime(60000)
        
        // Warning should have been sent
        expect(warningCallback).toHaveBeenCalledTimes(1)
        
        // User creates new session (via /clear)
        sessionManager.setSession(chatId, 'session-2')
        
        // Advance time to trigger next cleanup (another 60s)
        vi.advanceTimersByTime(60000)
        
        // Warning should be sent again for new session (warned state was cleared)
        expect(warningCallback).toHaveBeenCalledTimes(2)
      })
    })

    describe('scenario 3: user executes /stop during task execution', () => {
      it('should clear active state correctly after abort', () => {
        const chatId = 'chat-123'
        
        // Create session and mark as active
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        expect(sessionManager.isActive(chatId)).toBe(true)
        
        // User executes /stop - mark as idle
        sessionManager.markIdle(chatId)
        
        // Active state should be cleared
        expect(sessionManager.isActive(chatId)).toBe(false)
        
        // Session should still exist
        expect(sessionManager.getSession(chatId)).toBeDefined()
      })

      it('should allow cleanup after abort when session is idle', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session and mark as active
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Advance time past TTL while active (should not cleanup)
        vi.advanceTimersByTime(120000) // 2 minutes
        expect(sessionManager.getSession(chatId)).toBeDefined()
        
        // User executes /stop - mark as idle
        sessionManager.markIdle(chatId)
        
        // Now session should be expired, cleanup should work
        vi.advanceTimersByTime(60000) // Trigger cleanup
        
        // Session should be cleaned up now
        expect(sessionManager.getSession(chatId)).toBeUndefined()
      })

      it('should allow warning to be sent after abort', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session and mark as active
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Advance to first cleanup (60s) while active
        vi.advanceTimersByTime(60000)
        expect(warningCallback).not.toHaveBeenCalled()
        
        // User executes /stop - mark as idle
        sessionManager.markIdle(chatId)
        
        // Create fresh session to test warning
        sessionManager.setSession(chatId, 'session-2')
        // Advance to trigger cleanup (60s), which will send warning
        vi.advanceTimersByTime(60000)
        
        // Warning should now be sent
        expect(warningCallback).toHaveBeenCalledTimes(1)
      })
    })

    describe('scenario 4: multiple messages sent during task execution', () => {
      it('should maintain active state correctly while processing queued messages', () => {
        const chatId = 'chat-123'
        
        // Create session
        sessionManager.setSession(chatId, 'session-1')
        
        // First message starts task
        sessionManager.markActive(chatId)
        expect(sessionManager.isActive(chatId)).toBe(true)
        
        // Simulate queue: while processing first message, second message arrives
        // The session should remain active
        sessionManager.updateActivity(chatId) // Second message updates activity
        expect(sessionManager.isActive(chatId)).toBe(true)
        
        // Third message arrives
        sessionManager.updateActivity(chatId)
        expect(sessionManager.isActive(chatId)).toBe(true)
        
        // Task completes - mark idle
        sessionManager.markIdle(chatId)
        expect(sessionManager.isActive(chatId)).toBe(false)
      })

      it('should not lose active state when updating activity', () => {
        const chatId = 'chat-123'
        
        sessionManager.setSession(chatId, 'session-1')
        sessionManager.markActive(chatId)
        
        // Update activity (simulating new message in queue)
        sessionManager.updateActivity(chatId)
        
        // Active state should persist
        expect(sessionManager.isActive(chatId)).toBe(true)
        
        // Session should not be cleaned up
        vi.advanceTimersByTime(120000)
        expect(sessionManager.getSession(chatId)).toBeDefined()
      })

      it('should correctly handle active state across multiple chats', () => {
        const chat1 = 'chat-1'
        const chat2 = 'chat-2'
        
        // Both chats have sessions
        sessionManager.setSession(chat1, 'session-1')
        sessionManager.setSession(chat2, 'session-2')
        
        // Only chat1 is active
        sessionManager.markActive(chat1)
        
        expect(sessionManager.isActive(chat1)).toBe(true)
        expect(sessionManager.isActive(chat2)).toBe(false)
        
        // Advance time past TTL
        vi.advanceTimersByTime(120000)
        
        // chat2 should be cleaned up (idle and expired)
        expect(sessionManager.getSession(chat2)).toBeUndefined()
        
        // chat1 should still exist (active)
        expect(sessionManager.getSession(chat1)).toBeDefined()
        
        // Mark chat1 idle
        sessionManager.markIdle(chat1)
        vi.advanceTimersByTime(60000)
        
        // Now chat1 should be cleaned up
        expect(sessionManager.getSession(chat1)).toBeUndefined()
      })
    })

    describe('scenario 5: renewal button clicked', () => {
      it('should clear warnedSessions and not send duplicate warnings', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session
        sessionManager.setSession(chatId, 'session-1')
        
        // Advance to first cleanup (60s) - at this point age > ttl-warningTime, warning sent
        vi.advanceTimersByTime(60000)
        
        // Warning should be sent
        expect(warningCallback).toHaveBeenCalledTimes(1)
        expect(warningCallback).toHaveBeenCalledWith(chatId, expect.any(Number))
        
        // User clicks renewal button - updates activity
        sessionManager.updateActivity(chatId)
        
        // Advance to next cleanup (another 60s) - will check again
        vi.advanceTimersByTime(60000)
        
        // Warning should be sent again (warned state was cleared by updateActivity)
        expect(warningCallback).toHaveBeenCalledTimes(2)
      })

      it('should not send warning multiple times for same session without renewal', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session
        sessionManager.setSession(chatId, 'session-1')
        
        // Advance to first cleanup (60s) - warning sent
        vi.advanceTimersByTime(60000)
        expect(warningCallback).toHaveBeenCalledTimes(1)
        
        // Continue advancing without renewal - another cleanup cycle
        vi.advanceTimersByTime(60000)
        
        // Should not send another warning (already warned)
        expect(warningCallback).toHaveBeenCalledTimes(1)
      })

      it('should reset warning timer after renewal button click', () => {
        const chatId = 'chat-123'
        const warningCallback = vi.fn()
        sessionManager.setExpiryWarningCallback(warningCallback)
        
        // Create session
        sessionManager.setSession(chatId, 'session-1')
        
        // Get first warning at first cleanup (60s)
        vi.advanceTimersByTime(60000)
        expect(warningCallback).toHaveBeenCalledTimes(1)
        
        // User clicks renewal
        sessionManager.updateActivity(chatId)
        
        // Advance to next cleanup (60s from renewal) - should send warning again
        vi.advanceTimersByTime(60000)
        expect(warningCallback).toHaveBeenCalledTimes(2)
      })
    })
  })
})