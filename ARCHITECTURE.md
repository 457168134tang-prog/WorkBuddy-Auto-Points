# 项目架构与开发规则

## 1. 目标

- 模块职责单一，避免功能堆叠到少数大文件。
- 依赖方向固定，禁止循环依赖和跨层调用。
- UI 不承载业务逻辑，后台不直接操作 DOM。
- 外部协议、存储结构、文案、消息类型集中管理。
- 新功能先归位，再实现；不允许复制粘贴形成重复能力。

## 2. 当前形态

当前是 Chrome / Edge Manifest V3 插件：

```text
manifest.json     扩展声明与权限
background.js     后台服务、API、业务编排、消息处理
popup.html        弹窗结构
popup.js          弹窗交互与渲染
popup.css         弹窗样式
icons/            图标资源
LICENSE / README  许可与说明
```

当前文件是扁平结构。后续新增功能不再继续堆入 `background.js` 和 `popup.js`，应按第 4 节目标结构拆分；现有文件可暂作入口和兼容层。

## 3. 分层与职责

| 层 | 目标目录 | 职责 | 禁止 |
|---|---|---|---|
| 平台层 | `src/platform/` | 封装 `chrome.storage`、`chrome.cookies`、`chrome.alarms`、`chrome.tabs`、`chrome.notifications`、`chrome.runtime` | 不写业务逻辑 |
| 共享层 | `src/shared/` | 常量、消息类型、错误类型、文案、纯工具函数 | 不依赖任何上层 |
| 领域层 | `src/domain/` | 账号、积分、每日领取、行程奖励、快照、站点规则 | 不直接调用 `chrome.*`，不操作 DOM |
| 服务层 | `src/services/` | 会话切换、刷新编排、通知汇总、站点适配 | 不直接渲染 UI |
| 应用层 | `src/background/`、`src/popup/` | 后台消息路由；弹窗动作分发 | 不实现复杂业务细节 |
| 内容层 | `src/content/` | 未来页面 DOM 读取、注入脚本 | 不直接写存储、不直接发起业务 API |

依赖方向：

```text
popup / content  →  runtime 消息  →  background router  →  services  →  domain  →  shared / platform
```

下层不得反向依赖上层。

## 4. 代码组织规范

目标目录：

```text
src/
  platform/
    storage.js
    cookies.js
    alarms.js
    tabs.js
    notifications.js
    runtime.js
  shared/
    constants.js
    messages.js
    errors.js
    strings.js
    utils.js
  domain/
    accounts.js
    snapshots.js
    credits.js
    daily.js
    journey.js
    sites.js
  services/
    session.js
    sync-engine.js
    notifier.js
  background/
    index.js
    router.js
  popup/
    index.js
    render.js
    actions.js
  content/
    extractor.js
icons/
manifest.json
README.md
ARCHITECTURE.md
LICENSE
```

目录规则：

- 一个目录只放一层职责的代码。
- 单文件只解决一个主题。
- 超过 300 行或出现两个明显职责时，必须拆分。
- 不允许创建 `utils.js` 垃圾桶；工具函数必须有明确主题。
- 临时脚本、截图、测试产物不得提交到仓库。

## 5. 命名约定

- 文件名：`kebab-case.js`，例如 `sync-engine.js`。
- 函数：小驼峰 + 动词开头，例如 `loadState()`、`refreshAccounts()`。
- 类：大驼峰，例如 `SiteAdapter`。
- 常量：`UPPER_SNAKE_CASE`，例如 `DEFAULT_SITE`。
- 消息类型：`UPPER_SNAKE_CASE`，例如 `SYNC_ALL`。
- DOM id：小驼峰，例如 `claimBtn`。
- CSS 类：`kebab-case`，例如 `trip-actions`。
- `data-act`：与消息类型一致，使用 `UPPER_SNAKE_CASE`。
- 存储键：小驼峰；新增键必须兼容旧数据，禁止直接覆盖。
- 用户可见文案：统一放入 `src/shared/strings.js`，禁止散落硬编码。

## 6. 功能归属表

| 功能 | 唯一归口 |
|---|---|
| 账号增删改查、切换账号 | `domain/accounts.js` |
| 快照初始化、读取、更新 | `domain/snapshots.js` |
| 积分查询、字段清洗 | `domain/credits.js` |
| 每日领取状态与领取动作 | `domain/daily.js` |
| 行程状态、领取、出发 | `domain/journey.js` |
| 站点识别、域名规则 | `domain/sites.js` |
| Cookie 切换与恢复 | `services/session.js` |
| 全量刷新、并发控制 | `services/sync-engine.js` |
| 成功/失败通知汇总 | `services/notifier.js` |
| 后台消息分发 | `background/router.js` |
| 弹窗渲染 | `popup/render.js` |
| 弹窗按钮动作 | `popup/actions.js` |
| 页面 DOM 读取 | `content/extractor.js` |

新功能若找不到明确归口，先新增归口，再实现功能。

## 7. 功能开发准入规则

每个新功能进入代码前，必须完成以下检查：

1. **归类**：明确属于平台层、共享层、领域层、服务层、应用层还是内容层。
2. **查重**：搜索是否已有相同或相近能力，禁止重复实现。
3. **接口**：先定义输入、输出、错误类型，再写实现。
4. **依赖**：确认依赖方向合法，不产生循环依赖。
5. **消息**：新增消息类型必须同步更新 `shared/messages.js`、后台 router、弹窗动作。
6. **存储**：新增存储字段必须提供默认值和旧数据兼容。
7. **API**：新增外部 API 只能放在 domain 或 platform 封装中，禁止散落 `fetch()`。
8. **文案**：按钮、提示、通知、错误信息统一放入 `shared/strings.js`。
9. **UI**：弹窗交互统一走 `data-act` 和事件委托，禁止散落临时监听器。
10. **回归**：检查是否会改变刷新、账号切换、通知、导出等既有流程。

## 8. 可扩展性约束

- 外部站点差异必须通过适配器处理，禁止在业务流程里写站点判断。
- 业务操作必须幂等；重复刷新不能重复领取或重复通知。
- 所有异步流程必须有并发保护，避免多账号切换串号。
- 错误信息必须分类：登录失效、网络失败、业务失败、未知错误。
- 存储结构变更必须向后兼容，必要时提供迁移函数。
- 用户凭据只保留在本地，不上传、不日志化、不进入错误信息。
- 通知、文档、UI 文案必须语义明确，禁止“今日已满”这类模糊表述。
- 后台脚本启动必须能独立运行，不依赖弹窗打开。
- 未知消息、未知站点、未知错误必须有兜底处理。

## 9. 可维护性约束

- 禁止在渲染函数里修改业务状态。
- 禁止在领域层直接读写 DOM 或 `chrome.*`。
- 禁止在弹窗里直接调用业务 API。
- 禁止多个模块共用可变全局对象；状态统一由 store 管理。
- 禁止重复硬编码域名、路径、消息名、文案。
- 每个新增模块必须能被单独理解和替换。
- 任何按钮、消息、配置项都必须有唯一来源。
- 每次提交前执行：语法检查、消息契约检查、按钮动作检查、URL 检查、工作区检查。

## 10. 变更记录要求

新增或修改模块时，必须同步更新本文档的：

- 功能归属表
- 目录结构
- 消息类型说明
- 存储字段说明

如未同步文档，视为功能未完成。
