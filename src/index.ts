import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env BEFORE importing config
config({ path: resolve(process.cwd(), '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

import { appConfig } from './config.js'
import { FeishuBot } from './bot.js'

console.log('═'.repeat(50))
console.log('  OpenCode Feishu Bot')
console.log('═'.repeat(50))
console.log(`  Feishu Domain: ${appConfig.feishu.domain}`)
console.log(`  OpenCode Server: ${appConfig.opencode.server_url}`)
console.log('═'.repeat(50))

const bot = new FeishuBot()

async function main(): Promise<void> {
  try {
    await bot.start()
  } catch (error) {
    console.error('[Main] Failed to start bot:', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => {
  console.log('\n[Main] Received SIGINT, shutting down...')
  bot.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n[Main] Received SIGTERM, shutting down...')
  bot.stop()
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error)
  bot.stop()
  process.exit(1)
})

main()
