# OmniPlan Task-first 实施与验收状态

**状态：** Phase 0–6 本地实现与本地验收完成；真实 Mac/iPhone 推送与跨设备同步待部署后验收  
**产品规格：** [Task-first 产品规格](./product-spec.md)  
**自托管：** [自托管方案](./self-hosting.md)  
**基线：** `main` / `2bc774806c7ed47fb8270ce084312c0d2ecb461b`  
**本轮核验日期：** 2026-09-16（Asia/Tokyo）

## 1. 结论

最初的判断是“底层高级能力较完整，但最终用户的日常主路径只完成了一半”。这不是一个需要重写的空壳：调度、依赖、Gantt、资源、重复任务、审查、报告、EVM、Monte Carlo、加密同步与冲突保护均可复用；真正缺失的是 Task-first 的产品收口。

现在，本地版本已经完成这次收口：

- 所有内容先作为只需标题即可保存的 Task；保存不要求项目、时间、工作量或审查字段。
- Today 同时展示一天的时间形状、工作量、容量、未安排事项和当前任务的直接依赖。
- Projects 默认保持简单，依赖、资源、Gantt、基线和审查通过二级区域按需展开。
- 产品是响应式 PWA；Mac Chrome 与 iPhone 主屏幕 Web App 共用同一部署，不依赖 App Store。
- Shortcut、Alfred、Web Share Target 和 Web App 内捕捉使用同一语义，外部入口通过私人 Capture API 进入 Inbox。
- 标准 Web Push、VAPID、最小提醒信封、订阅管理和通知点击路由已实现；真实设备送达仍必须在 HTTPS 部署后验证。
- 视觉已统一为 shadcn-compatible 的“温润工具”：暖灰底、象牙白表面、深靛蓝主色、鼠尾草绿完成态、焦糖琥珀风险态、细边框、低阴影与 8px 左右圆角。

## 2. Phase 完成情况

### Phase 0：安全基线与迁移

- [x] 产品规格与桌面/移动视觉基准成为实现事实来源。
- [x] 设置页支持明文 Workspace 备份、导入与 schema 2 回滚包导出。
- [x] 回归 fixture 覆盖 Todo、Project、WorkItem、依赖、资源、重复历史、证据和 ChangeSet。
- [x] 迁移演练验证源备份不变、schema 3 输出可读、回滚包可生成且全部实体 ID 保持稳定。
- [x] 多标签页分歧会进入显式冲突状态，不做静默 last-write-wins。
- [x] 旧 Fluent 方向已标为被 Task-first 视觉取代；旧预览页已移除。
- [x] 新 Today 直接成为默认入口，因此不再保留临时 feature flag。

### Phase 1：统一 Task 与瞬间记录

- [x] `TaskView` 统一投影 Todo 与 WorkItem，`TaskRef` 在转换前后保持同一 ID。
- [x] `CaptureTaskCommand` 只要求标题，支持来源、幂等键、说明、日期、时间与工作量。
- [x] Today、Inbox、全局快捷键、Share Target 和外部 Capture 最终都进入同一 Task 捕捉语义。
- [x] 本地保存立即返回 receipt；远端同步状态独立，不把网络当作保存条件。
- [x] 捕捉后可直接撤销；连续捕捉、空白标题、重复幂等键与中文输入法组合均有测试。
- [x] WorkItem 标题和说明可编辑，保存时保留 ID、父子、日期、进度、依赖、证据与重复规则。

### Phase 2：Today Flow

- [x] `selectDayPlan(date)` 合并独立 Task 与 Project WorkItem，并按工作区时区归日。
- [x] 同时展示计划时段、工作量、当天容量、剩余/超出容量和未安排数量。
- [x] 桌面使用 08:00–20:00 时间轴；零时长任务、跨午夜任务和跨日延续均有明确显示。
- [x] 当前 Project Task 只展开直接前置与直接后续；阻塞、完成、关键路径与风险使用文字和色彩双重语义。
- [x] 时间、工作量、完成/恢复可直接操作；不会静默重排已经承诺的计划。
- [x] iPhone 使用压缩日程概览和纵向 Task 列表，不渲染缩小版桌面表格。
- [x] 390 × 844、640px 等效 200% 缩放、安全区、触控目标和无横向溢出已本地验证。

### Phase 3：Projects 按需展开

- [x] 一级导航收敛为“今天 / 收件箱 / 项目”；设置保持二级入口。
- [x] Calendar 从 Today 进入；Portfolio、Review、Reports、Agent 不再占据一级导航。
- [x] Project 首屏先展示结果、下一步、风险摘要和 Task Outline。
- [x] Advanced planning 默认折叠；展开后提供资源、依赖、Gantt、Network、基线、实际投入与关闭控制。
- [x] Todo 可转换为普通 Project 或 OmniPlan Project，保留标题、说明、时间、工作量、完成状态、稳定引用和转换历史。
- [x] 默认单人资源不制造管理负担；添加第二个资源后才显示完整分配能力。
- [x] 严格生命周期只属于显式选择的项目规划方式，不阻塞普通 Task 捕捉。
- [x] Gantt 和依赖网络保留完整可访问文本替代。

### Phase 4：PWA、同步与 Web Push

