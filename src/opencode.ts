import { appConfig } from './config.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

interface ProviderModel {
  name: string
  id?: string
  modalities?: { input?: string[]; output?: string[] }
}

interface Provider {
  name: string
  models: Record<string, ProviderModel>
}

interface OpenCodeConfig {
  provider?: Record<string, Provider>
}

interface SessionCreateResponse {
  id: string
  title?: string
}

interface MessagePart {
  type: 'text'
  text: string
}

interface PromptResponse {
  id?: string
  parts: Array<{
    type: string
    text?: string
    tokens?: Record<string, unknown>
    reason?: string
  }>
  status?: string
  info?: unknown
}

export interface TokenStats {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

let lastTokenStats: TokenStats | null = null

export function getLastTokenStats(): TokenStats | null {
  return lastTokenStats
}

export class OpenCodeClient {
  private baseUrl: string
  private auth: { username: string; password: string }
  private modelsCache: Array<{ id: string; name: string; provider: string }> | null = null

  constructor() {
    this.baseUrl = appConfig.opencode.server_url
    this.auth = {
      username: appConfig.opencode.username,
      password: appConfig.opencode.password,
    }
    console.log(`[OpenCode] Configured: url=${this.baseUrl}, username=${this.auth.username}`)
  }

  // Get available models from OpenCode config (hide apiKey)
  getAvailableModels(): Array<{ id: string; name: string; provider: string }> {
    if (this.modelsCache) {
      return this.modelsCache
    }

    try {
      // Try to read OpenCode config from standard location
      const configPath = resolve(process.env.HOME || '~', '.config/opencode/opencode.json')
      const configContent = readFileSync(configPath, 'utf-8')
      
      // Parse but remove apiKey from any logging
      const config: OpenCodeConfig = JSON.parse(configContent)
      
      const models: Array<{ id: string; name: string; provider: string }> = []
      
      if (config.provider) {
        for (const [providerId, provider] of Object.entries(config.provider)) {
          if (provider.models) {
            for (const [modelKey, modelInfo] of Object.entries(provider.models)) {
              const modelId = modelInfo.id || modelKey
              
              // 如果 modelId 已经包含前缀（如 vertex/xxx），直接使用
              // 否则拼接 providerId/modelId
              const fullId = modelId.includes('/') ? modelId : `${providerId}/${modelId}`
              
              models.push({
                id: fullId,
                name: modelInfo.name || modelKey,
                provider: provider.name || providerId,
              })
            }
          }
        }
      }
      
      this.modelsCache = models
      console.log(`[OpenCode] Loaded ${models.length} models from config (apiKey hidden)`)
      return models
      
    } catch (error) {
      console.warn('[OpenCode] Could not load models from config, using defaults')
      // Return default models if config not found
      return [
        { id: 'genstudio-anthropic/glm-5', name: 'GLM-5', provider: 'GenStudio' },
        { id: 'genstudio-anthropic/glm-5.1', name: 'GLM-5.1', provider: 'GenStudio' },
        { id: 'genstudio-openai/deepseek-v3.2', name: 'DeepSeek V3', provider: 'GenStudio' },
        { id: 'genstudio-openai/kimi-k2.5', name: 'Kimi K2', provider: 'GenStudio' },
      ]
    }
  }

  // Get models as simple list for display
  getModelList(): Array<{ id: string; name: string }> {
    return this.getAvailableModels().map(m => ({
      id: m.id,
      name: m.name,
    }))
  }

  private async request<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
      timeoutMs?: number
      retries?: number
    } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const authStr = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')
    headers['Authorization'] = `Basic ${authStr}`

