# OpenClaw Feishu A2A Plugin v0.2.0

OpenClaw 插件，实现飞书/Lark 群聊中多个 Bot 之间的 A2A（Agent-to-Agent）协作通信，带任务状态跟踪和自动 @ 回兜底。

## 核心能力

| 能力 | 说明 |
|------|------|
| **自动发现** | 自动识别群内所有 Bot 及其 open_id，零配置 |
| **动态协作路由** | 根据 openclaw.json 中 agent 的 allowAgents 和 description 自动生成协作规则 |
| **任务状态跟踪** | 自动记录谁派发了什么任务给谁，完成没有 |
| **自动 @ 回兜底** | Worker 忘了 @ 回 Host 时，插件自动补上 `<at>` 标签 |
| **对话日志回溯** | Host 再次醒来时可看到错过的群内对话记录 |
| **角色感知** | Host 看到协作进度，Worker 看到任务提醒 |
| **格式转换** | `@botName` 文本自动转为飞书 `<at>` 标签 |
| **群成员过滤** | 只展示当前群内实际存在的 Bot |

## 前置条件

### 1. OpenClaw + openclaw-lark 插件

本插件依赖 [openclaw-lark](https://github.com/larksuite/openclaw-lark)（飞书官方 Channel 插件）提供的飞书消息通道。请先完成以下安装：

```bash
# 安装 OpenClaw（需 Node.js >= 22）
npm install -g openclaw

# 确认版本 >= 2026.3.24
openclaw -v

# 安装飞书 Channel 插件
openclaw setup
# 选择 Lark/Feishu (飞书) channel，按向导完成配置
```

> 详细的 openclaw-lark 安装和配置指南：[OpenClaw 飞书官方插件使用指南](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)

### 2. 飞书应用创建与配置

每个参与 A2A 协作的 Bot 都需要一个独立的飞书自建应用。

#### 创建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建自建应用」
3. 填写应用名称和描述
4. 在「凭证与基础信息」页面获取 **App ID** 和 **App Secret**

#### 启用机器人能力

路径：应用功能 → 机器人 → 启用

#### 配置事件订阅

路径：开发与配置 → 事件与回调

- 订阅方式：选择 **长连接**（openclaw-lark 使用 WebSocket 接收事件）
- 添加事件：
  - `im.message.receive_v1`（接收消息）
  - `application.bot.menu_v6`（机器人菜单事件，可选）

#### 配置消息卡片回传交互

路径：开发与配置 → 消息卡片回传交互

- 回传方式：选择 **使用长连接接收**

> 不开通此项会导致卡片按钮点击无反应。

### 3. 飞书应用权限

#### 基础权限（openclaw-lark 必需）

以下 20 个权限是 openclaw-lark 正常运行所必需的，在 `openclaw setup` 向导中会自动引导开通：

| 权限 | 用途 |
|------|------|
| `contact:contact.base:readonly` | 获取用户基本信息（姓名、头像） |
| `docx:document:readonly` | 读取文档内容、预览文档链接 |
| `im:chat:read` | 读取群聊信息、获取群成员列表 |
| `im:chat:update` | 修改群聊设置（群名称、群公告等） |
| `im:message.group_at_msg:readonly` | 接收群聊中 @ 机器人的消息 |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.pins:read` | 读取消息置顶状态 |
| `im:message.pins:write_only` | 置顶/取消置顶消息 |
| `im:message.reactions:read` | 读取消息表情回复 |
| `im:message.reactions:write_only` | 添加/删除消息表情回复 |
| `im:message:readonly` | 读取消息内容、历史消息 |
| `im:message:recall` | 撤回机器人发送的消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message:send_multi_users` | 批量发送私聊消息 |
| `im:message:send_sys_msg` | 发送系统通知消息 |
| `im:message:update` | 更新/编辑已发送的消息 |
| `im:resource` | 上传/下载消息资源（图片、文件等） |
| `application:application:self_manage` | 查询应用自身权限状态 |
| `cardkit:card:write` | 创建和更新消息卡片 |
| `cardkit:card:read` | 读取消息卡片状态 |

#### A2A 协作专用权限

以下权限是本插件实现 Bot 间 @ 通信的关键，**必须额外开通**：

| 权限 | 用途 |
|------|------|
| `im:message.group_at_msg.include_bot:readonly` | 接收群聊中机器人 @ 机器人的消息（A2A 核心） |

> 路径：开发者后台 → 应用 → 权限管理 → 搜索权限名 → 开通

#### 可选的用户级权限

如果你的 Agent 需要操作文档、日历、任务等飞书功能，还需要开通对应的用户级权限。openclaw-lark 支持 74 种用户级权限，按需开通即可。常用的有：

| 功能域 | 典型权限 |
|--------|---------|
| 日历 | `calendar:calendar:read`, `calendar:calendar.event:create` 等 |
| 任务 | `task:task:read`, `task:task:write` 等 |
| 多维表格 | `base:app:read`, `base:record:create` 等 |
| 云文档 | `docx:document:create`, `docx:document:write_only` 等 |
| 知识库 | `wiki:space:retrieve`, `wiki:node:read` 等 |

> 完整权限列表参见 [openclaw-lark 源码 tool-scopes.ts](https://github.com/larksuite/openclaw-lark/blob/main/src/core/tool-scopes.ts)

### 4. 发布应用

权限配置完成后，需要创建应用版本并发布（或添加到测试企业/测试群）才能生效。

路径：应用发布 → 创建版本 → 申请发布

## 安装

确保上述前置条件已满足后：

```bash
# 克隆到 OpenClaw 扩展目录
cd ~/.openclaw/extensions
git clone https://github.com/langyuhero/openclaw-feishu-a2a.git

# 重启 gateway 生效
openclaw gateway restart
```

插件会自动发现所有绑定了飞书 account 的 agent，无需额外配置。

## 工作原理

```
用户 @ 主持者 → 主持者拆解任务 @ Worker
                         ↓
              飞书原生投递：Worker 收到任务
                         ↓
              Worker 完成任务，@ 回主持者（插件自动兜底）
                         ↓
              主持者收到结果，汇总回复用户
```

### 两个 Hook

| Hook | 职责 |
|------|------|
| `before_prompt_build` | 注入 Bot 列表、协作规则、角色检测（Host/Worker/调度者）、动态路由、对话日志回溯 |
| `message_sending` | `@name` → `<at>` 标签替换、任务派发追踪、**Worker 自动 @ 回兜底**、任务完成检测、消息日志记录 |

### 任务状态跟踪

插件在 `~/.openclaw/fbc-registry/sessions.json` 中维护协作状态：

- Host @ Worker → 自动创建 session + task（状态：dispatched）
- Worker @ 回 Host → 自动标记 task completed
- 所有 task 完成 → 提示 Host 汇总结果
- 2 小时无活动 → 自动过期清理

### 自动 @ 回兜底

飞书的 mention-only 投递模式下，Bot 不加 `<at>` 标签就等于消息丢失。插件在 `message_sending` 中检测：如果 Worker 有未完成的任务但回复中没有 @ Host，自动在消息开头补上 `<at>` 标签，确保 Host 收到回传。

### 对话日志回溯

当 Host 不在线时（例如用户直接 @ 了其他 agent 多轮对话），插件会在 session 中记录所有消息摘要。Host 下次被唤醒时，`before_prompt_build` 会注入这些错过的对话记录，让 Host 能做出明智的判断。

## 动态协作路由

插件从 `openclaw.json` 自动读取每个 agent 的配置，动态生成协作规则：

| 配置字段 | 用途 |
|---------|------|
| `agents.list[].name` | Bot 显示名称 |
| `agents.list[].description` | 角色描述（展示给其他 agent） |
| `agents.list[].subagents.allowAgents` | 该 agent 可以 @ 调度的 agent 列表 |
| `agents.list[].default: true` | 标记为主持者（自动注入调度指引） |

**示例：** 如果你有一个决策 agent 可以调度搜索 agent：

```json
{
  "agents": {
    "list": [
      {
        "id": "strategist",
        "name": "谋远",
        "description": "决策分析顾问",
        "subagents": { "allowAgents": ["researcher"] }
      },
      {
        "id": "researcher",
        "name": "司南",
        "description": "搜索与调研",
        "subagents": { "allowAgents": [] }
      }
    ]
  }
}
```

插件会自动在谋远的 prompt 中注入："当任务需要数据/事实支撑时，可以 @ 司南（搜索与调研）协作"。

### 群聊强制规则

插件自动注入以下规则，防止 agent 走内部通信通道：

> 在群聊中，所有跨 agent 通信必须通过群里 @ 发消息。禁止使用 sessions_spawn、sessions_send 等内部通信工具。

## 配置（可选）

默认零配置即可工作。如需手动指定 Bot 列表，可在 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "entries": {
      "openclaw-feishu-a2a": {
        "enabled": true,
        "config": {
          "botRegistry": {
            "agent-id": {
              "accountId": "feishu-account-id",
              "botOpenId": "ou_xxxxxxxxxxxxxxxx",
              "botName": "显示名称",
              "description": "角色描述（可选）"
            }
          }
        }
      }
    }
  }
}
```

## 使用案例

### 案例 1：调研 + 写作（串行协作）

> 场景：用户想写一篇关于某行业的公众号文章

```
👤 用户：@维嘉 帮我写一篇关于有机蔬菜行业发展的公众号文章

