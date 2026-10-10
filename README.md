# Pixel

像素风生成创作桌面工作台。默认 Viewer 与 Timeline，统一12px字体和像素组件；时间轴左侧单击默认配置，已有片段保留原值，右键刷新才应用。Viewer 右键 → 项目管理器是唯一管理入口，独立非模态窗口保留素材分组及跨窗口关系；项目标题双击只进入详情。

Eleven v4 已通过官方 Dialogue SDK 接入相邻文本参考及时间戳裁尾，具体规则与基类补齐说明见[默认配置与语音连续性升级](docs/timeline-defaults-and-speech.zh-CN.md)。

Eleven v4 的默认配置详情现在直接显示声音选择、克隆音频文件选择、声纹名称和“克隆声纹”。默认声音、自己的克隆和手填声音 ID 共用一个 `voiceId` 字段；待验证或不可用项显示原因并禁用，已有 ID 保留。克隆接收单个不超过 25 MiB 的 MP3 / WAV，成功只创建账号声纹，选用后才修改默认配置，不自动改变已有片段。支持媒体参考的模型详情显示格式、数量限制和上传入口；Wan 首帧必须一张图，Grok 最多三张图，两者单图最多 25 MiB，其他模型按自己的能力提示。具体契约及设计评审见[声音、输入、分组与多轨预览](docs/voices-inputs-groups-and-composition.zh-CN.md)。

已增加纯文本、普通视频、音频和图片时间线，全部复用时间线基类。主时间线空白区、轨道名称、轨道时间位置和片段右键均可进入同一个“新建时间线 → 选择类型”，轨道占满窗口也能继续创建；文本轨空时间位置右键创建文本片段。媒体文件可直接拖入普通媒体轨，或时间线空白区域自动建对应轨并放置；普通视频、音频和图片轨的右键菜单也提供“上传并添加”，复用同一 `media.placeExternal` 和目标校验，这是用户明确要求的入口例外。外部文件与对象关系经过统一 `DragRegistry`，后台按真实字节和同类型目标校验。本地轨道不触发模型生成。契约、基类审查和原子放置规则见[本地时间线与扩展边界](docs/local-timelines-and-extension.zh-CN.md)。

生成视频片段详情直接提供“上传生成结果”：选择人工上传或外部网页生成来源，上传单个不超过 256 MiB 的 MP4 作为这个片段的输出，保留提示词、模型与时间位置。上传成功取消旧任务并阻止晚到结果覆盖；参数修改和默认配置刷新仍保留人工输出。它不上传模型参考，也不调用生成 API。源视频较短时缩短片段，较长时保留原编辑区间，可再拖动片段边缘使用更多内容。

生产项目及资源全部保存在应用 .env 配置的 Seafile：项目状态、历史、回执、outbox、生成任务和声纹操作记录共享持久化，媒体与索引独立，没有本地项目/资源回退。同项目只有一个编辑/生成宿主，多窗口同宿主并行，团队可编辑不同项目；不宣称实时多人合并。旧项目按源路径及项目/任务摘要只读迁移至新共享UUID、保留原件，旧未完成任务转 interrupted，不自动收费重放。见[共享项目、工程包与哈希恢复](docs/shared-project-manager-and-packages.zh-CN.md)。

项目管理器直接显示共享项目列表、新建/打开及 .pixel.zip 导入；当前项目可导出整项目或选中时间线的可编辑工程包。project/、media/ 与 SHA256 清单分开，单包最多256 MiB；整包保留编辑历史及历史媒体，单轨保留原时钟/参数/引用；导入形成新项目并清可执行记录。媒体移动时项目仍可打开，“扫描哈希恢复媒体”在同一库找回真实内容，保留 Asset ID及片段关系。分组、dnd-kit 排序及 Remotion 1280×720/60fps 叠加播放继续使用同一投影；未实现渲染成片，Viewer 单媒体原生拖出保持原入口。

