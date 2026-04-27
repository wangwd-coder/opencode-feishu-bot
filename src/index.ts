import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env BEFORE importing config
config({ path: resolve(process.cwd(), '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

import { appConfig } from './config.js'
import { FeishuBot } from './bot.js'
import { WeChatBot } from './wechat/wechat-bot.js'

console.log('═'.repeat(50))
console.log('  OpenCode IM Bridge')
console.log('═'.repeat(50))
console.log(`  Feishu Domain: ${appConfig.feishu.domain}`)
console.log(`  WeChat Enabled: ${appConfig.wechat.enabled}`)
console.log(`  OpenCode Server: ${appConfig.opencode.server_url}`)
console.log('═'.repeat(50))

const bots: Array<{ stop: () => void }> = []

async function main(): Promise<void> {
  // Start Feishu bot
  try {
    const feishuBot = new FeishuBot()
    bots.push(feishuBot)
    await feishuBot.start()
  } catch (error) {
    console.error('[Main] Failed to start Feishu bot:', error)
    // Don't exit — WeChat might still work
  }

  // Start WeChat bot (if enabled)
  if (appConfig.wechat.enabled) {
    try {
      const wechatBot = new WeChatBot()
      bots.push(wechatBot)
      // WeChatBot.start() handles QR login internally
      wechatBot.start().catch((error) => {
        console.error('[Main] WeChat bot failed:', error)
      })
    } catch (error) {
      console.error('[Main] Failed to initialize WeChat bot:', error)
    }
  } else {
    console.log('[Main] WeChat bot is disabled (WECHAT_ENABLED=false)')
  }
}

function shutdown(): void {
  for (const bot of bots) {
    try {
      bot.stop()
    } catch {
      // Best-effort stop
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[Main] Received SIGINT, shutting down...')
  shutdown()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n[Main] Received SIGTERM, shutting down...')
  shutdown()
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error)
  shutdown()
  process.exit(1)
})

main()
