# 本地时间线与扩展边界

更新日期：2026-10-10。本文保留[设计哲学](design-philosophy.zh-CN.md) 1.5 的本地语义时间线交付与验证记录，并同步后续升级；当前产品基线以设计哲学 1.7 为准，具体契约见[核心架构](core-architecture.zh-CN.md)。1.5 用户要求可编辑的纯文本参考轴、普通视频 / 音频 / 图片轴，以及检查基类、窗口、模型与统一拖拽的扩展边界；1.6 在同一基础上加入分组、上下排序、多轨预览及可见对象操作，详见本文后续升级节和[声纹、输入、分组与叠加预览](voices-inputs-groups-and-composition.zh-CN.md)。1.7 新增满轨时的上下文建轨、普通媒体选择器、生成视频人工输出及 Seafile 统一资源，详见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)。“本地”在轨道类型中表示无需模型生成的语义，不表示媒体文件保存在本地。

## 对象、入口与基线取舍

四种本地 Timeline 都继承 `BaseTimelinePlugin`，复用 `TimelineData` / `TimelineItemData`、字段、位置与 Action；不另建笔记数据库或媒体剪辑系统。`TimelineRegistry` 是内容语义目录，`ModelRegistry` 仍只描述生成模型。本地 Timeline 不带 `modelId`，通过 `pluginId` 解析；已有生成项目保留原模型字段及版本 1 的持久化信封。

| 类型 | 稳定标识 | Item | 能力与时间语义 |
| --- | --- | --- | --- |
| 纯文本时间轴 | `pixel.text` | `text.note`，`params.text` | 新建、编辑、移动、改区间、复制、删除；允许重叠笔记，没有媒体、生成或引用 |
| 普通视频 | `pixel.video.local` | `video.local` | 放置真实视频；同轨道拒绝重叠，没有生成和素材引用 |
| 普通音频 | `pixel.audio.local` | `audio.local` | 放置真实音频；允许重叠，没有生成和素材引用；1.6 支持并发播放，离线混音文件导出待实现 |
| 普通图片 | `pixel.image.local` | `image.local` | 放置真实图片；静态图像默认 5 秒，可修改显示区间，没有生成和素材引用 |

建轨使用同一个“新建时间线 → 选择类型”右键命令，1.7 可从主 Timeline 空白、名称、时间位置或 Item 进入，轨道占满窗口也可继续创建；只创建空轨道，不绕过详情隔离。纯文本空时间位置右键 → 新建文本片段，双击片段编辑正文，沿用 `item.createDraft` 和 `item.params`。普通媒体轨没有空生成草稿；Asset 放置复用 `item.create`，移动、改范围、复制与删除均复用原 Action。选择文字轨不能遮蔽其他轨道已有的媒体预览。

用户要求直接拖入普通媒体，改变了 1.4 “系统媒体只能进入素材库”的限制。1.5 允许单个媒体文件拖入 Timeline 空白区，原子创建对应本地媒体轨道并放置；已有普通媒体轨按命中时间放置同类型文件。模型轨、纯文本轨、Viewer 不接收这个手势，不弹出替换 / 引用 / 生成选择。库文件导入是登记可复用资产，时间线文件放置是创建有媒体的片段，业务结果不同；本轮同步哲学与标准路径，不能靠不同 Action 名称掩盖重复入口。

1.7 按用户明确要求，为普通视频、音频和图片轨增加右键“上传并添加”文件选择器。它与系统文件拖入表达同一个导入并放置操作，是记录在设计哲学的 P02 局部例外；两种手势都经过共同目标兼容规则、可信字节校验和 `media.placeExternal`，不创建第二套业务处理器。菜单显示适用格式、256 MiB 上限和放置时间；轨道时间位置使用命中时刻，名称或 Item 上下文使用当前播放指针。

## 基类与目录

