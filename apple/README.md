# OmniPlan 的 Shortcut 与 Alfred

## 当前入口

PWA 与私人 Capture API 是主路径；不需要安装原生 Companion。

- iPhone：导入 [`Shortcuts/添加 OmniPlan Task.shortcut`](./Shortcuts/%E6%B7%BB%E5%8A%A0%20OmniPlan%20Task.shortcut)。
- Mac：导入 [`Alfred/Distribution/OmniPlan Add Action.alfredworkflow`](./Alfred/Distribution/OmniPlan%20Add%20Action.alfredworkflow)。
- `OmniPlanCompanion/` 仅保留为历史/可选代码，不是部署或捕捉的依赖。

两个入口都把内容写入独立 Capture Inbox。Web App 拉取并成功保存后才确认删除远端记录，因此 OmniPlan 没有打开时也能记录，重试也不会制造重复任务。

## iPhone Shortcut

导入 `添加 OmniPlan Task.shortcut` 时填写：

1. 完整 Capture endpoint，例如 `https://planner.example.com/api/captures`。
2. 在设置页为这台 iPhone 生成的 `op_capture_…` Token，并把默认 Header 中的 `YOUR-CAPTURE-TOKEN` 替换掉。

Token 等同密码，不要把配置后的 Shortcut 分享给别人。需要分享模板时，先恢复占位 Token。

Shortcut 可从主屏幕、Spotlight 或分享菜单启动：

- 直接输入文字；
- 点击系统键盘麦克风听写；
- 从 Safari 分享网页，分享内容会预填在输入框中。

最短输入只有标题。需要时可写成：

```text
买牛奶
整理报税资料 | 带上去年收据 | 2026-09-18 09:30 | 45m
写方案 |  | 2026-09-18 14:00 | 1.5h
```

服务接收后会显示“已记录到 OmniPlan”。HTTP 或网络错误会停留在当前 Shortcuts 运行结果中，可以复制原输入后重试；服务端幂等键会保护已经被接收的请求。

## Alfred

双击导入 workflow 后，在终端把服务根地址和这台 Mac 的 Capture Token 存入 macOS Keychain：

```sh
./apple/Alfred/setup-alfred.zsh https://planner.example.com op_capture_...
```

使用 `oa`：

```text
oa 买牛奶
oa 整理报税资料 | 带上去年收据 | 2026-09-18 09:30 | 45m
oa !retry
```

反馈含义：

- “已接收”：服务已首次保存；
- “重复请求已忽略”：先前请求仍有效；
- “网络不可用；已安全排队”：已写入 Alfred workflow 私有 cache 的 outbox；
- “服务拒绝”：检查输入、HTTPS 地址或 Token；
- `oa !retry`：重发本机 outbox，成功后删除对应队列项。

更新旧 workflow 时不会覆盖 Keychain 配置；旧 Companion URL 已从当前分发包移除。可用以下命令检查分发前的结构：

```sh
./apple/Alfred/verify-workflow.zsh
```

## 服务端准备

完整步骤见 [`docs/product/task-first/self-hosting.md`](../docs/product/task-first/self-hosting.md)。在 Web App 的“设置 → 通知与外部快速记录”中，可以给 Shortcut 和 Alfred 分别生成 Token，也可以一次撤销全部外部 Token。
