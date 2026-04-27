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

interface WeChatConfig {
  enabled: boolean
  allowed_users: string[]  // empty array = allow all
  data_dir: string         // default: ./data/wechat
  api_base_url: string     // default: https://ilinkai.weixin.qq.com
  cdn_base_url: string     // default: https://cdn.ilinkai.weixin.qq.com
  poll_timeout: number     // default: 35 (seconds)
  api_timeout: number      // default: 15 (seconds)
}

interface SessionConfig {
  ttl: number
  max_sessions: number
  warning_before_ttl: number
}

interface StreamingConfig {
  update_interval: number
  min_chunk_size: number
}

export interface Config {
  feishu: FeishuConfig
  wechat: WeChatConfig  // NEW
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
  const parsed = parseYaml(expandedConfig) as any

  if (!parsed.feishu.app_id || !parsed.feishu.app_secret) {
    throw new Error('Missing LARK_APP_ID or LARK_APP_SECRET in environment variables')
  }

  // Set default WeChat config if missing
  const defaultWeChatConfig: WeChatConfig = {
    enabled: false,
    allowed_users: [],
    data_dir: './data/wechat',
    api_base_url: 'https://ilinkai.weixin.qq.com',
    cdn_base_url: 'https://cdn.ilinkai.weixin.qq.com',
    poll_timeout: 35,
    api_timeout: 15
  }

  // Merge with provided WeChat config if available
  const wechatConfig = parsed.wechat || {}
  
  // Handle allowed_users conversion from string to array if needed
  let allowedUsers: string[] = defaultWeChatConfig.allowed_users
  if (wechatConfig.allowed_users !== undefined) {
    if (typeof wechatConfig.allowed_users === 'string') {
      // Handle empty string or comma-separated string
      allowedUsers = wechatConfig.allowed_users.trim() === '' 
        ? [] 
        : wechatConfig.allowed_users.split(',').map((s: string) => s.trim()).filter((s: string) => s !== '')
    } else if (Array.isArray(wechatConfig.allowed_users)) {
      allowedUsers = wechatConfig.allowed_users
    }
  }
  
  const finalWeChatConfig: WeChatConfig = {
    enabled: wechatConfig.enabled ?? defaultWeChatConfig.enabled,
    allowed_users: allowedUsers,
    data_dir: wechatConfig.data_dir ?? defaultWeChatConfig.data_dir,
    api_base_url: wechatConfig.api_base_url ?? defaultWeChatConfig.api_base_url,
    cdn_base_url: wechatConfig.cdn_base_url ?? defaultWeChatConfig.cdn_base_url,
    poll_timeout: wechatConfig.poll_timeout ?? defaultWeChatConfig.poll_timeout,
    api_timeout: wechatConfig.api_timeout ?? defaultWeChatConfig.api_timeout
  }

  // Validate WeChat config only if enabled
  if (finalWeChatConfig.enabled) {
    // Add any WeChat-specific validation here if needed
    // For now, just ensure allowed_users is an array
    if (!Array.isArray(finalWeChatConfig.allowed_users)) {
      throw new Error('wechat.allowed_users must be an array')
    }
  }

  return {
    ...parsed,
    wechat: finalWeChatConfig
  } as Config
}

export const appConfig = loadConfig()
