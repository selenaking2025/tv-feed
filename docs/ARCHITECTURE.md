# TV Feed 架构优化方案与现行架构

<!-- architecture-record:v1 -->

- 状态：已接受并完成阶段一至阶段五
- 生效日期：2026-08-11
- 适用范围：Electron 主进程、preload、渲染进程、目录同步、家庭安全、远程资源代理、本机缓存与工程门禁
- 决策责任人：仓库维护者
- 事实来源：仓库中的类型契约、自动化测试和构建结果；本文不替代第三方内容或权利核验

## 目标与完成标准

本次优化不改变 TV Feed 的产品定位：它仍是本地运行的 IPTV 阅读和播放工具，不托管或转发节目内容。优化目标是让高风险状态只有一个权威写入者，让并发、迁移和崩溃恢复成为可测试的明确行为，并把过大的入口文件拆成职责单一的模块。

完成标准如下：

1. 启动加载、显式刷新和缓存清除不再由一个无语义的全局 Promise 协调；较早操作的晚到结果不能覆盖较新结果。
2. 家庭安全和远程台标授权以主进程持久化状态为准，渲染端不能通过直接 IPC 绕过。
3. 缓存带有结构版本、过滤策略版本和安全范围；旧缓存只走明确的兼容降级路径。
4. 主入口只负责组装和生命周期；IPC、应用协议、远程资源代理、运行配置和冒烟驱动彼此隔离。
5. 架构边界、负向路径和策略复核日期都由自动化检查覆盖。

## 权威与投影

| 信息或动作 | 唯一权威 | 允许写入者 | 投影或消费者 |
| --- | --- | --- | --- |
| 家庭安全、远程台标授权 | `safety-state-v1.json` | `SafetyCoordinator` | preload、渲染设置界面、`RemoteResourceBroker` |
| 目录加载操作与并发顺序 | `CatalogCoordinator` 的操作序列和缓存纪元 | `CatalogCoordinator` | IPC 进度、目录界面 |
| 持久化目录 | `catalog-v2.json` | `CatalogCacheRepository` | `CatalogCoordinator` |
| IPC 名称与桥接形状 | `src/shared/ipc-contract.ts` | 共享契约模块 | main、preload、renderer |
| 远程请求和媒体流票据 | `RemoteResourceBroker` | 主进程 | HLS 加载器、远程台标控制器 |
| 当前本机网络可用性快照 | Electron 主进程的 `net.isOnline()` | 主进程 | `RemoteResourceBroker`、网络状态 IPC、播放恢复门禁 |
| 收藏、最近观看、线路健康 | 浏览器本地存储 | 渲染端本地状态模块 | 界面与播放器 |
| 家庭/官方/denylist 政策 | `src/shared` 下的政策表 | 仓库维护者 | 目录过滤、徽标、策略版本和 CI |

渲染端的两个旧安全偏好键只是回退兼容投影，不再是权威。主进程在首次迁移时读取一次旧值，此后总是返回并覆盖这两个投影。

## 运行主干

```text
Renderer UI
  -> typed preload bridge
    -> centralized IPC handlers
      -> SafetyCoordinator (scope and resource admission)
      -> CatalogCoordinator (operation ordering)
        -> secure upstream fetch
        -> catalog filtering/projection
        -> CatalogCacheRepository (single persistent writer)
      -> RemoteResourceBroker
        -> secure network / one-time stream tickets
```

`src/main/index.ts` 只读取一次运行配置并组装这些组件。它不声明 IPC 字符串、不处理目录业务、不持有远程请求表，也不包含冒烟检查实现。

## 阶段一：目录协调器

### 决策

- 每次目录工作都有 `operationId`、范围 `standard | family` 和意图 `startup | refresh`。
- 同范围、同语义的请求可以合并；启动请求可以加入已经进行的刷新，因为刷新提供更强的新鲜度保证。
- 显式刷新绝不加入启动加载，避免用户动作被较弱的启动请求吞掉。
- 每个合并调用者都会收到当前和后续进度；进度监听器异常不会改变目录操作结果。
- 缓存写入和清除共用一个串行队列。缓存失效会先同步提升 `cacheEpoch`，使已经在途的旧操作立即失去写入权威。
- 同一纪元内用单调操作序列阻止较早操作晚到后覆盖较新缓存。