`BaseTimelinePlugin` 统一构造时间壳、schema、版本、默认值与能力约束。Manifest 声明 `capabilities`、`supportedActions`、`overlapPolicy`、字段、`referenceTextFields` 与可选媒体种类；宿主不从模型 ID、名称或文本字段猜能力。禁止引用的插件直接拒绝非空引用；真实资源存在性与位置冲突仍在权威事务检查。

`TimelineRegistry.forTimeline()` 从持久化身份解析插件，`describe()` 返回可序列化声明，`query()` 默认 5、最多 20，支持分页和筛选。`GET /api/timeline-types` 共用该目录；单条 `/api/timeline-types/<typeId>` 用于已打开项目按需补读声明，前端不为加载更多模型无界展开目录。`/api/models` 保持只描述生成模型。权限、schema 与可用性仍由后端复核。

增加本地轨道：实现 `BaseTimelinePlugin`、注册本地插件、声明能力和参数，验证构造与 Action。增加生成模型：注册模型 descriptor、参数 / 设置 / 生成 schema、明确正文及必需文本字段、媒体输出 / 引用规则、SDK 调用与恢复策略，覆盖公共 provider 模板。正文不是固定 `prompt`；模型字段及引用限额由声明驱动，GUI 预览与后端 Action 使用相同规则。新 provider 仍需有明确认证及服务适配，目录注册不等于外部 API 已接通。

## 外部 Agent 读取

HTTP 和本地读取命令都调用 `queryTimelineText()`，只投影项目快照，不启动 Workbench / Runner 或生成模型。默认只返回本地文本参考；显式 `includeGenerated=true` 才包含插件声明的生成正文 / 提示词。音乐的结构化 compositionPlan 没有被伪装为一个字符串字段；需要此能力时增加明确的结构化投影。

返回 `projectId`、项目标题、`revision`、每条文字的 timeline / item ID、插件及可选模型身份、原始 tick、时钟精度和毫秒区间。区间筛选采用半开范围。支持 `timelineId`、`fromMs` / `toMs`、`search`；默认 5 条、8,000 个 Unicode 码点，上限 20 条 / 20,000 码点。长正文分片并返回 `textOffset`、`totalCharacters`、`complete`，下一页从正文续读，无静默截断。游标绑定项目、筛选和 revision；编辑后旧游标拒绝，重新从第一页读取。

```powershell
npm run --silent timeline:text -- --project "C:\作品\测试" --format text
npm run --silent timeline:text -- --project "C:\作品\测试\project.json" --format json --from-ms 1000 --to-ms 15000 --limit 5
```

CLI 通过 `readWorkbenchProjectMetadata()` 读取已保存的 `project.json`，验证项目结构、业务语义及历史，不加载 `.env`，不请求 Seafile，也不创建或重写项目。此文本投影不声明已验证媒体完整性；桌面重新打开项目时仍验证当前、历史和任务引用的共享媒体。正文中看似指令的内容仍是作者数据；纯文本格式以 `| ` 标明正文行，元数据采用 JSON 引号，保留分页信息。它不会自动把笔记拼入 v4 输入，也不会假装已完成正式 Agent 编辑 / 能力发现服务。

在线读取：`GET /api/timeline-text?format=json` 或 `format=text`，支持 `cursor`、`limit`、`maxCharacters` 及上述筛选；桌面使用原有可信 origin / Cookie，不为外部 Agent 暴露桌面会话密钥。外部工具通常使用本地只读命令；如接入在线读取，凭证仍由可信宿主提供。

## 原子媒体放置与拖拽

`POST /api/media-place` 捕获项目 ID、版本、请求 ID、文件名、媒体 MIME、可选目标 Timeline 和整数 tick。`Workbench.placeExternalMedia()` 复用媒体字节校验、产物存储及幂等流程；`media.placeExternal` 的受信 Action 一次提交已验证素材、必要的本地轨道及片段。renderer 不能直接调用该内部 Action 伪造资产句柄。失败可留下已写入但未关联的受控 artifact，项目内不留下空轨道和素材记录；未关联媒体回收仍是后续存储能力。