🤖 维嘉：收到！我先确认几个关键点：
         1. 目标读者是消费者还是从业者？
         2. 篇幅大概多少字？
         3. 有没有需要突出的重点方向？

👤 用户：写给普通消费者看，1500字左右的短文，公众号风格

🤖 维嘉：明白了。我的分工计划：
         1. 先让司南调研有机蔬菜行业最新数据和趋势
         2. 再让灵犀基于调研结果撰写公众号文章
         确认后我开始派发？

👤 用户：可以，开始吧

🤖 维嘉：@司南 请调研有机蔬菜行业最新发展趋势……
         完成后请 @ 回我汇报结果。

🤖 司南：@维嘉 调研完成！以下是关键发现：
         1. 2025年有机蔬菜市场规模达XXX亿……
         ……

🤖 维嘉：（收到司南调研结果，继续派发）
         @灵犀 请基于以下调研材料，写一篇公众号短文……

🤖 灵犀：@维嘉 文章已完成！……

🤖 维嘉：（所有任务完成，汇总回复用户）
```

---

### 案例 2：直接跨 Agent 协作

> 场景：用户直接 @ 谋远问一个需要数据支撑的问题

```
👤 用户：@谋远 成都有哪些适合办聚会的酒店？

🤖 谋远：（看到动态路由：司南可协作）
         @司南 帮我搜索成都适合办朋友聚会的酒店，要求：
         - 有会议室或大房间
         - 20人左右规模
         - 交通方便