外部 Agent 可读取导出的项目文档或旧项目文本参考：`npm run --silent timeline:text -- --project "C:\作品\项目" --format text`。改为 `--format json` 获取对象 ID、时间和版本；支持分页、时间及正文筛选，读取不加载模型凭证或修改项目。

```sh
npm install
npm run desktop
```

Windows 可执行文件通过 `npm run package:win` 构建，输出在 `release/`。桌面运行、存储位置、像素视觉及验证说明见 [本地桌面与像素界面](docs/desktop-ui.zh-CN.md)。浏览器开发使用 `npm run dev`。

当前锁定的 `remotion` / `@remotion/player` 4.0.534 使用 Remotion License。按依赖中的 `LICENSE.md`，个人、最多 3 名雇员的营利机构及非营利机构符合免费资格，可以制作商业视频和图像；不符合免费资格的机构需要 Company License。免费条款另禁止为销售、出租或再许可自己的 Remotion 衍生品而复制或修改其代码；这不是 MIT 许可。完整条件以[官方 LICENSE](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)和当前锁定依赖的许可文本为准，升级版本时重新核对对应条款。

Windows 源码版可双击[启动Pixel.cmd](启动Pixel.cmd)。在 Viewer 右键进入项目管理器创建/打开共享项目，或导入可编辑工程包；工程包拖入主窗口会导入并打开新共享项目。旧 project.json/目录只读迁移到 Seafile；空目录只供命名，不在原目录创建项目文件。普通媒体仍按固定目标导入/放置。见[项目输入与系统拖拽](docs/project-open-and-system-drag.zh-CN.md)。

先看 [设计哲学与架构约束](docs/design-philosophy.zh-CN.md)，理解产品基线；本轮理解与偏移修正见[哲学对齐记录](docs/philosophy-alignment.zh-CN.md)。再看 [核心架构设计](docs/core-architecture.zh-CN.md) 与代码。五个指定模型的配置、参数及执行边界见[模型接入文档](docs/model-integrations.zh-CN.md)。后续开发遵循 [仓库开发指引](AGENTS.md)，核心变更按设计哲学记录相关取舍。

| 文件 | 内容 |
| --- | --- |
| [src/contracts.ts](src/contracts.ts) | 项目、Timeline、Item、Asset、动作、任务的共享契约 |
| [src/backend.ts](src/backend.ts) | 动作处理器基类、注册表、统一执行器、内存事务示例 |
| [src/frontend.ts](src/frontend.ts) | 动作客户端、只读投影、详情导航、菜单与拖拽规则 |
| [src/plugins.ts](src/plugins.ts) | 时间线插件基类和视频语义示例 |
| [src/generation.ts](src/generation.ts) | 模型提供器基类、任务/产物接口、状态转换与旧结果检查 |
| [src/models.ts](src/models.ts) | 五模型语义目录、字段、schema、参数规范化和纯 Timeline 插件 |
| [src/providers/elevenlabs.ts](src/providers/elevenlabs.ts) / [openrouter.ts](src/providers/openrouter.ts) | 官方 SDK 适配器，音频、图像及异步视频生成 |
| [src/voice-contracts.ts](src/voice-contracts.ts) / [voices.ts](src/voices.ts) / [elevenlabs-voices.ts](src/providers/elevenlabs-voices.ts) | 浏览器可读声纹契约、共享查询与克隆服务、独立账号资源回执和官方 SDK 适配 |
| [src/reference-policy.ts](src/reference-policy.ts) | 模型引用的共同最小 / 最大数量规则 |
| [web/asset-groups.tsx](web/asset-groups.tsx) / [composition-preview.tsx](web/composition-preview.tsx) | 素材分组字段和 Remotion 多轨预览；项目编辑继续经宿主 Action |
| [src/runtime.ts](src/runtime.ts) / [storage.ts](src/storage.ts) | 任务执行/恢复、JobRepository执行/恢复与测试、旧项目只读迁移文件适配器 |
| [src/seafile-storage.ts](src/seafile-storage.ts) / [resource-migration.ts](src/resource-migration.ts) / [media-export.ts](src/media-export.ts) | 生产共享媒体与产物索引、保留句柄的旧资源迁移，以及会话临时导出副本 |
| [src/project-files.ts](src/project-files.ts) | 旧项目只读结构/模型/任务/资源校验；生产通过共享服务保存 |
| [examples/move-clip.ts](examples/move-clip.ts) | 三种入口共用协议、重复提交只执行一次的示例 |
| [examples/generate-media.ts](examples/generate-media.ts) | 模型查询与真实 SDK 的后端诊断 CLI |