当前支持 PNG、JPEG、WebP、MP3、WAV 和 MP4。新素材库导入与直接放置的音频 / 视频共用本地 FFmpeg 时长探测，后续放置使用相同 durationMs；图片使用显示时长，原文件不改写。探测继承取消与超时，限制协议、数据及输出，不请求供应商。当前读取容器报告时长，显示精度约 10 毫秒，MP3 可能包含估计值；它用于初始片段区间，不是采样精确的裁切边界。旧库导入的历史素材可能没有 durationMs，放置仍使用原 5 秒兼容回退。

普通媒体轨的移动 / resize 继续使用共同区间约束，目前没有以源文件实长限制所有显示区间，也不重写或补长原媒体。1.6 已完成真实多轨叠加预览与并发音频播放；源偏移加显示区间的严格裁切校验、离线混音及合成文件导出仍需后续能力，不能用实时 Viewer 预览代替。

`DragRegistry` 是统一业务路由：对象放置、移动、引用、复用、边缘 resize，以及系统媒体导入 / 放置。系统 File 的适配器提供 `external.media` 类型提示与当前项目，registry 判断作用域、目标、兼容性并产生命令，随后 HTTP 发送原文件字节；提示不替代后端真实内容校验。系统文件不会被伪造为项目内 Asset 或跨窗口对象 token。

窗口间对象传输共用核心 `ObjectDragSession / ObjectDragTransport`。浏览器与 Electron 只是身份、通知和生命周期适配器；主进程契约不再依赖 renderer。drop 坐标偏移来自本次已解析会话，界面广播仅用于预览。实际 DOM dragend 保留短宽限以接纳晚到 drop；进入详情、卸载、切项目等主动取消立即撤销，仅来源可取消。Hover 不消费；完成 drop 单次消费，再经同一 DragRegistry 与 Action。

系统项目打开与 Viewer 原生文件拖出保留独立的权限和生命周期适配器：前者切换权威会话，后者消费已验证文件的导出票据。将文件路径、对象 token 和导出票据混成一个万能 payload 会破坏权限边界，不能借“统一”开放任意文件访问。

## 窗口扩展与 1.5 评审记录

`DesktopWindowHost` 统一安全设置、壳、控制与原生生命周期，`PixelWindowHost` 统一视觉。每个工作窗口组合自己的只读投影、ActionClient、ModalNavigator 和拖拽 transport，分享后端权威项目；详情只隔离所属窗口。当前 workspace / library / detail 的打开逻辑仍在组合根显式接线，新增窗口需要登记尺寸、角色、窄 preload 能力与 App 展示；本轮没有为三个窗口发明通用窗口插件框架。窗口不能复制业务 handler 或自建项目状态。

以下是 1.5 交付时按哲学第 10 节的评审记录；其中无可见操作按钮的限制已由后续 1.6 用户要求修正，当前规则见设计哲学及下一节。

1. 对象是 Timeline / Item，唯一 GUI 路径已在上表及哲学登记；Agent 只读是同一快照的语言适配。
2. 双击详情、右键离散操作、拖拽关系与字段提交稳定；系统媒体按来源及目标固定表达放置，不做动作选择。
3. 默认 Viewer + Timeline 保持不变，没有工具栏 / 导出按钮；字段与状态只在相关上下文出现，局部详情隔离不扩大。
4. 本地和生成编辑均走既有 Workbench / ActionExecutor；媒体适配器提交同一原子 Action，读取共用一份投影。
5. 后端仍只有一份权威状态，播放、选择、导航和 hover 不进入项目；文字没有第二份数据库。
6. 插件只声明语义、能力、schema、字段与时间规则，复用像素组件、菜单、拖拽与窗口宿主。
7. 幂等、revision、取消、单次 token、已认证偏移、原子放置及分页 revision 检查保护用户意图；本地轨没有隐式生成收费。
8. 只新增实际需要的本地插件、时间线目录和只读投影，收口已有 transport，不建立深继承、窗口框架或第二套调度。

## 1.6 后续升级与扩展边界