### 失败与恢复

| 场景 | 行为 | 可验证结果 |
| --- | --- | --- |
| 两个启动加载并发 | 合并为一个操作 | 同一 Promise、同一 `operationId`、一次上游获取 |
| 启动后用户刷新 | 各自执行 | 两个不同 `operationId` |
| 新刷新先完成、旧启动后完成 | 旧启动可返回内存结果但不得写缓存 | 缓存保留新刷新，旧结果带“未覆盖”提示 |
| 写缓存时用户清除缓存 | 清除排在写入后，且写入结果失去权威 | 最终缓存为空 |
| 进度观察者抛错 | 忽略观察者错误 | 目录操作继续完成 |

## 阶段二：主进程家庭安全权威

### 状态模型

`safety-state-v1.json` 包含：

- `revision`：每次持久化变更递增；
- `familySafety` 与 `remoteLogos`：互斥约束由主进程校验；
- `transitionId`：关联一次安全切换和渲染端清理确认；
- `pendingCatalogInvalidation`：缓存清理未完成时保留；
- `pendingViewingDataClear`：最近观看、上次频道和线路健康尚未由渲染端确认清理时保留。

### 安全切换顺序

启用家庭安全时，顺序固定为：

1. 原子写入 `familySafety=true`、`remoteLogos=false` 和两个待处理标记；
2. 立即取消所有在途 Logo 请求；
3. 清除目录缓存并清掉对应待处理标记；
4. 渲染端清除观看数据，以相同 `transitionId` 确认；
5. 主进程按 `family` 范围加载并持久化目录。

第一步完成后，即使应用崩溃、磁盘清理失败或渲染端失联，Logo 准入仍保持关闭。下一次初始化会重试未完成的目录清理；渲染端会根据待处理标记再次执行幂等的观看数据清理。关闭家庭安全前必须先完成旧清理确认。

所有目录和远程资源调用都要求安全状态已经初始化。Logo 请求还必须同时满足 `remoteLogos=true` 和 `familySafety=false`；这项检查发生在主进程，而不是只依赖界面开关。

## 阶段三：目录缓存 V2

### 信封

`catalog-v2.json` 在目录数据外增加：

- `schemaVersion: 2`；
- `scope: standard | family`；
- `filterPolicyRevision`；
- `generatedByAppVersion`；
- `writtenAt`；
- 经既有大小和结构边界校验的 `catalog`。

`filterPolicyRevision` 由过滤算法手动版本、项目 denylist 和家庭允许列表记录共同生成。只修改政策数据也会改变版本；只修改算法时必须提升 `CATALOG_FILTER_RULESET_VERSION`。

### 兼容与回退

- V2 只有在结构、范围和过滤策略版本都匹配时才具备当前读取权威。
- `catalog-v1.json` 没有范围和策略来源，因此不能作为新鲜缓存，也不能在家庭范围读取。
- 标准模式联网失败时可以把有效 V1 作为带明显状态的 `legacy-cache` 临时降级结果。
- V2 完成原子写入和正式路径复读后才删除 V1；写入失败时 V1 保留，便于恢复。
- 旧版本回退时可能看不到 V2，但可以重新联网；旧的渲染端安全偏好投影仍会保留用户选择。

旧缓存读取与安全偏好投影的移除不是本次阶段的一部分。移除条件是：最低支持版本明确高于本次变更、发布说明已经结束回退窗口，并新增一次迁移移除测试。未满足三个条件前不得只为“清理代码”删除兼容路径。

## 阶段四：入口与边界拆分

主进程模块职责如下：

- `runtime-config.ts`：唯一读取 `TVFEED_SMOKE_*` 的生产源码；
- `app-protocol.ts`：应用协议、静态资源、CSP、导航与会话边界；
- `register-ipc.ts`：验证发送者、解析命令并把请求路由给权威组件；
- `remote-resource-broker.ts`：并发额度、取消、Logo 类别撤权、一次性流票据和流生命周期；
- `catalog-coordinator.ts`：目录操作和缓存次序；
- `safety-coordinator.ts`：安全状态机和恢复；
- `index.ts`：组件组装、窗口与应用生命周期。

