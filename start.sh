#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  OpenCode Feishu Bot — 一键启动脚本
#  用法: ./start.sh          启动所有服务
#        ./start.sh stop     停止所有服务
#        ./start.sh restart  重启所有服务
#        ./start.sh logs     查看 Bot 日志
#        ./start.sh status   查看服务状态
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 从 .env 读取配置
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

OPENCODE_PORT="${OPENCODE_SERVER_URL##*:}"  # 从 URL 提取端口，如 4096
OPENCODE_PORT="${OPENCODE_PORT%/}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"           # 默认端口
OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-opencode}"
OPENCODE_PID_FILE="$SCRIPT_DIR/.opencode-server.pid"
OPENCODE_LOG_FILE="$SCRIPT_DIR/opencode-server.log"

# ── 颜色 ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; }

# ── 检查 opencode 是否可用 ──
find_opencode() {
  if command -v opencode &>/dev/null; then
    echo "opencode"
  elif [[ -x "$HOME/.opencode/bin/opencode" ]]; then
    echo "$HOME/.opencode/bin/opencode"
  else
    error "找不到 opencode 命令，请先安装: https://opencode.ai"
    exit 1
  fi
}

# ── 检查端口是否被监听 ──
is_port_in_use() {
  lsof -iTCP:"$1" -sTCP:LISTEN &>/dev/null
}

# ── 获取监听端口的 PID ──
get_port_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

# ── 强制杀掉监听端口的所有进程 ──
force_kill_port() {
  local port=$1
  local pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    # 检查是否还在
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 0.5
    fi
  fi
}

# ── 启动 OpenCode 服务器 ──
start_opencode() {
  local force=${1:-}
  if [[ "$force" != "--force" ]] && is_port_in_use "$OPENCODE_PORT"; then
    info "OpenCode 服务器已在运行 (端口 $OPENCODE_PORT)"
    return 0
  fi

  # 强制模式下先确保端口已释放
  if [[ "$force" == "--force" ]]; then
    local wait_count=0
    while is_port_in_use "$OPENCODE_PORT" && [[ $wait_count -lt 10 ]]; do
      sleep 0.5
      wait_count=$((wait_count + 1))
    done
    # 如果等 5 秒还没释放，主动再杀一次
    if is_port_in_use "$OPENCODE_PORT"; then
      local leftover_pid
      leftover_pid=$(get_port_pid "$OPENCODE_PORT")
      warn "端口 $OPENCODE_PORT 仍被占用 (PID: ${leftover_pid:-unknown})，强制清理..."
      force_kill_port "$OPENCODE_PORT"
      sleep 1
    fi
    if is_port_in_use "$OPENCODE_PORT"; then
      local final_pid
      final_pid=$(get_port_pid "$OPENCODE_PORT")
      error "端口 $OPENCODE_PORT 仍被占用，无法启动 OpenCode 服务器"
      error "占用进程 PID: ${final_pid:-unknown} — 手动执行: fuser -k $OPENCODE_PORT/tcp"
      return 1
    fi
  fi

  local opencode_bin
  opencode_bin="$(find_opencode)"

  info "启动 OpenCode 服务器 (端口 $OPENCODE_PORT)..."
  OPENCODE_SERVER_PASSWORD="$OPENCODE_PASSWORD" \
    nohup "$opencode_bin" serve --port "$OPENCODE_PORT" \
    > "$OPENCODE_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$OPENCODE_PID_FILE"

  # 等待服务就绪（最多 15 秒）
  local retries=0
  while ! is_port_in_use "$OPENCODE_PORT"; do
    retries=$((retries + 1))
    if [[ $retries -ge 30 ]]; then
      error "OpenCode 服务器启动超时，查看日志: $OPENCODE_LOG_FILE"
      exit 1
    fi
    sleep 0.5
  done

  info "OpenCode 服务器已启动 (PID: $pid)"
}

