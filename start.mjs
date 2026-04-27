#!/usr/bin/env node

/**
 * OpenCode IM Bridge — 统一启动脚本
 *
 * 同时管理 opencode serve 和 bridge 两个进程，
 * 统一输出日志，支持 Ctrl+C 优雅退出。
 *
 * 用法:
 *   node start.mjs                 # 默认端口 4096
 *   node start.mjs --port 8080     # 自定义端口
 *   node start.mjs --opencode-only # 只启动 opencode serve
 *   node start.mjs --bridge-only   # 只启动 bridge
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ──────────────────────────────────────────────
// 参数解析
// ──────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? args[portIdx + 1] : '4096';
const OPENCODE_ONLY = args.includes('--opencode-only');
const BRIDGE_ONLY = args.includes('--bridge-only');

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, 'logs');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// ──────────────────────────────────────────────
// 颜色工具
// ──────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

function tag(name, color) {
  return `${color}${BOLD}[${name}]${RESET}`;
}

function timestamp() {
  return `${GRAY}${new Date().toLocaleTimeString('zh-CN', { hour12: false })}${RESET}`;
}

// ──────────────────────────────────────────────
// 进程管理
// ──────────────────────────────────────────────

const processes = [];

function startProcess(name, color, command, args, env = {}) {
  const logFile = createWriteStream(resolve(LOG_DIR, `${name}.log`), { flags: 'a' });

  const child = spawn(command, args, {
    cwd: __dirname,
    shell: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = tag(name, color);

  child.stdout.on('data', (data) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      const output = `${timestamp()} ${prefix} ${line}`;
      console.log(output);
      logFile.write(line + '\n');
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      const output = `${timestamp()} ${prefix} ${RED}${line}${RESET}`;
      console.error(output);
      logFile.write(line + '\n');
    }
  });

  child.on('close', (code) => {
    const status = code === 0 ? `${GREEN}exited${RESET}` : `${RED}exited (code ${code})${RESET}`;
    console.log(`\n${timestamp()} ${prefix} ${status}\n`);
  });

  child.on('error', (err) => {
    console.error(`${timestamp()} ${prefix} ${RED}failed to start: ${err.message}${RESET}`);
  });

  processes.push({ name, child, logFile });
  return child;
}

// ──────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────

console.log(`\n${BOLD}════════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  OpenCode IM Bridge${RESET}`);
console.log(`${BOLD}════════════════════════════════════════════════════${RESET}`);
console.log(`  ${CYAN}OpenCode${RESET}  http://localhost:${PORT}`);
console.log(`  ${CYAN}Logs${RESET}     ${LOG_DIR}`);
console.log(`${BOLD}════════════════════════════════════════════════════${RESET}\n`);

if (!BRIDGE_ONLY) {
  console.log(`${timestamp()} ${tag('Main', CYAN)} Starting OpenCode server on port ${PORT}...`);
  startProcess('opencode', CYAN, 'opencode', ['serve', '--port', PORT]);
}

if (!OPENCODE_ONLY) {
  console.log(`${timestamp()} ${tag('Main', CYAN)} Starting IM Bridge...`);
  startProcess('bridge', GREEN, 'node_modules/.bin/tsx', ['src/index.ts']);
}

// ──────────────────────────────────────────────
// 优雅退出
// ──────────────────────────────────────────────

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${timestamp()} ${tag('Main', YELLOW)} Shutting down...`);

  for (const { name, child, logFile } of processes) {
    if (child.exitCode === null) {
      console.log(`${timestamp()} ${tag(name, YELLOW)} Sending SIGTERM...`);
      child.kill('SIGTERM');
      logFile.end();
    }
  }

  setTimeout(() => {
    for (const { name, child } of processes) {
      if (child.exitCode === null) {
        console.log(`${timestamp()} ${tag(name, RED)} Force killing...`);
        child.kill('SIGKILL');
      }
    }
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('exit', () => {
  for (const { child } of processes) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
});
