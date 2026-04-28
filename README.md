<div align="center">

# 🤖 OpenCode IM Bridge

**将 OpenCode 接入飞书 & 微信机器人，让用户在聊天中直接与 AI 对话**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Lark SDK](https://img.shields.io/badge/@larksuiteoapi-node--sdk-latest-00D6D6?logo=lark&logoColor=white)](https://github.com/larksuite/oapi-sdk-node)

**飞书** · **微信**

</div>

---

## 📑 目录

- [✨ 功能特点](#-功能特点)
- [🏗️ 架构](#️-架构)
- [🚀 快速开始](#-快速开始)
  - [前置条件](#1-前置条件)
  - [安装依赖](#2-安装依赖)
  - [配置](#3-配置)
  - [飞书应用配置](#4-飞书应用配置)
  - [微信配置](#5-微信配置)
  - [启动](#6-启动)
- [📲 微信使用指南](#-微信使用指南)
- [📜 命令列表](#-命令列表)
- [📁 项目结构](#-项目结构)
- [⚙️ 配置说明](#️-配置说明)
- [🛠️ 开发](#️-开发)
- [🔧 技术细节](#-技术细节)
- [❓ 常见问题](#-常见问题)
- [🤝 贡献](#-贡献)
- [🙏 致谢](#-致谢)
- [📄 License](#-license)

---

## ✨ 功能特点

<table>
<tr>
<td width="50%">

### 🔌 连接与通信
- 🌐 **飞书 WebSocket** — 无需公网 IP，本地即可运行
- 💬 **微信长轮询** — HTTP 长连接接收微信消息
- 💬 **流式回复** — 飞书打字机效果 / 微信文本分段发送

</td>
<td width="50%">

### 🛡️ 可靠性与控制
- 🔒 **消息去重** — 基于 message_id 防止重复投递
- ⏱️ **频率限制** — 每用户每分钟 20 条上限
- 🔁 **指数退避重连** — 网络错误自动重试（5s → 60s 退避）
- 🎫 **并发控制** — 同一会话消息串行处理

</td>
</tr>
<tr>
<td width="50%">

### 📊 智能交互
- 📈 **Token 统计** — 回复展示输入/输出/缓存 token
- ⏳ **进度轮询** — 长任务每 5 秒更新状态
- 🎛️ **权限交互** — 飞书卡片按钮 / 微信数字选择

</td>
<td width="50%">

### 🔄 会话管理
- 🗂️ **独立会话** — 每个用户独立上下文
- 🎛️ **丰富命令** — 模型/角色切换、推理强度、会话管理
- 🔐 **QR 码登录** — 微信扫码登录，终端显示

</td>
</tr>
</table>

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              数据流向                                    │
└─────────────────────────────────────────────────────────────────────────┘

    ┌──────────────┐  ┌──────────────┐         ┌──────────────┐
    │   飞书用户    │  │   微信用户    │  发消息  │              │
    │   💬          │  │   💚          │ ─────── │   接收器     │
    └──────────────┘  └──────────────┘         │  • WS (飞书) │
           │                  │                │  • HTTP轮询   │
           └────────┬─────────┘                └──────────────┘
                    │                                  │
                    ▼                                  │ HTTP
             ┌──────────────┐                          │
             │   消息处理    │                          │
             │  • 去重检查   │                          │
             │  • 频率限制   │                          │
             │  • 命令解析   │                          │
             └──────────────┘                          │
                    │                                  │
                    │           流式响应                │
                    ▼ ◄────────────────────────────────┘
             ┌──────────────┐
             │   响应输出    │ ◄── 进度轮询 (每5秒)
             │  • 飞书: 卡片 │
             │  • 微信: 文本 │
             └──────────────┘
                    │
                    ▼
             ┌──────────────┐
             │   用户收到    │
             │   流式回复    │
             └──────────────┘
```

---

## 🚀 快速开始

### 1. 前置条件

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | 20+ | 运行环境 |
| OpenCode CLI | 最新版 | AI 编程助手 |
| 飞书开放平台应用 | - | 需启用机器人能力（仅飞书需要） |

### 2. 安装依赖

```bash
cd opencode-feishu-bot
npm install
```

### 3. 配置

复制配置文件模板：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要参数：

```env
# ─────────────────────────────────────────────
# 飞书应用配置
# ─────────────────────────────────────────────
LARK_APP_ID=cli_xxxxxxxxx           # 飞书应用 ID
LARK_APP_SECRET=your_app_secret    # 飞书应用密钥
LARK_DOMAIN=feishu                 # 国际版请改为 lark

# ─────────────────────────────────────────────
# OpenCode 服务器配置
# ─────────────────────────────────────────────
OPENCODE_SERVER_URL=http://localhost:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=your-password

# ─────────────────────────────────────────────
# 微信机器人配置（可选）
# ─────────────────────────────────────────────
WECHAT_ENABLED=false               # 设为 true 启用微信
WECHAT_ALLOWED_USERS=              # 白名单用户（逗号分隔）
```

### 4. 飞书应用配置

<details>
<summary>📋 详细配置步骤（点击展开）</summary>

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 创建**企业自建应用**
3. 启用**机器人能力**
4. 配置**事件订阅**：启用 WebSocket 模式
5. 添加**权限**（二选一）：

**方式一：批量导入**（推荐）

复制以下 JSON 保存为 `scopes.json`，在开发者后台 → 权限管理 → 批量开通 中导入：

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message:send_as_bot",
      "im:message:update",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.reactions:write_only"
    ],
    "user": []
  }
}
```

**方式二：手动添加**

在开发者后台 → 权限管理 → 搜索框中逐个搜索添加：

| 权限标识 | 用途 |
|---------|------|
| `im:message` | 收发消息（必需） |
| `im:message:send_as_bot` | 机器人身份发消息（必需） |
| `im:message:update` | 更新卡片/流式回复（必需） |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @消息 |
| `im:message.group_msg` | 群聊中发消息 |
| `im:message.reactions:write_only` | 添加"收到"表情反应 |

</details>

### 5. 微信配置

在 `.env` 中启用微信并配置：

```env
WECHAT_ENABLED=true
```

启动后终端会显示二维码，使用个人微信扫码登录即可。详见下方 [📲 微信使用指南](#-微信使用指南)。

> ⚠️ 微信基于 [iLink Bot API](https://ilinkai.weixin.qq.com)，仅支持纯文本消息（1800 字上限），不支持富文本卡片、消息更新和群聊。

### 6. 启动

**方式一：统一启动（推荐）**

使用 `start.mjs` 一键启动 OpenCode 服务器和 IM Bridge：

```bash
# 默认端口 4096
node start.mjs

# 自定义端口
node start.mjs --port 8080

# 只启动 OpenCode 服务器
node start.mjs --opencode-only

# 只启动 IM Bridge
node start.mjs --bridge-only
```

日志同时输出到终端和 `./logs/` 目录。

**方式二：分别启动**

终端 1 — 启动 OpenCode 服务器：

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4096
```

终端 2 — 启动 IM Bridge：

```bash
npm run start
```

---

## 📲 微信使用指南

### 原理

本项目通过 [iLink Bot API](https://ilinkai.weixin.qq.com) 接入**个人微信**（非企业微信）。消息通过 HTTP 长轮询接收，回复通过文本消息发送。

### 登录流程

1. 在 `.env` 中设置 `WECHAT_ENABLED=true`
2. 启动 IM Bridge
3. 终端会自动显示 ASCII 二维码：
   ```
   [WeChat] Starting QR login session...
   [WeChat] Scan this QR code with WeChat:
   █████████████████████████
   ██ ▄▄▄▄▄ █▀█ █▄▀██ ▄▄▄▄▄ ██
   ██ █   █ █▀▀▀█ ▄██ █   █ ██
   ██ █▄▄▄█ ██ ▄▀█▄▄█ █▄▄▄█ ██
   ...
   ```
4. 打开手机微信 → 扫一扫 → 扫描终端二维码 → 确认登录
5. 登录成功后凭证自动保存在 `./data/wechat/tokens.json`，下次启动无需重新扫码

> 💡 二维码有效期 5 分钟，过期会自动刷新（最多 3 次）。超过刷新次数需重启服务。

### 消息交互

微信中的交互方式与飞书基本一致，但有以下区别：

| 功能 | 飞书 | 微信 |
|------|------|------|
| 消息格式 | 富文本卡片 | 纯文本 |
| 权限请求 | 点击卡片按钮 | 回复数字（1/2/3） |
| 问题选项 | 点击卡片按钮 | 回复数字或发送自定义文字 |
| 长回复 | 流式打字机效果 | 分段发送（每段 ≤1800 字） |
| 群聊 | ✅ | ❌ 仅支持一对一私聊 |

**权限交互示例：**

当 AI 需要文件操作权限时，你会收到：

```
🔐 权限请求: WriteFile
📄 /path/to/file.ts

请回复数字选择:
1. ✅ 允许一次
2. ✅ 始终允许
3. ❌ 拒绝
```

回复 `1` 即可授权。回复 `2` 则以后同类权限自动放行。

**问题交互示例：**

```
❓ 确认操作
是否删除该文件？

1. Yes
2. No
3. 💬 自定义回答
4. ⏭ 跳过
```

回复 `3` 后，下一条消息将被视为自定义回答。

### 用户白名单

可以通过 `WECHAT_ALLOWED_USERS` 限制允许使用的微信用户：

```env
# 允许所有用户
WECHAT_ALLOWED_USERS=

# 仅允许特定用户（逗号分隔，使用微信 OpenID）
WECHAT_ALLOWED_USERS=o9cq80-xxx@im.wechat,o9cq80-yyy@im.wechat
```

OpenID 在日志中可见（用户首次发消息时会打印 `[WeChat] Received message from o9cq80-xxx@im.wechat`）。

### 凭证与安全

- 登录凭证保存在 `./data/wechat/tokens.json`，文件权限为 `0600`（仅当前用户可读写）
- 会话过期后（iLink 返回 errcode -14）会自动触发重新扫码登录
- `./data/wechat/offset.json` 记录消息拉取偏移量，重启后不会漏消息

### 限制

- 仅支持**文本消息**（不支持图片、语音、文件）
- 单条回复最长 **1800 字**，超长自动分段发送
- 不支持群聊（仅 P2P 私聊）
- 消息无法编辑/撤回，发送后不可修改
- 需要保持与服务器的网络连接

---

## 📜 命令列表

飞书和微信支持**完全相同**的命令系统：

### 📊 状态查询

| 命令 | 说明 |
|:-----|:-----|
| `/help` | 📖 查看帮助 |
| `/status` | 📊 查看当前状态（模型、角色、推理强度） |
| `/panel` | 🎛️ 显示控制面板（飞书按钮 / 微信数字） |

### 🤖 模型与角色

| 命令 | 说明 |
|:-----|:-----|
| `/model` | 🔍 查看当前模型 |
| `/model <名称>` | 🔄 切换模型（支持模糊搜索） |
| `/models` | 📋 列出所有可用模型 |
| `/agent` | 🎭 查看当前角色 |
| `/agent <名称>` | 🔄 切换角色 |
| `/agents` | 📋 列出所有可用角色 |

### ⚙️ 推理与会话

| 命令 | 说明 |
|:-----|:-----|
| `/effort` | ⚡ 查看当前推理强度 |
| `/effort <low\|medium\|high>` | 🔧 设置推理强度 |

### 🗂️ 会话管理

| 命令 | 说明 |
|:-----|:-----|
| `/session new` | 🆕 开启新话题 |
| `/sessions` | 📋 列出会话 |
| `/rename <名称>` | ✏️ 重命名会话 |
| `/stop` | ⏹️ 停止当前回答 |
| `/compact` | 🗜️ 压缩上下文 |
| `/clear` | 🧹 重置对话上下文 |

---

## 📁 项目结构

```
opencode-feishu-bot/
│
├── 📂 src/
│   ├── 📄 index.ts              # 入口文件（多 bot 并行启动）
│   ├── 📄 bot.ts                # 飞书 WebSocket 机器人（去重/限流/并发控制）
│   ├── 📄 opencode.ts           # OpenCode API 客户端（重试/超时/进度轮询）
│   ├── 📄 commands.ts           # 命令解析与处理（17 个命令）
│   ├── 📄 streaming.ts          # 流式卡片控制器（飞书）
│   ├── 📄 interaction-handler.ts # 权限/问题卡片交互处理器
│   ├── 📄 session.ts            # 会话管理（TTL/淘汰）
│   ├── 📄 config.ts             # 配置加载（YAML + 环境变量）
│   │
│   └── 📂 wechat/               # 微信机器人模块
│       ├── 📄 wechat-bot.ts     # 微信 Bot 核心（长轮询/消息管道/交互）
│       ├── 📄 wechat-api.ts     # 微信 HTTP 协议客户端
│       ├── 📄 wechat-auth.ts    # QR 码登录流程
│       ├── 📄 wechat-types.ts   # 协议类型定义
│       ├── 📄 wechat-ids.ts     # Chat ID 编解码
│       ├── 📄 wechat-media.ts   # 媒体下载 + AES 解密
│       ├── 📄 wechat-store.ts   # 文件持久化（JSON）
│       └── 📄 commands-text.ts  # 文本命令渲染器（卡片→纯文本）
│
├── 📂 tests/
│   ├── 📄 bot.test.ts           # Bot 核心逻辑测试
│   ├── 📄 commands.test.ts      # 命令系统测试
│   └── 📄 session.test.ts       # 会话管理测试
│
├── 📂 config/
│   └── 📄 config.yaml           # YAML 配置文件
│
├── 📄 start.mjs                 # 统一启动脚本（OpenCode + Bridge）
├── 📄 .env.example              # 环境变量示例
├── 📄 package.json
├── 📄 tsconfig.json
└── 📄 README.md
```

---

## ⚙️ 配置说明

<details>
<summary>📄 config.yaml 配置详情（点击展开）</summary>

```yaml
# ─────────────────────────────────────────────
# 飞书应用配置
# ─────────────────────────────────────────────
feishu:
  app_id: "${LARK_APP_ID}"
  app_secret: "${LARK_APP_SECRET}"
  domain: "feishu"              # 国际版请改为 "lark"

# ─────────────────────────────────────────────
# 微信机器人配置（可选）
# ─────────────────────────────────────────────
wechat:
  enabled: ${WECHAT_ENABLED:false}
  allowed_users: ${WECHAT_ALLOWED_USERS:}   # 白名单（逗号分隔，空=允许所有）
  data_dir: ${WECHAT_DATA_DIR:./data/wechat}
  api_base_url: "https://ilinkai.weixin.qq.com"
  cdn_base_url: "https://cdn.ilinkai.weixin.qq.com"
  poll_timeout: 35                          # 长轮询超时（秒）
  api_timeout: 15                           # API 超时（秒）

# ─────────────────────────────────────────────
# OpenCode 服务器配置
# ─────────────────────────────────────────────
opencode:
  server_url: "${OPENCODE_SERVER_URL:http://localhost:4096}"
  username: "${OPENCODE_USERNAME:opencode}"
  password: "${OPENCODE_PASSWORD}"

# ─────────────────────────────────────────────
# 会话配置
# ─────────────────────────────────────────────
session:
  ttl: 3600                     # 会话过期时间（秒）
  max_sessions: 100             # 最大并发会话数

# ─────────────────────────────────────────────
# 流式输出配置
# ─────────────────────────────────────────────
streaming:
  update_interval: 500          # 卡片更新间隔（毫秒）
  min_chunk_size: 10            # 最小更新文本长度
```

</details>

---

## 🛠️ 开发

```bash
# 🔧 开发模式（热重载）
npm run dev

# ✅ 类型检查
npm run typecheck

# 🧪 运行测试
npm test

# 📦 构建
npm run build
```

---

## 🔧 技术细节

<details>
<summary>🔄 消息处理流程（点击展开）</summary>

**飞书流程：**

```
1. 飞书 WebSocket 收到消息事件
       ↓
2. 消息去重检查（message_id）
       ↓
3. 频率限制检查（per-user, 20/min）
       ↓
4. 添加 "Get" 表情反应
       ↓
5. 命令检测 → 卡片命令响应
       ↓
6. 普通消息 → per-chat 互斥锁排队
       ↓
7. 发送卡片（Thinking...）
       ↓
8. 调用 OpenCode API → 等待响应
       ↓
9. 权限/问题轮询 → 交互卡片 → 用户点击 → 原地更新
       ↓
10. 进度轮询（每 5 秒更新卡片状态）
       ↓
11. 响应完成 → 模拟流式输出 → 展示 token 统计
```

**微信流程：**

```
1. HTTP 长轮询获取消息（35s 超时）
       ↓
2. 消息去重 / 频率限制 / 用户白名单
       ↓
3. 检查待回复的权限/问题（用户回复数字选择）
       ↓
4. 命令检测 → 纯文本命令响应
       ↓
5. 普通消息 → per-chat 互斥锁排队
       ↓
6. 调用 OpenCode API → 收集响应
       ↓
7. 权限/问题 → 发送编号选项文本 → 用户回复数字 → 匹配操作
       ↓
8. 响应完成 → 按 1800 字分段发送 → 展示 token 统计
```

</details>

<details>
<summary>📊 飞书 vs 微信功能对比（点击展开）</summary>

| 功能 | 飞书 | 微信 |
|------|:----:|:----:|
| 消息接收 | WebSocket | HTTP 长轮询 |
| 富文本卡片 | ✅ | ❌ (纯文本) |
| 消息更新/删除 | ✅ | ❌ |
| 流式打字机效果 | ✅ | ❌ (分段发送) |
| 权限交互 | 卡片按钮 | 数字选择 |
| 群聊支持 | ✅ | ❌ (仅 P2P) |
| 媒体附件 | ✅ | ✅ |
| 命令系统 | ✅ | ✅ (全部命令) |
| QR 码登录 | — | ✅ |
| Token 统计 | ✅ | ✅ |
| 自定义回答 | ✅ | ✅ |
| 用户白名单 | — | ✅ |

</details>

<details>
<summary>⚠️ 错误处理策略（点击展开）</summary>

| 场景 | 处理方式 |
|------|---------|
| API 请求失败 | 5xx/网络错误自动重试（最多 2 次，1-2 秒间隔） |
| 微信长轮询失败 | 指数退避重试（5s → 10s → 20s → ... → 60s 上限） |
| 微信会话过期 (errcode -14) | 自动触发 QR 码重新登录 |
| 用户中断 | `/clear` 和 `/stop` 中断请求 + 清空队列 + 停止轮询 |
| 权限/问题交互 | 同一请求 ID 每个 Bot 仅发送一次，互不干扰 |
| Token 文件安全 | `chmod 0600`，仅文件所有者可读写 |

</details>

---

## ❓ 常见问题

<details>
<summary><strong>🤖 机器人没有回复消息？</strong></summary>

请依次检查：

1. **OpenCode 服务器是否运行**
   ```bash
   curl http://localhost:4096/global/health
   ```

2. **飞书应用配置**
   - 是否启用了机器人能力
   - 是否配置了 WebSocket 事件订阅
   - 权限是否正确配置

3. **微信相关**
   - `.env` 中 `WECHAT_ENABLED` 是否为 `true`
   - 是否已完成扫码登录（终端应显示 `[WeChat] Using account: xxx`）
   - 如果会话过期，重启后会自动触发重新登录

</details>

<details>
<summary><strong>💚 微信扫码后没反应？</strong></summary>

1. 检查终端是否显示 `[WeChat] Login successful!`
2. 如果显示登录成功但仍收不到消息，检查 `./data/wechat/offset.json` 是否损坏（可删除后重启）
3. 如果登录失败，确认网络可以访问 `https://ilinkai.weixin.qq.com`

</details>

<details>
<summary><strong>💚 微信会话过期怎么办？</strong></summary>

iLink token 会定期过期。过期后程序会自动触发重新扫码登录，终端会重新显示二维码。扫码后自动恢复，无需重启。

</details>

<details>
<summary><strong>⏰ 长任务超时怎么办？</strong></summary>

默认超时为 **15 分钟**。超时后会提示用户，不会重发请求。

可使用 `/stop` 命令中断进行中的任务。

</details>

<details>
<summary><strong>🔄 如何切换模型？</strong></summary>

两种方式：

1. **交互式**：发送 `/models` 查看可用模型列表
   - 飞书：点击按钮切换
   - 微信：回复数字切换
2. **命令式**：发送 `/model <名称>` 直接切换

</details>

<details>
<summary><strong>🔐 如何限制微信用户？</strong></summary>

在 `.env` 中设置 `WECHAT_ALLOWED_USERS`：

```env
# 仅允许指定用户（逗号分隔）
WECHAT_ALLOWED_USERS=o9cq80-abc@im.wechat,o9cq80-xyz@im.wechat
```

用户 ID 在日志中可见。设为空（默认）则允许所有用户。

</details>

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

---

## 🙏 致谢

本项目的开发受到以下项目的启发，感谢他们的探索与分享：

- [opencode-im-bridge](https://github.com/ET06731/opencode-im-bridge) — OpenCode IM 桥接方案
- [opencode-bridge](https://github.com/HNGM-HP/opencode-bridge) — OpenCode 通信桥接实现

---

## 📄 License

本项目采用 [MIT](LICENSE) 许可证开源。

---

<div align="center">

**如果这个项目对你有帮助，请给一个 ⭐ Star 支持一下！**

Made with ❤️ by OpenCode Community

</div>