# ── 停止 OpenCode 服务器 ──
stop_opencode() {
  local any_killed=false

  # 1. 先按 PID 文件尝试优雅停止（如果有）
  if [[ -f "$OPENCODE_PID_FILE" ]]; then
    local pid
    pid=$(cat "$OPENCODE_PID_FILE")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      info "停止 OpenCode 服务器 (PID 文件: $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
      # 等待该进程退出
      local retries=0
      while kill -0 "$pid" 2>/dev/null && [[ $retries -lt 20 ]]; do
        sleep 0.5
        retries=$((retries + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        warn "PID $pid 未响应，强制终止..."
        kill -9 "$pid" 2>/dev/null || true
      fi
      any_killed=true
    else
      warn "PID 文件中的进程已不存在 (PID: $pid)"
    fi
    rm -f "$OPENCODE_PID_FILE"
  fi

  # 2. 端口兜底清理 — 这才是权威手段
  if is_port_in_use "$OPENCODE_PORT"; then
    if $any_killed; then
      info "端口 $OPENCODE_PORT 仍有残留进程，正在清理..."
    else
      info "通过端口 $OPENCODE_PORT 发现运行中的进程，正在停止..."
    fi
    force_kill_port "$OPENCODE_PORT"
    # 验证清理结果
    sleep 0.5
    if is_port_in_use "$OPENCODE_PORT"; then
      error "端口 $OPENCODE_PORT 清理失败！尝试手动执行: fuser -k $OPENCODE_PORT/tcp"
      local leftover_pid
      leftover_pid=$(get_port_pid "$OPENCODE_PORT")
      error "残留进程 PID: ${leftover_pid:-unknown}"
      return 1
    fi
    info "端口 $OPENCODE_PORT 已释放"
  elif ! $any_killed; then
    warn "OpenCode 服务器未在运行"
  fi
}

# ── 启动 Docker Bot ──
start_bot() {
  info "启动飞书 Bot 容器..."
  docker compose up -d --build
  info "飞书 Bot 已启动"
}

# ── 停止 Docker Bot ──
stop_bot() {
  info "停止飞书 Bot 容器..."
  docker compose down
  info "飞书 Bot 已停止"
}

# ── 查看状态 ──
show_status() {
  echo ""
  echo "═══════════════════════════════════════"
  echo "  OpenCode Feishu Bot 服务状态"
  echo "═══════════════════════════════════════"

  # OpenCode 服务器状态
  if is_port_in_use "$OPENCODE_PORT"; then
    local pid
    pid=$(get_port_pid "$OPENCODE_PORT")
    info "OpenCode 服务器: 运行中 (PID: ${pid:-?}, 端口: $OPENCODE_PORT)"
  else
    error "OpenCode 服务器: 未运行"
  fi

  # Docker Bot 状态
  local container_status
  container_status=$(docker inspect -f '{{.State.Status}}' opencode-feishu-bot 2>/dev/null || echo "not_found")
  if [[ "$container_status" == "running" ]]; then
    info "飞书 Bot 容器:   运行中"
  else
    error "飞书 Bot 容器:   未运行 ($container_status)"
  fi

  echo "═══════════════════════════════════════"
  echo ""
}

# ── 主逻辑 ──
case "${1:-start}" in
  start)
    echo ""
    echo "═══════════════════════════════════════"
    echo "  启动 OpenCode Feishu Bot"
    echo "═══════════════════════════════════════"
    start_opencode
    start_bot
    echo "═══════════════════════════════════════"
    info "全部启动完成！"
    echo ""
    ;;
  stop)
    echo ""
    stop_bot
    stop_opencode
    info "全部已停止"
    echo ""
    ;;
  restart)
    echo ""
    stop_bot
    stop_opencode
    sleep 1
    start_opencode --force
    start_bot
    info "全部重启完成！"
    echo ""
    ;;
  logs)
    docker compose logs -f
    ;;
  status)
    show_status
    ;;
  *)
    echo "用法: $0 {start|stop|restart|logs|status}"
    exit 1
    ;;
esac