目标架构如下；当前 GUI 已接入 Action System，只读文本 CLI 已实现，正式项目 CLI / Agent 编辑适配器仍待接线。

```text
GUI / CLI / Agent
       ↓ 同一个 ActionEnvelope
可信适配器 → ActionExecutor → ProjectRepository
       ↑                          ↓
前端交互控制器 ← 后端快照及变更通知
```

原则：领域数据用接口，行为扩展点用基类，React 视图用函数组件。后端是项目状态的权威来源；插件声明字段与语义，由宿主统一交互。新项目为空，主 Timeline 的同一个右键“新建时间线 → 选择类型”只创建空 Timeline，空白或已有对象均可进入。在已有生成 Timeline 的时间位置右键 → 新建生成草稿，再双击填写参数、右键生成；Asset → Timeline 时间位置则放置已有素材。1.3 的关系直接在真实窗口间建立：库 Asset → 主 Timeline 放置或 Item 引用区，主 Item → 库保存复用；跨窗口会话仍提交原 Action，不用库内镜像关系面替代。像素用于规范字体、栅格、状态和边界，空作品不预置示例画面、假波形或常驻教程。

安装与验证：

```sh
npm install
npm run typecheck
npm test
npm run example
```

`npm run models` 查询共享模型目录。后端从 `.env` 读取 `ELEVENLABS_API_KEY`、`OPENROUTER_API_KEY` 及 Seafile 配置；凭证不进入前端或项目。`npm run generate -- --model MODEL_ID --params-file params.json` 是后端诊断 CLI，会调用真实模型并将产物保存至 Seafile，可能产生费用；命令返回不透明媒体句柄，不返回本地媒体路径。它使用 `backend-example` 请求，直接调用生成执行内核，不是当前 GUI 项目的 Action 入口，也不将产物自动挂载到该项目。Eleven v4 参数必须提供可用 `voiceId`；Wan / Grok 的设置可用 `--settings-file settings.json` 传入。视频中断恢复使用 `npm run generate -- --resume JOB_ID`，详见模型接入文档。

当前具备共享项目事务、非模态项目管理器、五模型官方 SDK、普通媒体/文本轨、只读文本投影、声音及模型输入、分组/排序/叠加预览、人工视频输出、可编辑工程包和哈希恢复。生产不创建本地 project.json；本机只记最近共享 ID及有限处理/导出临时文件。真实 Seafile 与原生共享验证见[1.8记录](docs/shared-project-manager-and-packages.zh-CN.md)，旧轮数字仅历史证据。正式项目 CLI/Agent 编辑、共享 Action 能力查询、完整撤销重做、插件迁移/缺失插件占位、实时多人合并及离线成片合成仍待实现。本轮保持源码开发，未重新打包。

桌面宿主监听统一从 FIREWALL_OPEN_PORT_RANGE=12000-12100、PORT_RANGE_START=12000、PORT_RANGE_END=12100 分配，保持 loopback/Cookie 安全边界。没有新增 Pixel 网页部署服务，不修改出站 Seafile、OpenRouter 或 ElevenLabs 地址。SEAFILE_FILE_SERVER_URL 可把服务返回的旧内部文件 origin 显式映射到外部入口，来源受配置或 API 同 hostname 限制，凭证不发文件服务。
