# OpenCode Feishu Bot

将 OpenCode 接入飞书机器人，让用户在飞书聊天中直接与 OpenCode 对话。

## 功能特点

- 🤖 **WebSocket 长连接**：无需公网 IP，本地即可运行
- 💬 **流式回复**：打字机效果，实时显示 AI 回复
- 🔄 **会话管理**：每个飞书用户/群聊独立会话上下文
- 📱 **支持群聊**：群聊中 @ 机器人触发对话
- 🛡️ **消息去重**：基于 message_id 防止飞书重复投递
- ⏱️ **频率限制**：每用户每分钟 20 条消息上限
- 🔒 **并发控制**：同一会话消息串行处理，避免冲突
- 📊 **Token 统计**：回复卡片底部展示输入/输出/缓存 token 数
- 👍 **消息反应**：收到消息自动添加 "Get" 表情
- ⏳ **进度轮询**：长任务每 8 秒更新卡片状态（工具名、耗时）
- 🔁 **自动重试**：API 请求 5xx/网络错误自动重试（最多 2 次）
- 🎛️ **丰富命令**：模型切换、角色切换、推理强度、会话管理等

## 架构

```
飞书用户发消息 → WebSocket 接收 → OpenCode HTTP API → 流式卡片回复
                                                    ↑
                                         进度轮询 (每8秒) → 更新卡片状态
```

## 快速开始

### 1. 前置条件

- Node.js 20+
- OpenCode CLI 已安装
- 飞书开放平台应用（启用机器人能力）

### 2. 安装依赖

```bash
cd opencode-feishu-bot
npm install
```

### 3. 配置

复制配置文件：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 飞书应用配置
LARK_APP_ID=cli_xxxxxxxxx
LARK_APP_SECRET=your_app_secret
LARK_DOMAIN=feishu  # 国际版用 lark

# OpenCode 服务器配置
OPENCODE_SERVER_URL=http://localhost:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=your-password
```

### 4. 飞书应用配置

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 启用机器人能力
4. 配置事件订阅：启用 WebSocket 模式
5. 添加权限：
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以应用身份发消息
   - `im:message:update` — 更新消息
   - `im:message.reactions:write_only` — 发送消息表情回复

### 5. 启动

**终端 1 — 启动 OpenCode 服务器：**

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4096
```

**终端 2 — 启动飞书机器人：**

```bash
npm run start
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/status` | 查看当前状态（模型、角色、推理强度） |
| `/panel` | 显示控制面板（交互按钮） |
| `/model` | 查看当前模型 |
| `/model <名称>` | 切换模型（支持模糊搜索） |
| `/models` | 列出所有可用模型 |
| `/agent` | 查看当前角色 |
| `/agent <名称>` | 切换角色 |
| `/agents` | 列出所有可用角色 |
| `/effort` | 查看当前推理强度 |
| `/effort <low\|medium\|high>` | 设置推理强度 |
| `/session new` | 开启新话题 |
| `/sessions` | 列出会话 |
| `/rename <名称>` | 重命名会话 |
| `/stop` | 停止当前回答 |
| `/compact` | 压缩上下文 |
| `/clear` | 重置对话上下文 |

## 项目结构

```
opencode-feishu-bot/
├── src/
│   ├── index.ts          # 入口文件
│   ├── bot.ts            # 飞书 WebSocket 机器人（去重/限流/并发控制）
│   ├── opencode.ts       # OpenCode API 客户端（重试/超时/进度轮询）
│   ├── commands.ts       # 命令解析与处理（17 个命令）
│   ├── streaming.ts      # 流式卡片控制器
│   ├── session.ts        # 会话管理（TTL/淘汰）
│   └── config.ts         # 配置加载（YAML + 环境变量）
├── tests/
│   ├── bot.test.ts       # Bot 核心逻辑测试
│   ├── commands.test.ts  # 命令系统测试
│   └── session.test.ts   # 会话管理测试
├── config/
│   └── config.yaml       # YAML 配置文件
├── .env.example          # 环境变量示例
├── package.json
├── tsconfig.json
└── README.md
```

## 配置说明

### config.yaml

```yaml
feishu:
  app_id: "${LARK_APP_ID}"
  app_secret: "${LARK_APP_SECRET}"
  domain: "feishu"  # 或 "lark"

opencode:
  server_url: "${OPENCODE_SERVER_URL:http://localhost:4096}"
  username: "${OPENCODE_USERNAME:opencode}"
  password: "${OPENCODE_PASSWORD}"

session:
  ttl: 3600          # 会话过期时间（秒）
  max_sessions: 100  # 最大并发会话数

streaming:
  update_interval: 500   # 卡片更新间隔（毫秒）
  min_chunk_size: 10     # 最小更新文本长度
```

## 开发

```bash
# 开发模式（热重载）
npm run dev

# 类型检查
npm run typecheck

# 运行测试
npm test

# 构建
npm run build
```

## 技术细节

### 消息处理流程

1. 飞书 WebSocket 收到消息事件
2. 消息去重检查（message_id）
3. 频率限制检查（per-user, 20/min）
4. 添加 "Get" 表情反应
5. 命令检测 → 命令处理
6. 普通消息 → per-chat 互斥锁排队
7. 发送卡片（Thinking...）
8. 调用 OpenCode API → 等待响应
9. 进度轮询（每 8 秒更新卡片状态）
10. 响应完成 → 模拟流式输出 → 展示 token 统计

### 错误处理

- API 请求：5xx/网络错误自动重试（最多 2 次，1-2 秒间隔）
- 长任务超时：15 分钟（undici Agent 配置）
- 超时后不重发：避免与仍在执行的 OpenCode 任务冲突
- `/clear` 和 `/stop`：中断进行中的请求 + 停止进度轮询

## 常见问题

### Q: 机器人没有回复消息？

检查：
1. OpenCode 服务器是否运行：`curl http://localhost:4096/global/health`
2. 飞书应用是否启用了机器人能力
3. 飞书应用是否配置了 WebSocket 事件订阅
4. 权限是否正确配置

### Q: 如何支持群聊？

在群聊中 @ 机器人即可触发对话。机器人会自动过滤掉没有 @ 的消息。

### Q: 长任务超时怎么办？

默认超时为 15 分钟。超时后会提示用户，不会重发请求。可使用 `/stop` 中断。

### Q: 如何切换模型？

发送 `/models` 查看可用模型列表并点击按钮切换，或发送 `/model <名称>` 直接切换。

## License

MIT