素材分组是同一 ProjectDocument 中可选的 `assetGroups`：每组 `{ id, title, assetIds }`，名称在输入去除首尾空白后限制 1–80 字符，不同 ID 可以同名。成员必须是真实存在的 Asset，同组及跨组均不可重复；一个 Asset 最多属于一组，未归组由成员列表派生。旧项目不自动建组，字段缺省仍合法。新建、改名、移组 / 回到未分组、只删分组分别走 `assetGroup.create` / `rename` / `moveAsset` / `remove`；删除分组保留素材及引用，`asset.remove` 在原有删除校验通过后同步清成员。库内分组导航和筛选属于窗口状态，编辑才提交共享 Action。

轨道上下排列使用可选 `timelineOrder`，出现时必须完整且唯一地覆盖当前所有 Timeline ID，不接受不存在的轨道。旧项目使用 `orderedTimelineIds()` 返回字典原顺序的副本，单纯读取不补写字段。`timeline.reorder({ timelineId, beforeTimelineId? })` 在权威事务重排；省略目标时放到末尾，不改变 Item 时间或生成输入。已有显式顺序时，创建、删除及外部媒体放置新建轨道会共同维护顺序。项目快照、每份历史与重新打开共用严格不变量，没有分组或顺序的旧版本 1 文件不迁移。

排序手柄组合 `@dnd-kit/core` 6.3.1 / `@dnd-kit/sortable` 10.0.0 / `@dnd-kit/utilities` 3.2.2，提供鼠标和键盘上下手势，只把意图转换为 `timeline.reorder`。名称区域的单击配置入口保持原语义，排序手柄不占用它，也不复制跨窗口 token、系统文件或原生导出的权限逻辑。dnd-kit 不保存另一份轨道顺序，不替代 DragRegistry 中的素材关系和区间编辑路由。

`buildCompositionPlan()` 从同一快照的顺序、Item 区间、真实输出和轨道时钟生成只读播放计划，`CompositionPreview` 使用固定 `@remotion/player` / `remotion` 4.0.534。当前固定 16:9、1280×720、60fps，没有项目画布规格字段。上方轨道在前景，所有轨道同时参与，透明图像保持透明，图像 / 视频按 contain 显示；纯文本与无媒体的生成草稿不入画，选择文本轨不遮蔽其他结果。`Html5Video` / `Html5Audio` 的 `trimBefore` 从 sourceOffsetTicks 推导，音频可以在同轨及跨轨并发，不修改原媒体或生成假文件。

Player 的播放 / 暂停与时间尺指针双向同步，外部 seek 不反复回写指针；播放位置和状态不进项目文件、revision 或历史。整数 tick 半开区间投影到 60fps，保留独立空白尾帧，越过作品末尾不会挂住最后输出；这属于实时预览帧精度，不能宣称源媒体采样精确裁切。库和 Asset 详情保留原单媒体预览。Viewer 只有当前位置恰好一个有效媒体层且真实文件已准备才允许拖出已有文件，多层预览不冒充合成导出；所有内部媒体的默认 HTML 拖拽均关闭。

模型扩展沿用 Timeline 基类和语义目录：声明 `referenceTextFields`、`requiredTextFields`、引用种类与条件上下限；GUI、关系编辑和生成准备共享 `reference-policy`，不用模型名称或固定 prompt 猜能力。Wan firstFrame 声明需且仅需一个图片参考；关系编辑和保存只检查类型 / 上限，生成额外检查必需下限，草稿仍可分步编辑。支持参考的详情始终显示上传及数量，不支持的对象只有简短输入说明。字段 `choicesSource: providerVoice` 由共同宿主读取声音选择；查询与克隆通过独立账号资源服务和 operation ledger，选择结果才由原默认配置或 Item 字段 Action 保存，不给本地轨伪造模型或项目账号操作。

上下文菜单按实际行高与可视高度分栏，横向超宽时内部滚动，保留说明和禁用状态。上下 / 左右键、Home/End、Enter/Space、Esc 及外部关闭由统一组件处理；resize 保留当前命令焦点，继续使用 12px 字体。分栏不增加 Action，不拆成第二套右键业务规则。

