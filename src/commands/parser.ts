export function parseCommand(text: string): { isCommand: boolean; command: string; args: string[] } {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return { isCommand: false, command: '', args: [] }
  }
  const parts = trimmed.slice(1).split(/\s+/)
  const command = parts[0]?.toLowerCase() || ''
  const args = parts.slice(1)
  return { isCommand: true, command, args }
}
