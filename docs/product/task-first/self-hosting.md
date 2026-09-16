# OmniPlan Personal 自托管方案

## 结论

使用一个 HTTPS 域名运行同一套 Bun 服务。它同时提供 PWA 静态文件、私人 Capture API 和最小 Web Push 服务。Mac Chrome 与 iPhone 主屏幕 Web App 打开同一地址，因此不需要 App Store，也不需要 Apple Developer Program。

工作区正文继续留在浏览器，并通过既有 Firebase E2EE 通道同步。这个服务只保存：

- 等待 Web App 消费的外部 Capture，默认保留 7 天；
- 每台设备的 PushSubscription；
- 提醒时间、路由、修订号，以及用户明确选择后才包含的标题；
- Token 的 SHA-256 hash，而不是原始 Token。

## 本地准备

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run vapid
bun server/cli.ts token create "Web app" owner
bun run build
bun run build:server
bun run serve
```

将 VAPID 命令输出写进部署环境的 `VAPID_PUBLIC_KEY` 与 `VAPID_PRIVATE_KEY`，把私钥作为 secret 管理，不要提交到仓库。Owner Token 只显示一次，也应立即放入密码管理器。`OMNIPLAN_API_ADMIN_TOKEN` 与 `OMNIPLAN_CRON_TOKEN` 使用各自独立的高熵随机值。

同时把 Firebase Web 的公开传输参数写入部署环境：

```text
OMNIPLAN_FIREBASE_PROJECT_ID=...
OMNIPLAN_FIREBASE_WEB_API_KEY=...
OMNIPLAN_FIREBASE_DATABASE_ID=(default)
OMNIPLAN_FIREBASE_COLLECTION_PATH=omniPlanSync
OMNIPLAN_FIREBASE_WORKSPACE_ID=personal
```

服务只会通过 `/api/client-config` 返回这些公开 Web 参数；工作区口令、Owner Token、VAPID 私钥与管理 Token 绝不能进入这个响应。

浏览器第一次连接核心 Workspace 只需要：

1. 输入工作区口令。
2. 点击“连接这台设备”；页面会先验证解密，再拉取 Workspace、记住本机口令并开启自动同步。

需要通知、Shortcut 或 Alfred 时，再展开“私人服务连接”，填入一次性显示的 `op_owner_…` Token。HTTPS 根地址默认使用当前域名，轮询间隔与 Firebase 原始字段都留在高级设置中。

## Docker 部署

```sh
docker build -t omniplan-personal .
docker run -d \
  --name omniplan-personal \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  --env-file .env \
  -v omniplan-data:/app/.data \
  omniplan-personal
```

数据库必须挂载持久卷。服务进程以非 root 用户运行。升级前备份该卷以及浏览器导出的 Workspace 文件。

## HTTPS 反向代理

生产环境必须由反向代理终止 TLS，并传递 `X-Forwarded-Proto: https`。例如 Caddy：

```text
planner.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

保持 `OMNIPLAN_REQUIRE_HTTPS=1`。只有本机开发才使用 `OMNIPLAN_REQUIRE_HTTPS=0`。防火墙需要允许服务向订阅中提供的标准 Web Push HTTPS endpoint 发起 443 出站请求，并明确允许 `*.push.apple.com`。Apple 确认标准 Web Push 不要求加入 Apple Developer Program，见 [WebKit 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。

## Capture API 契约

外部设备使用独立的 `op_capture_…` Token：

```http
POST /api/captures
Authorization: Bearer op_capture_…
Content-Type: application/json
Idempotency-Key: shortcut-stable-request-id

{"title":"整理报税资料 | 带上去年收据 | 2026-09-18 09:30 | 45m","source":"shortcut"}
```

支持的单行语法是：

```text
标题 | 可选说明 | YYYY-MM-DD HH:mm | 30m
标题 | 可选说明 | YYYY-MM-DD HH:mm | 1.5h
```

只有标题必填。时间和工作量不会触发额外表单。`201` 表示首次接收，`200` 且 `status: duplicate` 表示相同幂等键已经接收。Web App 用 Owner Token 拉取 `/api/captures`，本地保存成功后调用 `/api/captures/ack` 删除服务端副本。

## Push 生命周期

- Web App 只在用户点击按钮后请求权限。
- iPhone 普通 Safari 标签页会显示“先添加到主屏幕”，不会误报为可订阅；主屏幕 Web App 仍需由用户点击“开启通知”触发权限请求。这两项限制与 [WebKit 的平台要求](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) 一致。
- 默认通知正文不含任务标题；设置页可显式开启标题。
- 修改或删除计划会用更高修订号覆盖或取消旧提醒。
- 服务每分钟尝试发送到期提醒；404/410 endpoint 会自动移除。
- 通知点击复用已有窗口，并定位到对应日期和 Task。

## 运维检查

```sh
curl -fsS https://planner.example.com/api/health
bun server/cli.ts token list
bun server/cli.ts token revoke TOKEN_ID
```

发生问题时，先确认健康检查、持久卷、反向代理的 HTTPS header 和设备系统通知权限。Capture 网络失败不会影响 Web App 内的本地记录；Alfred 会进入本机 outbox。推送失败也不会删除 Workspace 任务。

## 备份与回滚

发布前从设置页导出 Workspace，并记录导出文件 checksum；同时备份 SQLite 持久卷。前端升级失败时可以回滚容器镜像，再导入原 Workspace。不要用旧设备的未同步副本直接覆盖较新的 Workspace；现有同步层会把 checksum/版本冲突呈现为显式冲突。