preload 只公开 `TvFeedBridge`，所有通道名来自共享常量，并对主进程推送的进度载荷做运行时检查。远程资源失败通过固定、无 URL 的结果信封跨进程传递，不依赖异常文字作为接口。渲染端把安全迁移和兼容投影放在 `SafetyClient`，把远程台标队列、取消和对象 URL 生命周期放在 `RemoteLogoController`，把通用本地存储放在 `local-state.ts`。

### 播放网络中断与恢复

- `RemoteResourceBroker` 结合安全网络失败类别和主进程网络快照，把本机断网、临时 DNS 服务中断或代理连接问题归为 `network-unavailable`；单个源站的确定性 DNS 失败仍归为 `dns-failure`。
- 渲染端的 `online` 事件只用于触发检查，不能作为网络事实。自动恢复前必须通过类型化 IPC 重新读取主进程快照；对流传输中途才暴露的普通离线、超时或 DNS 失败，在写入线路健康前也会做同样确认。
- `network-unavailable` 不写入线路健康失败记录，也不把当前线路加入失败集合，更不会连续切换其他线路；内存门禁只保留当前频道、线路和代次。
- 首次中断可进行一次延迟检查；在线事件和用户点击播放也可触发检查。每次恢复必须匹配仍然选中的频道和线路；一次确认只能认领一次代次，失败后的 30 秒内不再自动安排新的延迟检查，防止失败循环。
- 切换频道、手动选择线路、停止播放或成功开始播放都会使旧代次终止。没有持久化恢复标记，也没有第二套网络权威，因此重启后不存在待回放动作。

完整冒烟实现位于 `scripts/smoke-driver.mjs`，不进入 `src`，也不在打包文件列表中。测试启动器只在显式冒烟环境下传入驱动绝对路径；正常应用只保留一个惰性加载接口，没有 DOM 验收脚本和测试源逻辑。

## 阶段五：架构守卫与政策生命周期

仓库边界检查必须拒绝：

- 渲染进程直接使用外部网络、Node、Electron 或主进程模块；
- 在共享契约之外声明 IPC 通道字面量；
- 在 `runtime-config.ts` 之外读取 `TVFEED_SMOKE_*`；
- 在渲染入口重新读取家庭安全或远程台标旧键作为权威；
- 在渲染端读取 `navigator.onLine` 作为网络权威，或收到 `online` 事件后未经主进程确认就恢复播放；
- 重新创建单体 `shared/contracts.ts`；
- 把冒烟驱动放回生产源码或让主入口重新承担 IPC、协议、资源代理职责；
- 缺少本架构记录或关键权威/迁移/恢复章节。

家庭允许列表、官方来源表和项目 denylist 的每条记录必须有证据引用、上次核对日期和下次复核日期。复核周期不得超过 366 天，CI 在到期后失败。到期不代表内容自动安全或不安全，只表示维护者必须重新核对并形成新决策。

## 变更规则

新增架构概念必须同时回答：

1. 它替代了哪个旧权威或消除了哪项歧义；
2. 谁是唯一写入者；
3. 失败后从哪个持久化标记或幂等动作恢复；
4. 哪个负向测试能证明边界不能被绕过；
5. 是否需要兼容读取、双写或明确的旧版本回退窗口。

如果答案只是增加第二套状态、第二条写路径或没有退出条件的兼容层，则不应合入。

## 验证契约

阶段一至阶段五的交付必须至少通过：

```bash
npm run verify:repository
npm run verify:public-release:static
npm run typecheck
npm test
npm run build
npm run smoke
```

目录并发、安全恢复、缓存迁移和边界违规必须包含负向测试。构建成功只证明可编译；Electron 冒烟成功才证明 preload、IPC、协议、渲染初始化与核心界面在真实进程边界中仍能工作。
