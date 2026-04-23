# OpenCode Feishu Bot

将 OpenCode 接入飞书机器人，让用户在飞书聊天中直接与 OpenCode 对话。

## 功能特点

- 🤖 **WebSocket 长连接**：无需公网 IP，本地即可运行
- 💬 **流式回复**：打字机效果，实时显示 AI 回复
- 🔄 **会话管理**：每个飞书用户/群聊独立会话上下文
- 📱 **支持群聊**：群聊中 @ 机器人触发对话

## 架构

```
飞书用户发消息 → WebSocket 接收 → OpenCode HTTP API → 流式卡片回复
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
   - `im:message` - 获取与发送消息
   - `im:message:send_as_bot` - 以应用身份发消息
   - `im:message:update` - 更新消息
   - `cardkit:card:write` - 创建和更新卡片

### 5. 启动

**终端 1 - 启动 OpenCode 服务器：**

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4096
```

**终端 2 - 启动飞书机器人：**

```bash
npm run start
```

### 6. 测试

在飞书中给你的机器人发消息，OpenCode 会回复！

## 项目结构

```
opencode-feishu-bot/
├── src/
│   ├── index.ts          # 入口文件
│   ├── bot.ts            # 飞书 WebSocket 机器人
│   ├── opencode.ts       # OpenCode API 客户端
│   ├── streaming.ts      # 流式卡片控制器
│   ├── session.ts        # 会话管理
│   └── config.ts         # 配置加载
├── config/
│   └── config.yaml       # YAML 配置文件
├── .env.example          # 环境变量示例
├── package.json
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

# 构建
npm run build
```

## 常见问题

### Q: 机器人没有回复消息？

检查：
1. OpenCode 服务器是否运行：`curl http://localhost:4096/global/health`
2. 飞书应用是否启用了机器人能力
3. 飞书应用是否配置了 WebSocket 事件订阅
4. 权限是否正确配置

### Q: 如何支持群聊？

在群聊中 @ 机器人即可触发对话。机器人会自动过滤掉没有 @ 的消息。

### Q: 如何自定义 OpenCode 模型？

在 OpenCode 配置文件 `~/.config/opencode/opencode.json` 中配置默认模型。

## License

MIT
