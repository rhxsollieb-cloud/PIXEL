# Pixel

本地运行的像素风生成创作工作台。默认界面只有 Viewer 与 Timeline；双击进入对象、右键执行命令、拖拽建立关系。时间轴左侧单击进入默认配置，修改保留已有片段，右键“刷新时间轴默认配置”才应用到已有片段。素材库的唯一入口是主 Viewer 右键 → 素材库，空预览或已有输出均可进入。主工作区与素材库使用共同窗口宿主，非模态并行；对象详情只隔离所属窗口。打开素材库仅改变窗口导航，不提交业务 Action。

Eleven v4 已通过官方 Dialogue SDK 接入相邻文本参考及时间戳裁尾，具体规则与基类补齐说明见[默认配置与语音连续性升级](docs/timeline-defaults-and-speech.zh-CN.md)。

Eleven v4 的默认配置详情现在直接显示声音选择、克隆音频文件选择、声纹名称和“克隆声纹”。默认声音、自己的克隆和手填声音 ID 共用一个 `voiceId` 字段；待验证或不可用项显示原因并禁用，已有 ID 保留。克隆接收单个不超过 25 MiB 的 MP3 / WAV，成功只创建账号声纹，选用后才修改默认配置，不自动改变已有片段。支持媒体参考的模型详情显示格式、数量限制和上传入口；Wan 首帧必须一张图，Grok 最多三张图，两者单图最多 25 MiB，其他模型按自己的能力提示。具体契约及设计评审见[声音、输入、分组与多轨预览](docs/voices-inputs-groups-and-composition.zh-CN.md)。

已增加纯文本、普通视频、音频和图片时间线，全部复用时间线基类。主时间线空白区、轨道名称、轨道时间位置和片段右键均可进入同一个“新建时间线 → 选择类型”，轨道占满窗口也能继续创建；文本轨空时间位置右键创建文本片段。媒体文件可直接拖入普通媒体轨，或时间线空白区域自动建对应轨并放置；普通视频、音频和图片轨的右键菜单也提供“上传并添加”，复用同一 `media.placeExternal` 和目标校验，这是用户明确要求的入口例外。外部文件与对象关系经过统一 `DragRegistry`，后台按真实字节和同类型目标校验。本地轨道不触发模型生成。契约、基类审查和原子放置规则见[本地时间线与扩展边界](docs/local-timelines-and-extension.zh-CN.md)。

生成视频片段详情直接提供“上传生成结果”：选择人工上传或外部网页生成来源，上传单个不超过 256 MiB 的 MP4 作为这个片段的输出，保留提示词、模型与时间位置。上传成功取消旧任务并阻止晚到结果覆盖；参数修改和默认配置刷新仍保留人工输出。它不上传模型参考，也不调用生成 API。源视频较短时缩短片段，较长时保留原编辑区间，可再拖动片段边缘使用更多内容。

生产资源统一保存至 `.env` 配置的 Seafile 资料库：媒体和产物索引共享，后端代理预览与受控读取，没有本地媒体存储回退。旧项目资源迁入 Seafile 时保留原句柄和原文件；项目 JSON、编辑历史、生成与声纹账本仍位于项目目录，资源共享不等于多人同时编辑项目。原生文件拖出只使用会话临时副本，退出后清理。1.7 的契约、配置与验证见[共享资源与人工输出](docs/shared-resources-and-manual-output.zh-CN.md)。

素材库可新建、改名和删除分组，每个素材通过分组字段归入一个组，并支持“全部素材”和“未分组”筛选；删除组保留素材及原始文件。时间线左侧的 ↕ 把手使用 dnd-kit 排序并保存顺序，上层轨道作为前景。Viewer 使用 Remotion Player 在 1280×720、16:9、60 fps 画布上预览同一时刻的多轨图像、视频及并发音频，与时间指针共用播放位置；纯文本参考和未生成草稿不进入画面。Viewer 原生拖出仍导出当前单个 output 文件，多轨合成文件导出尚未实现。

外部 Agent 可读取文本参考：`npm run --silent timeline:text -- --project "C:\作品\项目" --format text`。改为 `--format json` 获取对象 ID、时间和版本；支持分页、时间及正文筛选，读取不加载模型凭证或修改项目。

```sh
npm install
npm run desktop
```

Windows 可执行文件通过 `npm run package:win` 构建，输出在 `release/`。桌面运行、存储位置、像素视觉及验证说明见 [本地桌面与像素界面](docs/desktop-ui.zh-CN.md)。浏览器开发使用 `npm run dev`。

当前锁定的 `remotion` / `@remotion/player` 4.0.534 使用 Remotion License。按依赖中的 `LICENSE.md`，个人、最多 3 名雇员的营利机构及非营利机构符合免费资格，可以制作商业视频和图像；不符合免费资格的机构需要 Company License。免费条款另禁止为销售、出租或再许可自己的 Remotion 衍生品而复制或修改其代码；这不是 MIT 许可。完整条件以[官方 LICENSE](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)和当前锁定依赖的许可文本为准，升级版本时重新核对对应条款。

Windows 源码版可双击[启动Pixel.cmd](启动Pixel.cmd)。启动后将空文件夹拖入主窗口，即在该目录创建并打开空作品；已有 Pixel 项目目录或 `project.json` 同样拖入，在原位置继续编辑。媒体文件拖入素材库，Viewer 当前输出可原生拖出。规则及系统边界见[项目打开与系统拖拽](docs/project-open-and-system-drag.zh-CN.md)。

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
| [src/runtime.ts](src/runtime.ts) / [storage.ts](src/storage.ts) | 任务执行/恢复、项目本地任务 ledger，以及测试和旧资源迁移使用的文件适配器 |
| [src/seafile-storage.ts](src/seafile-storage.ts) / [resource-migration.ts](src/resource-migration.ts) / [media-export.ts](src/media-export.ts) | 生产共享媒体与产物索引、保留句柄的旧资源迁移，以及会话临时导出副本 |
| [src/project-files.ts](src/project-files.ts) | 原位置项目校验、空目录初始化与模型、任务、素材完整性检查 |
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

当前已具备 Electron 桌面宿主、React 工作台、文件项目持久化、五模型字段、四种本地轨道、只读文本投影、生成提交 / outbox / 受控结果挂载、声纹查询与克隆命令、素材分组、时间线排序、多轨实时预览、生成视频人工输出及 Seafile 共享资源，以及 Viewer 当前媒体的原生文件拖出。项目文件 / 目录打开与空目录初始化已接入，动态项目身份及独立 origin 保护会话切换。模型生成及声纹 SDK 验证使用模拟 HTTP，未调用真实计费服务，也不能据此证明账号权限或生成质量；克隆回执绑定完整输入和 API key 的凭证作用域哈希，改换密钥不能复用旧回执，超时或结果未知时不盲目重提。共同窗口宿主、非模态素材库与真实跨窗口对象 broker 已实现；浏览器开发版使用同源独立 popup（`?window=library`），复用同一 App / `PixelWindowHost`。1.6 历史记录见[声音、输入、分组与多轨预览](docs/voices-inputs-groups-and-composition.zh-CN.md)，1.7 当前记录见[共享资源与人工输出](docs/shared-resources-and-manual-output.zh-CN.md)。正式项目 CLI / Agent 编辑适配器、共享 Action 能力查询、完整撤销重做、项目版本迁移与缺失插件占位、多人项目协作、多轨合成文件导出仍按架构文档继续实现。继续源码开发模式，本轮未重新打包。
