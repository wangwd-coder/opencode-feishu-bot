import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'

/** In Docker, os.homedir() is /root. Detect the real host user home under /Users. */
export function getHostHome(): string {
  if (process.env.HOST_HOME) return process.env.HOST_HOME
  try {
    const entries = fsSync.readdirSync('/Users', { withFileTypes: true })
    const userDirs = entries.filter(
      e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'Shared'
    )
    if (userDirs.length > 0) return `/Users/${userDirs[0].name}`
  } catch { /* fall through */ }
  return os.homedir()
}

export const HOME = getHostHome()

/** Expand ~ in a path using the real host home, not Docker's /root. */
export function expandHome(input: string): string {
  if (input.startsWith('~')) return path.join(HOME, input.slice(1))
  return input
}

/** Shorten a path for display: replace home dir with ~. */
export function shortenPath(absPath: string): string {
  return absPath.startsWith(HOME) ? '~' + absPath.slice(HOME.length) : absPath
}