- [x] Manifest 含稳定 ID、standalone、192/512 图标、maskable 图标、快捷入口与 Share Target。
- [x] Service Worker 使用版本化 App Shell、页面 network-first、静态 stale-while-revalidate、旧缓存清理和更新提示。
- [x] 已验证离线打开、离线连续捕捉、离线刷新后仍存在以及恢复在线后的正常加载。
- [x] Share Target 可把标题、正文和 URL 合并为真实 Inbox Task。
- [x] 设置页通过能力检测区分不支持、需安装、被拒绝、可订阅和已订阅状态；权限只由用户按钮触发。
- [x] 标准 Web Push 订阅/取消、VAPID 发送、404/410 失效清理、点击复用现有窗口和深链路由均已实现。
- [x] SQLite 服务只保存 Capture、PushSubscription 和最小提醒信封；Token 只存 hash，默认通知不包含 Task 标题。
- [x] 提醒支持修订、取消、去重、频率限制、大小限制、失败记录与到期清理。

### Phase 5：Shortcut 与 Alfred

- [x] `POST /api/captures`、Owner 拉取/确认、独立设备 Token 创建/撤销、幂等、限流与保留期已实现并测试。
- [x] 已输出可导入且已签名的 iPhone Shortcut，支持键入、听写键盘和分享内容；只有标题必填。
- [x] Shortcut 失败不会被误报为成功；重试由稳定幂等键保护，Token 明确按密码处理。
- [x] Alfred `oa` 已改为 Capture API，服务地址和 Token 存入 macOS Keychain。
- [x] Alfred 网络失败进入本地 outbox，`oa !retry` 可重试；反馈区分已接收、重复、排队与拒绝。
- [x] 分发包结构和脚本执行权限通过 `verify-workflow.zsh` 校验；旧 Companion 保留为历史代码而非依赖。

### Phase 6：视觉、性能与本地发布验收

- [x] “温润工具”语义 token 已落地；移除 serif 标题、重阴影、玻璃效果、过量卡片和旧 Fluent 假设。
- [x] Today、Inbox、Task Capture、Connectivity、PWA Notice、Gantt 和 Reports 已拆为 feature 模块。
- [x] App、Agent、Gantt、Reports、Risk 与 Monte Carlo 按需拆包；初始入口不再是单个约 692 KB 主包。
- [x] 桌面 1280 × 720、移动 390 × 844 与 640px 等效 200% 宽度通过视觉和交互验收。
- [x] 浏览器控制台无 error/warning；主要页面无文档级横向溢出。
- [x] 工作区时区统一用于 Today、Calendar、Project、Outline、Gantt、Risk、Reports 和侧栏日期。
- [x] 完整前端、服务端、迁移、Service Worker、类型与生产构建检查通过。

## 3. 2026-09-16 本地验收记录

| 检查 | 结果 |
| --- | --- |
| TypeScript | `bunx tsc --noEmit` 通过 |
| 前端测试 | 25 个测试文件、168 个测试通过 |
| 服务端测试 | 9 个测试通过 |
| 服务端构建 | `bun run build:server` 通过 |
| 生产构建 | `bun run build` 通过 |
| 包体积 | App 341.27 KB；React vendor 180.54 KB；Gantt 13.07 KB；Reports 8.27 KB（均为未压缩输出） |
| Alfred | 分发包与可执行脚本校验通过 |
| 桌面浏览器 | 1280 × 720；捕捉、撤销、时间/工作量、完成/恢复、转换项目、依赖、资源、Gantt 通过 |
| 移动浏览器 | 390 × 844；三入口底栏、快速捕捉、Task 标题直达编辑、默认折叠高级区、无横向溢出通过 |
| 200% 等效宽度 | 640px viewport 下 `scrollWidth === innerWidth` |
| PWA 离线 | 停止服务器后仍可打开 Today；离线捕捉两项并刷新后仍保留 |
| Web Share Target | 分享标题、正文和 URL 成功形成一个 Inbox Task |
| 运行时 | 最终桌面/移动复核控制台均无 error/warning |

浏览器证据位于 [`qa/`](./qa/)：

- [`today-desktop-dependencies.png`](./qa/today-desktop-dependencies.png)
- [`today-mobile-dependencies.png`](./qa/today-mobile-dependencies.png)
- [`project-mobile-collapsed.png`](./qa/project-mobile-collapsed.png)
- [`project-advanced-desktop.png`](./qa/project-advanced-desktop.png)

## 4. 仍需真实环境完成的外部验收

以下不是缺少实现代码，而是必须依赖正式 HTTPS 域名、真实设备权限和用户账户状态，不能由本地浏览器模拟得出“已送达”的结论：

- [ ] 部署 Bun 服务并配置持久卷、VAPID、反向代理 HTTPS 与标准 Push endpoint 的 443 出站访问。
- [ ] Mac Chrome：实际授权、前台/后台/关闭标签送达、点击复用窗口、取消订阅。
- [ ] iPhone：Safari 添加到主屏幕、用户手势授权、锁屏通知、点击跳转、Focus 模式行为。
- [ ] Mac 与 iPhone 使用同一加密 Workspace 做真实双向同步和冲突演练。
- [ ] 在真实 iPhone 导入 Shortcut、写入设备 Token 并完成一次失败重试。
- [ ] 在真实 Alfred 导入 workflow、写入 Keychain 配置并从 outbox 完成一次重试。

Apple 平台限制与部署步骤见 [自托管方案](./self-hosting.md)。原生 Companion 和 Xcode 工程不是 Task-first PWA 的发布依赖；本机尚未接受 Xcode license 不阻塞这条路径。

## 5. 发布判断

本地工作树已经达到“可部署候选”状态，不再是只完成一半。唯一不能在当前环境宣称完成的是外部设备送达与真实跨设备同步。完成上节六项后，才可把产品状态从“本地实现完成”改为“生产验收完成”。
