<div align="center">

# 🤖 OpenCode Feishu Bot

**将 OpenCode 接入飞书机器人，让用户在飞书聊天中直接与 AI 对话**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Lark SDK](https://img.shields.io/badge/@larksuiteoapi-node--sdk-latest-00D6D6?logo=lark&logoColor=white)](https://github.com/larksuite/oapi-sdk-node)

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
  - [启动](#5-启动)
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
- 🌐 **WebSocket 长连接** — 无需公网 IP，本地即可运行
- 💬 **流式回复** — 打字机效果，实时显示 AI 回复

</td>
<td width="50%">

### 🛡️ 可靠性与控制
- 🔒 **消息去重** — 基于 message_id 防止重复投递
- ⏱️ **频率限制** — 每用户每分钟 20 条上限
- 🔁 **自动重试** — 5xx/网络错误自动重试（最多 2 次）
- 🎫 **并发控制** — 同一会话消息串行处理

</td>
</tr>
<tr>
<td width="50%">

### 📊 智能交互
- 📈 **Token 统计** — 回复卡片展示输入/输出/缓存 token
- ⏳ **进度轮询** — 长任务每 5 秒更新卡片状态
- 🎛️ **权限交互** — 支持 Allow Once/Always/Reject 按钮

</td>
<td width="50%">

### 🔄 会话管理
- 🗂️ **独立会话** — 每个用户独立上下文
- 👍 **消息反应** — 收到消息自动添加 "Get" 表情
- 🎛️ **丰富命令** — 模型/角色切换、推理强度、会话管理

</td>
</tr>
</table>

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              数据流向                                    │
└─────────────────────────────────────────────────────────────────────────┘

    ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
    │   飞书用户    │  发消息  │   WebSocket  │  HTTP   │   OpenCode   │
    │   💬          │ ─────── │    接收器     │ ─────── │    API       │
    └──────────────┘         └──────────────┘         └──────────────┘
                                   │                         │
                                   │                         │
                                   ▼                         │
                            ┌──────────────┐                 │
                            │   消息处理    │                 │
                            │  • 去重检查   │                 │
                            │  • 频率限制   │                 │
                            │  • 命令解析   │                 │
                            └──────────────┘                 │
                                   │                         │
                                   │         流式响应        │
                                   ▼ ◄───────────────────────┘
                            ┌──────────────┐
                            │   卡片更新    │ ◄── 进度轮询 (每5秒)
                            │  • 状态展示   │
                            │  • Token统计  │
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
| 飞书开放平台应用 | - | 需启用机器人能力 |

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

### 5. 启动

**终端 1 — 启动 OpenCode 服务器：**

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4096
```

**终端 2 — 启动飞书机器人：**

```bash
npm run start
```

---

## 📜 命令列表

### 📊 状态查询

| 命令 | 说明 |
|:-----|:-----|
| `/help` | 📖 查看帮助 |
| `/status` | 📊 查看当前状态（模型、角色、推理强度） |
| `/panel` | 🎛️ 显示控制面板（交互按钮） |

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
│   ├── 📄 index.ts              # 入口文件
│   ├── 📄 bot.ts                # 飞书 WebSocket 机器人（去重/限流/并发控制）
│   ├── 📄 opencode.ts           # OpenCode API 客户端（重试/超时/进度轮询）
│   ├── 📄 commands.ts           # 命令解析与处理（17 个命令）
│   ├── 📄 streaming.ts          # 流式卡片控制器
│   ├── 📄 interaction-handler.ts # 权限/问题卡片交互处理器
│   ├── 📄 session.ts            # 会话管理（TTL/淘汰）
│   └── 📄 config.ts             # 配置加载（YAML + 环境变量）
│
├── 📂 tests/
│   ├── 📄 bot.test.ts           # Bot 核心逻辑测试
│   ├── 📄 commands.test.ts      # 命令系统测试
│   └── 📄 session.test.ts       # 会话管理测试
│
├── 📂 config/
│   └── 📄 config.yaml           # YAML 配置文件
│
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

```
1. 飞书 WebSocket 收到消息事件
       ↓
2. 消息去重检查（message_id）
       ↓
3. 频率限制检查（per-user, 20/min）
       ↓
4. 添加 "Get" 表情反应
       ↓
5. 命令检测 → 命令处理
       ↓
6. 普通消息 → per-chat 互斥锁排队
       ↓
7. 发送卡片（Thinking...）
       ↓
8. 调用 OpenCode API → 等待响应
       ↓
9. 权限/问题轮询：收到请求 → 发送交互卡片 → 用户点击 → 原地更新卡片
       ↓
10. 进度轮询（每 5 秒更新卡片状态，仅在状态变化时更新）
       ↓
11. 响应完成 → 模拟流式输出 → 展示 token 统计
```

</details>

<details>
<summary>⚠️ 错误处理策略（点击展开）</summary>

| 场景 | 处理方式 |
|------|---------|
| API 请求失败 | 5xx/网络错误自动重试（最多 2 次，1-2 秒间隔） |
| 长任务超时 | 15 分钟超时（undici Agent 配置） |
| 超时后 | 不重发，避免与仍在执行的 OpenCode 任务冲突 |
| 用户中断 | `/clear` 和 `/stop` 中断请求 + 清空队列 + 停止轮询 |
| 权限卡片 | 同一请求 ID 只发送一次，用户操作后原地更新 |

</details>

---

## ❓ 常见问题

<details>
<summary><strong>🤖 机器人没有回复消息？</strong></summary>

请依次检查以下项目：

1. **OpenCode 服务器是否运行**
   ```bash
   curl http://localhost:4096/global/health
   ```

2. **飞书应用配置**
   - 是否启用了机器人能力
   - 是否配置了 WebSocket 事件订阅
   - 权限是否正确配置

</details>

<details>
<summary><strong>⏰ 长任务超时怎么办？</strong></summary>

默认超时为 **15 分钟**。超时后会提示用户，不会重发请求。

可使用 `/stop` 命令中断进行中的任务。

</details>

<details>
<summary><strong>🔄 如何切换模型？</strong></summary>

两种方式：

1. **交互式**：发送 `/models` 查看可用模型列表并点击按钮切换
2. **命令式**：发送 `/model <名称>` 直接切换

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