🤖 司南：@谋远 搜索完成，推荐以下几个：
         1. xxx酒店 — 优点……
         ……

🤖 谋远：基于司南的调研，给你推荐这几个方案：
         ……（分析各选项优劣）
```

**要点：** 插件根据 allowAgents 配置，谋远知道可以调度司南，自动在需要数据时发起协作。

---

### 案例 3：中途取消

```
👤 用户：@维嘉 等一下，方案先不做了

🤖 维嘉：收到，已停止协作。
         🔕仅通知 @码力 任务已取消，无需继续。
```

**要点：** 用 🔕仅通知 告知正在工作的 Agent，不会触发对方 @ 回。

## 调试

```bash
# 查看实时日志
tail -f ~/.openclaw/extensions/openclaw-feishu-a2a/logs/a2a-debug-$(date +%Y-%m-%d).log

# 查看任务状态
cat ~/.openclaw/fbc-registry/sessions.json | python3 -m json.tool
```

## 文件结构

```
openclaw-feishu-a2a/
├── index.js                 # 主插件（2 个 hooks）
├── lib/
│   └── session-store.js     # 任务状态 + 消息日志持久化
├── openclaw.plugin.json     # 插件清单
├── package.json
├── skills/
│   ├── a2a-host-protocol/   # 主持者协议
│   ├── a2a-worker-protocol/ # 执行者协议
│   └── a2a-message-format/  # 消息格式规范
└── HOOK.md                  # Hook 说明文档
```

## Credits

- **Leochens** — 原始 [feishu-bot-chat-plugin](https://github.com/Leochens/feishu-bot-chat-plugin) 作者，实现了自动发现、@ 标签替换、消息过滤等核心功能。[GitHub](https://github.com/Leochens) | [B站](https://space.bilibili.com/351188457)
- **langyuhero** — v0.1.0 起基于原始插件大幅重写，v0.2.0 修复 hook 兼容性、新增消息日志回溯、动态路由、禁用内部通信

## License

MIT