    const maxRetries = options.retries ?? 2
    const timeoutMs = options.timeoutMs ?? 300_000

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      console.log(`[OpenCode] Request: ${options.method || 'GET'} ${path}${attempt > 0 ? ` (retry ${attempt})` : ''}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => {
        console.log(`[OpenCode] Request timeout after ${timeoutMs}ms: ${options.method || 'GET'} ${path}`)
        controller.abort()
      }, timeoutMs)

      try {
        const response = await fetch(url, {
          method: options.method || 'GET',
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const text = await response.text()
          // Don't retry 4xx errors
          if (response.status >= 400 && response.status < 500) {
            console.error(`[OpenCode] Client error: ${response.status} - ${text}`)
            throw new Error(`OpenCode API error: ${response.status} - ${text}`)
          }
          // Retry 5xx errors
          if (attempt < maxRetries) {
            console.warn(`[OpenCode] Server error ${response.status}, retrying in ${(attempt + 1) * 1000}ms...`)
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
            continue
          }
          console.error(`[OpenCode] Error after ${maxRetries + 1} attempts: ${response.status} - ${text}`)
          throw new Error(`OpenCode API error: ${response.status} - ${text}`)
        }

        return response.json() as Promise<T>
      } catch (error) {
        clearTimeout(timeoutId)
        // Retry on network errors (AbortError from timeout, TypeError from fetch)
        if (attempt < maxRetries && (error instanceof TypeError || (error as any)?.name === 'AbortError')) {
          console.warn(`[OpenCode] Network error, retrying in ${(attempt + 1) * 1000}ms:`, (error as Error).message)
          await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
          continue
        }
        throw error
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error('Request failed after all retries')
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('/global/health')
      return true
    } catch {
      return false
    }
  }

  async createSession(title?: string): Promise<string> {
    const response = await this.request<SessionCreateResponse>('/session', {
      method: 'POST',
      body: { title: title || 'Feishu Bot Session' },
    })
    return response.id
  }

  async sendMessage(sessionId: string, text: string, model?: string | null, agent?: string | null): Promise<string> {
    console.log(`[OpenCode] Sending message to session ${sessionId}`)
    const parts: MessagePart[] = [{ type: 'text', text }]

    const body: { parts: MessagePart[]; modelID?: string; agentID?: string } = { parts }
    if (model) {
      body.modelID = model
      console.log(`[OpenCode] Using modelID: ${model}`)
    }
    if (agent) {
      body.agentID = agent
      console.log(`[OpenCode] Using agentID: ${agent}`)
    }

    const response = await this.request<PromptResponse>(
      `/session/${sessionId}/message`,
      {
        method: 'POST',
        body,
      }
    )

    const textParts = response.parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n')

    console.log(`[OpenCode] Got response: ${textParts.length} chars`)
    return textParts
  }

  async *streamMessage(
    sessionId: string,
    text: string,
    model?: string | null,
    agent?: string | null,
    onToken?: (token: string) => void
  ): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/session/${sessionId}/message`
    const authStr = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')

    console.log(`[OpenCode] Stream request: POST /session/${sessionId}/message`)

    const parts: MessagePart[] = [{ type: 'text', text }]

    const requestBody: { parts: MessagePart[]; stream: boolean; modelID?: string; agentID?: string } = { parts, stream: true }
    if (model) {
      requestBody.modelID = model
      console.log(`[OpenCode] Using modelID: ${model}`)
    }
    if (agent) {
      requestBody.agentID = agent
      console.log(`[OpenCode] Using agentID: ${agent}`)
    }

    // Add timeout for the request
    const timeoutMs = 900_000 // 15 minutes — OpenCode may run long tool calls (git clone, builds, etc.)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      console.log(`[OpenCode] Stream timeout after ${timeoutMs}ms`)
      controller.abort()
    }, timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authStr}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OpenCode] Stream error: ${response.status} - ${errorText}`)
      throw new Error(`OpenCode stream error: ${response.status} - ${errorText}`)
    }

    const contentType = response.headers.get('content-type') || ''
    console.log(`[OpenCode] Response content-type: ${contentType}`)
    
    // If response is JSON (not SSE), parse directly
    if (contentType.includes('application/json')) {
      const data = await response.json() as { parts?: Array<Record<string, unknown>>; info?: unknown }
      console.log(`[OpenCode] Got JSON response`)
      
      // Extract token stats from step-finish
      if (data.parts) {
        for (const part of data.parts) {
          if (part.type === 'step-finish' && part.tokens) {
            const tokens = part.tokens as Record<string, unknown>
            const cache = (tokens.cache || {}) as Record<string, number>
            lastTokenStats = {
              input: (tokens.input as number) || 0,
              output: (tokens.output as number) || 0,
              reasoning: (tokens.reasoning as number) || 0,
              cacheRead: cache.read || 0,
              cacheWrite: cache.write || 0,
              total: (tokens.total as number) || 0,
            }
            console.log(`[OpenCode] Token stats: in=${lastTokenStats.input}, out=${lastTokenStats.output}, total=${lastTokenStats.total}`)
          }
        }
        // Yield text content
        for (const part of data.parts) {
          if (part.type === 'text' && part.text) {
            console.log(`[OpenCode] Text part: ${(part.text as string).substring(0, 50)}...`)
            if (onToken) onToken(part.text as string)
            yield part.text as string
            return
          }
        }
      }
      console.log(`[OpenCode] No text part found in response`)
      return
    }

    // SSE streaming mode
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    console.log(`[OpenCode] Starting SSE stream read`)

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.log(`[OpenCode] Stream done, total text: ${fullText.length} chars`)
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'text' && parsed.text) {
              fullText += parsed.text
              if (onToken) onToken(parsed.text)
              yield parsed.text
            } else if (parsed.parts) {
              for (const part of parsed.parts) {
                if (part.type === 'text' && part.text) {
                  const chunk = part.text.slice(fullText.length)
                  if (chunk) {
                    fullText = part.text
                    if (onToken) onToken(chunk)
                    yield chunk
                  }
                }
              }
            }
          } catch (parseError) {
            console.warn(`[OpenCode] SSE parse error for line: ${data.substring(0, 100)}`, parseError)
          }
        }
      }
    }

    return
  }

  async listSessions(): Promise<Array<{ id: string; title: string; slug: string; time: { created: number; updated: number } }>> {
    return this.request('/session')
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.request(`/session/${sessionId}`, {
      method: 'PATCH',
      body: { title },
    })
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, {
      method: 'POST',
    })
  }

  async getAgents(): Promise<Array<{ name: string; mode: string }>> {
    return this.request('/agent')
  }

  async summarizeSession(sessionId: string, providerID: string, modelID: string): Promise<void> {
    await this.request(`/session/${sessionId}/summarize`, {
      method: 'POST',
      body: { providerID, modelID },
    })
  }

  /** Poll the latest assistant message to check execution progress */
  async getSessionProgress(sessionId: string): Promise<{ status: string; toolName?: string; toolInput?: Record<string, unknown> } | null> {
    try {
      const messages = await this.request<Array<{ parts?: Array<Record<string, unknown>> }>>(`/session/${sessionId}/message`, { retries: 0, timeoutMs: 10_000 })
      if (!messages || messages.length === 0) return null

      const lastMsg = messages[messages.length - 1]
      const parts = lastMsg.parts || []

      // Find any running tool
      for (const part of parts) {
        if (part.type === 'tool') {
          const state = part.state as Record<string, unknown> | undefined
          if (state?.status === 'running') {
            const input = state.input as Record<string, unknown> | undefined
            return {
              status: 'running',
              toolName: part.tool as string,
              toolInput: input,
            }
          }
        }
      }

      // Check if there's a step-start without step-finish (still processing)
      const hasStepStart = parts.some(p => p.type === 'step-start')
      const hasStepFinish = parts.some(p => p.type === 'step-finish')
      if (hasStepStart && !hasStepFinish) {
        return { status: 'thinking' }
      }

      return { status: 'idle' }
    } catch {
      return null
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}`, { method: 'DELETE' })
  }
}

export const opencodeClient = new OpenCodeClient()
