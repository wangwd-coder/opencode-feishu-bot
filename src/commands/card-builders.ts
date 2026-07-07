import { opencodeClient } from '../opencode.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { expandHome, shortenPath } from './path-utils.js'

// Permission card builder
export function buildPermissionCard(data: {
  requestId: string
  permissionType: string
  title: string
}): {
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} {
  return {
    title: `🔐 权限请求: ${data.permissionType}`,
    template: 'orange',
    content: data.title,
    buttons: [
      { text: '✅ 允许一次', value: `permission_reply:${data.requestId}:once` },
      { text: '✅ 始终允许', value: `permission_reply:${data.requestId}:always` },
      { text: '❌ 拒绝', value: `permission_reply:${data.requestId}:reject` },
    ],
  }
}

// Question card builder
export function buildQuestionCard(data: {
  requestId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiple?: boolean
    custom?: boolean
  }>
}): {
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} {
  const firstQ = data.questions[0]
  const header = firstQ?.header || '问题'
  const question = firstQ?.question || ''
  const options = firstQ?.options || [{ label: 'Yes' }, { label: 'No' }]
  const isCustom = firstQ?.custom ?? true // default to true for better UX

  // Build content with option descriptions
  let content = question
  if (options.some(o => o.description)) {
    content += '\n\n' + options.map((o, i) => `**${i + 1}. ${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n')
  }
  if (isCustom) {
    content += '\n\n💡 支持自定义回答：点击下方「自定义回答」按钮后，直接发送文字即可'
  }

  // Build buttons
  const buttons = options.slice(0, 5).map(opt => ({
    text: opt.label,
    value: `question_answer:${data.requestId}:${opt.label}`,
  }))

  // Add custom input button if allowed
  if (isCustom) {
    buttons.push({
      text: '💬 自定义回答',
      value: `question_custom:${data.requestId}`,
    })
  }

  // Always add skip button
  buttons.push({
    text: '⏭ 跳过',
    value: `question_answer:${data.requestId}:skip`,
  })

  return {
    title: `❓ ${header}`,
    template: 'blue',
    content,
    buttons,
  }
}

// Session expiry warning card builder
export function buildSessionExpiryCard(remainingSeconds: number): {
  title: string
  template: 'orange'
  content: string
  buttons: Array<{ text: string; value: string }>
} {
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const timeStr = minutes > 0 
    ? `${minutes} 分 ${seconds} 秒` 
    : `${seconds} 秒`
  
  return {
    title: '⏰ 会话即将到期',
    template: 'orange',
    content: `你的会话将在 **${timeStr}** 后自动断开。\n\n如需继续使用，请点击下方按钮续期。`,
    buttons: [
      { text: '🔄 续期会话', value: 'renew_session' },
    ],
  }
}

// CD panel card — show recent directories from sessions
export async function buildCdPanelCard(): Promise<{
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} | null> {
  try {
    const sessions = await opencodeClient.listSessions()
    // Extract unique directories from recent sessions (parallel fetch)
    const topSessions = sessions.slice(0, 10)
    const infos = await Promise.allSettled(
      topSessions.map(s => opencodeClient.getSession(s.id))
    )
    const dirs = new Map<string, number>()
    topSessions.forEach((s, i) => {
      const result = infos[i]
      if (result?.status === 'fulfilled' && result.value.directory && !dirs.has(result.value.directory)) {
        dirs.set(result.value.directory, s.time.updated)
      }
    })

    const entries = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) // max 4 + 1 custom = 5 buttons

    if (entries.length === 0) {
      return {
        title: '📁 切换目录',
        template: 'blue',
        content: '暂无可选目录\n\n输入 `/cd <路径>` 手动切换',
        buttons: [],
      }
    }

    const buttons = entries.map(([dir]) => {
      // Shorten home dir for button display
      const short = dir.replace(/^\/Users\/(\w+)/, '~')
      return {
        text: short.length > 25 ? '📁 ' + short.slice(-23) : '📁 ' + short,
        value: `cd_select:${dir}`,
      }
    })

    buttons.push({ text: '📝 手动输入路径', value: 'cd_custom' })

    // Rich content with paths and timestamps
    const now = Date.now()
    const content = entries.map(([dir], i) => {
      const short = dir.replace(/^\/Users\/(\w+)/, '~')
      const ts = Math.floor((now - entries[i][1]) / 60000)
      const timeStr = ts < 1 ? '刚刚' : ts < 60 ? `${ts}分钟前` : `${Math.floor(ts / 60)}小时前`
      return `${['❶','❷','❸','❹'][i]} \`${short}\`\n　　 ${timeStr}`
    }).join('\n\n')
    return {
      title: '📁 选择工作目录',
      template: 'blue',
      content: `点击按钮切换：\n\n${content}\n\n💡 也可点「手动输入」后直接发送路径`,
      buttons,
    }
  } catch {
    return {
      title: '📁 切换目录',
      template: 'orange',
      content: '无法获取目录列表\n\n输入 `/cd <路径>` 手动切换',
      buttons: [],
    }
  }
}

/**
 * Build an interactive directory browser card with pagination.
 * Lists subdirectories of the given path with clickable buttons.
 * 5-btn layout: ../ | subdir×3 | next/confirm
 * When subdirs > 3, shows paginated pages.
 */
export async function buildCdBrowserCard(rawPath: string, page = 0): Promise<{
  title: string
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  content: string
  buttons: Array<{ text: string; value: string }>
} | null> {
  // Resolve ~ and relative paths
  let resolved = expandHome(rawPath)
  resolved = path.resolve(resolved)

  const parentDir = path.dirname(resolved)
  const displayPath = shortenPath(resolved)

  // List subdirectories (skip hidden)
  let subdirs: string[] = []
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    subdirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch {
    return null // directory doesn't exist or no permission
  }

  const PER_PAGE = 3
  const totalPages = Math.ceil(subdirs.length / PER_PAGE) || 1
  const clampPage = Math.min(page, totalPages - 1)
  const start = clampPage * PER_PAGE
  const pageSubdirs = subdirs.slice(start, start + PER_PAGE)
  const isLast = clampPage >= totalPages - 1

  const buttons: Array<{ text: string; value: string }> = []

  // Always show ../ first
  buttons.push({ text: '📂 ../', value: `cd_browse:${parentDir}` })

  // Subdirectory buttons
  for (const name of pageSubdirs) {
    const displayName = name.length > 18 ? name.slice(0, 17) + '…' : name
    buttons.push({ text: `📁 ${displayName}`, value: `cd_browse:${path.join(resolved, name)}` })
  }

  // Last button: next page or confirm
  if (!isLast) {
    buttons.push({ text: `▶ 下一页 (${clampPage + 1}/${totalPages})`, value: `cd_browse:${resolved}:${clampPage + 1}` })
  } else {
    buttons.push({ text: '✅ 切换到此目录', value: `cd_select:${resolved}` })
  }

  // Content: show all subdirs for current page
  const pageInfo = totalPages > 1 ? `第 ${clampPage + 1}/${totalPages} 页` : ''
  const subdirLines = pageSubdirs.map((name, i) =>
    `${['❶','❷','❸'][i]} 📁 ${name}`
  ).join('\n')

  return {
    title: '📂 浏览目录',
    template: 'blue',
    content: `**当前:** \`${displayPath}\`\n\n📂 子目录 ${pageInfo}（共 ${subdirs.length} 个）：\n${subdirLines || '　（空目录）'}\n\n⬆️ 点 \`../\` 返回上级${!isLast ? `　▶ 点下一页查看更多` : ''}`,
    buttons,
  }
}