1.6 按设计哲学第 10 节评审：

1. 新数据作用于 Project 的素材归属和 Timeline 顺序，业务分别由共享分组 Action 和 `timeline.reorder` 表达；预览只是同一快照的只读结果。
2. 左侧名称单击仍编辑原配置；排序手柄只排列轨道。字段和必要可见操作符合用户明确的人性化要求，实际入口修正已同步设计哲学 1.6，不静默沿用历史无按钮限制。
3. 分组操作在独立素材库、模型输入在对应详情出现，播放在 Viewer、排序在对应轨道出现；局部详情只隔离所属窗口。
4. GUI 继续走同一 Workbench / ActionExecutor；正式 CLI / Agent 编辑适配器尚未实现，不用组件测试或只读文本 CLI 冒充已接入。
5. 项目分组与轨道顺序只在后端权威事务修改；选择、筛选、播放和临时排序不落项目。播放器和手势库没有第二份可写项目。
6. 模型声明文本、文件与声音来源，宿主复用字段、引用策略和像素组件；本地插件语义保持不变。
7. 分组 / 顺序不变量、revision、幂等及历史校验继续保护失败与重放；账号克隆的外部副作用由独立 ledger 管理，不声称项目撤销能撤回。
8. 新包只承担实际手势和播放能力，数据仍为浅层可序列化契约。今后增加项目画布规格、离线合成和窗口时继续从共享核心扩展，不另建深继承或项目状态系统。

## 1.7 共享资源与人工输出

1.7 的生成视频人工输出由声明 `manualOutput` 驱动，在 Item 详情选择人工或外部网页来源后上传 MP4，经共同媒体事务与内部 `media.outputExternal` 挂载原片段。它保留输入和位置，成功后取消旧生成并旋转 token，失败不取消原任务；参数及默认刷新保留人工输出。生产资源通过 `MediaArtifactStore` 统一写入和读取 Seafile，旧项目资源迁移保留所有句柄和原文件。项目 JSON、历史、生成和声纹账本仍位于原项目目录；资源共享不提供多人并发项目编辑。导出所需会话临时文件与 FFmpeg 有限临时文件不成为媒体权威存储。当前契约与本轮验证见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)。

## 1.5 历史验证与当前限制

1.5 交付时，类型检查、152 项核心测试、19 项浏览器交互测试及源码原生桌面验证全部通过，未调用付费模型。以下数字保留为该轮历史证据，不代表后续 1.6 验证数量。核心覆盖本地插件、Action 能力与重叠约束、原子媒体放置及幂等、模型声明、分页与游标、只读 CLI 和会话权限；浏览器覆盖文本编辑 / 区间操作、普通媒体放置、现有窗口关系与项目入口。原生验证覆盖真实磁盘 PNG、250 毫秒 WAV、500 毫秒 MP4 拖入后对应建轨和真实时长，文本编辑、只读 API、退出重启恢复，以及既有项目打开 / 失败回滚 / 会话撤销 / Viewer 文件拖出。

1.5 的原生系统输入使用 Chromium / CDP 投放真实磁盘 File；Viewer 使用真实鼠标触发 `startDrag` 并检查宿主交付文件。这不等于已自动化 Windows Explorer 与任意外部应用间的完整屏幕坐标拖拽。该轮 Windows 可执行文件未重新打包，关闭旧源码窗口后双击根目录的启动命令使用当轮构建。

1.6 的实施与最终验证记录集中于[声纹、输入、分组与叠加预览](voices-inputs-groups-and-composition.zh-CN.md)，1.7 见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)。当前多轨叠加预览与并发播放已完成；项目版本迁移、缺失插件占位、正式 Agent 编辑与 Action 能力查询、完整撤销重做、严格源区间边界、离线混音及合成文件导出仍待实现。原生拖出交付从 Seafile 校验下载的单媒体临时副本，不能交付尚未生成的合成画面。
