import { CommandResult } from '../commands.js'

const WECHAT_MAX_LEN = 1800

// ─── Markdown stripping ────────────────────────────────────────────────────────

/**
 * Strip Markdown formatting for plain-text WeChat messages.
 * - **bold** → bold
 * - `code` → code
 * - [link](url) → link
 * - \n → preserved
 */
export function stripMarkdown(text: string): string {
  return text
    // **bold** → bold (greedy to handle nested/adjacent)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // *italic* → italic (single asterisk, not inside word boundaries)
    .replace(/\*(.+?)\*/g, '$1')
    // `inline code` → code
    .replace(/`(.+?)`/g, '$1')
    // ```code block``` → code block (without backticks)
    .replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```\w*\n?/g, '').replace(/```/g, '').trim()
    })
    // [link](url) → link
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove remaining standalone backticks
    .replace(/`/g, '')
}

// ─── Core renderer ─────────────────────────────────────────────────────────────

/**
 * Convert a CommandResult's cardData to plain text for WeChat.
 * Strips Markdown formatting and renders buttons as numbered options.
 */
export function renderCommandAsText(result: CommandResult): string {
  if (result.response) {
    return stripMarkdown(result.response)
  }

  if (!result.cardData) {
    return ''
  }

  const { title, content, buttons } = result.cardData
  const parts: string[] = []

  if (title) {
    parts.push(stripMarkdown(title))
  }

  const strippedContent = content ? stripMarkdown(content) : ''
  if (strippedContent) {
    parts.push(strippedContent)
  }

  if (buttons && buttons.length > 0) {
    const optionLines = buttons
      .map((btn, i) => `${i + 1}. ${stripMarkdown(btn.text)}`)
      .join('\n')
    parts.push(optionLines)
  }

  return parts.join('\n\n')
}

// ─── Permission renderer ───────────────────────────────────────────────────────

/**
 * Render a permission request as text with numbered options.
 * Returns { text, options } where options maps number → action for reply matching.
 */
export function renderPermissionAsText(data: {
  requestId: string
  permissionType: string
  title: string
}): { text: string; options: Map<number, { action: string; value: string }> } {
  const options = new Map<number, { action: string; value: string }>()

  const actionButtons = [
    { label: '✅ 允许一次', value: `permission_reply:${data.requestId}:once` },
    { label: '✅ 始终允许', value: `permission_reply:${data.requestId}:always` },
    { label: '❌ 拒绝', value: `permission_reply:${data.requestId}:reject` },
  ]

  const optionLines: string[] = []
  actionButtons.forEach((btn, i) => {
    const num = i + 1
    options.set(num, { action: 'permission_reply', value: btn.value })
    optionLines.push(`${num}. ${btn.label}`)
  })

  const text = [
    `🔐 权限请求: ${data.permissionType}`,
    `📄 ${data.title}`,
    '',
    '请回复数字选择:',
    ...optionLines,
  ].join('\n')

  return { text, options }
}

// ─── Question renderer ─────────────────────────────────────────────────────────

/**
 * Render a question as text with numbered options.
 * Returns { text, options } where options maps number → action for reply matching.
 */
export function renderQuestionAsText(data: {
  requestId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiple?: boolean
    custom?: boolean
  }>
}): { text: string; options: Map<number, { action: string; value: string }> } {
  const optionsMap = new Map<number, { action: string; value: string }>()
  const firstQ = data.questions[0]

  if (!firstQ) {
    return { text: '❓ 问题（空）', options: optionsMap }
  }

  const header = firstQ.header || '问题'
  const question = firstQ.question || ''
  const qOptions = firstQ.options || [{ label: 'Yes' }, { label: 'No' }]
  const isCustom = firstQ.custom ?? false

  const lines: string[] = []
  lines.push(`❓ ${header}`)

  if (question) {
    lines.push(stripMarkdown(question))
  }

  if (qOptions.some(o => o.description)) {
    lines.push('')
  }

  lines.push('')

  let num = 1
  for (const opt of qOptions.slice(0, 5)) {
    const desc = opt.description ? ` — ${opt.description}` : ''
    lines.push(`${num}. ${stripMarkdown(opt.label)}${desc}`)
    optionsMap.set(num, {
      action: 'question_answer',
      value: `question_answer:${data.requestId}:${opt.label}`,
    })
    num++
  }

  if (isCustom) {
    lines.push(`${num}. 💬 自定义回答`)
    optionsMap.set(num, {
      action: 'question_custom',
      value: `question_custom:${data.requestId}`,
    })
    num++
  }

  lines.push(`${num}. ⏭ 跳过`)
  optionsMap.set(num, {
    action: 'question_answer',
    value: `question_answer:${data.requestId}:skip`,
  })

  return { text: lines.join('\n'), options: optionsMap }
}

// ─── Text chunking ─────────────────────────────────────────────────────────────

/**
 * Split text into chunks that fit WeChat's character limit.
 * Tries to split at newline boundaries first, then at word boundaries,
 * and finally hard-splits if a single "word" exceeds the limit.
 */
export function chunkText(text: string, maxLen: number = WECHAT_MAX_LEN): string[] {
  if (text.length <= maxLen) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Try to split at the last newline within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen)

    if (splitAt <= 0) {
      // No newline found in range; try splitting at last space
      splitAt = remaining.lastIndexOf(' ', maxLen)
    }

    if (splitAt <= 0) {
      // No space either; hard split at maxLen
      splitAt = maxLen
    }

    const chunk = remaining.slice(0, splitAt).trimEnd()
    if (chunk.length > 0) {
      chunks.push(chunk)
    }
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

// ─── Number-to-action resolver ─────────────────────────────────────────────────

/**
 * When a WeChat user replies with a number (e.g., "1"), resolve it to an action.
 * Returns the action value string (e.g., "permission_reply:abc123:once")
 * or null if the input is not a valid numeric selection.
 */
export function resolveNumberReply(
  text: string,
  options: Map<number, { action: string; value: string }>,
): string | null {
  const trimmed = text.trim()

  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && options.has(num)) {
    return options.get(num)!.value
  }

  return null
}
