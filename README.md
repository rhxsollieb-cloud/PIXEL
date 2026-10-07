# Pixel 核心设计骨架

从《生成视频软件理解》的产品约束出发，设计前后端共用的动作协议、插件语义和生成任务边界。

先看 [设计哲学与架构约束](docs/design-philosophy.zh-CN.md)，理解产品基线；再看 [核心架构设计](docs/core-architecture.zh-CN.md) 与代码。五个指定模型的配置、参数及执行边界见[模型接入文档](docs/model-integrations.zh-CN.md)。后续开发遵循 [仓库开发指引](AGENTS.md)，核心变更按设计哲学记录相关取舍。

| 文件 | 内容 |
| --- | --- |
| [src/contracts.ts](src/contracts.ts) | 项目、Timeline、Item、Asset、动作、任务的共享契约 |
| [src/backend.ts](src/backend.ts) | 动作处理器基类、注册表、统一执行器、内存事务示例 |
| [src/frontend.ts](src/frontend.ts) | 动作客户端、只读投影、详情导航、菜单与拖拽规则 |
| [src/plugins.ts](src/plugins.ts) | 时间线插件基类和视频语义示例 |
| [src/generation.ts](src/generation.ts) | 模型提供器基类、任务/产物接口、状态转换与旧结果检查 |
| [src/models.ts](src/models.ts) | 五模型语义目录、字段、schema、参数规范化和纯 Timeline 插件 |
| [src/providers/elevenlabs.ts](src/providers/elevenlabs.ts) / [openrouter.ts](src/providers/openrouter.ts) | 官方 SDK 适配器，音频、图像及异步视频生成 |
| [src/runtime.ts](src/runtime.ts) / [storage.ts](src/storage.ts) | 后端配置、任务执行/恢复、文件 ledger 和媒体存储 |
| [examples/move-clip.ts](examples/move-clip.ts) | 三种入口共用协议、重复提交只执行一次的示例 |
| [examples/generate-media.ts](examples/generate-media.ts) | 模型查询与真实 SDK 的后端诊断 CLI |

```text
GUI / CLI / Agent
       ↓ 同一个 ActionEnvelope
可信适配器 → ActionExecutor → ProjectRepository
       ↑                          ↓
前端交互控制器 ← 后端快照及变更通知
```

原则：领域数据用接口，行为扩展点用基类，React 视图用函数组件。后端是项目状态的权威来源；插件声明字段与语义，由宿主统一交互。右键创建模型时间线，双击进入详情，拖拽的每条对象关系只有一个明确动作。

安装与验证：

```sh
npm install
npm run typecheck
npm test
npm run example
```

`npm run models` 查询共享模型目录。后端从 `.env` 读取 `ELEVENLABS_API_KEY` 与 `OPENROUTER_API_KEY`；密钥不进入前端或项目。`npm run generate -- --model MODEL_ID --params-file params.json` 会调用真实模型并保存产物，可能产生费用。Eleven v4 参数必须提供可用 `voiceId`；Wan / Grok 的设置可用 `--settings-file settings.json` 传入。视频中断恢复使用 `npm run generate -- --resume JOB_ID`，详见模型接入文档。

当前已有内存动作闭环、官方 SDK 模型适配器、后端生成诊断及单进程文件任务/产物存储；SDK 验证使用模拟 HTTP，尚未做付费生成测试。Electron / React 页面、项目持久化、完整撤销重做、`generation.submit` / outbox / `generation.applyResult`、自动调度和原生文件导出仍按架构文档继续实现。
