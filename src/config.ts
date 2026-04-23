import { config } from 'dotenv'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'fs'
import { resolve } from 'path'

config()

function expandEnvVars(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [varName, defaultVal] = expr.split(':').map((s: string) => s.trim())
    return process.env[varName] ?? defaultVal ?? ''
  })
}

interface FeishuConfig {
  app_id: string
  app_secret: string
  domain: 'feishu' | 'lark'
}

interface OpenCodeConfig {
  server_url: string
  username: string
  password: string
}

interface SessionConfig {
  ttl: number
  max_sessions: number
}

interface StreamingConfig {
  update_interval: number
  min_chunk_size: number
}

export interface Config {
  feishu: FeishuConfig
  opencode: OpenCodeConfig
  session: SessionConfig
  streaming: StreamingConfig
}

export function loadConfig(): Config {
  const configPath = resolve(process.cwd(), 'config/config.yaml')
  let rawConfig: string

  try {
    rawConfig = readFileSync(configPath, 'utf-8')
  } catch {
    throw new Error(`Config file not found at ${configPath}. Copy config/config.yaml.example to config/config.yaml and fill in your values.`)
  }

  const expandedConfig = expandEnvVars(rawConfig)
  const parsed = parseYaml(expandedConfig) as Config

  if (!parsed.feishu.app_id || !parsed.feishu.app_secret) {
    throw new Error('Missing LARK_APP_ID or LARK_APP_SECRET in environment variables')
  }

  return parsed
}

export const appConfig = loadConfig()
