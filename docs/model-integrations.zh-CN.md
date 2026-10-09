# Pixel 模型接入与执行边界

更新日期：2026-10-10，当前基线 1.7。产品与交互规则沿用[设计哲学](design-philosophy.zh-CN.md)；项目、Action 与任务的完整边界见[核心架构](core-architecture.zh-CN.md)。

当前已实现后端的官方模型 SDK 适配器、共享模型语义目录、项目本地任务 ledger、Seafile 媒体与产物索引和诊断 CLI；Electron / React 工作台及 `generation.submit` 的项目事务/outbox、内部 `generation.apply` 的受控挂载也已由 `src/workbench.ts` 组合完成。声纹目录与克隆经共享 `VoiceService` 执行，使用独立账号资源 ledger。模型验证使用真实 SDK 配合模拟 HTTP 响应，未发起真实克隆或计费生成请求。1.6 的可见输入控件、引用政策、分组及预览边界见[声音、输入、分组与多轨预览](voices-inputs-groups-and-composition.zh-CN.md)；1.7 的人工视频输出和统一资源边界见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)。正式项目 CLI / Agent 和共享 Action 能力查询仍待接线；诊断 CLI 生成文件成功不代表 GUI 项目已关联输出。

## 1. 模型、标识与输出

| 用户指定模型 | 持久化及 API 的 canonical modelId | SDK / 接口 | outputKind / Item 语义 |
| --- | --- | --- | --- |
| `eleven_v4` | `eleven_v4` | `@elevenlabs/elevenlabs-js`，`textToDialogue.convertWithTimestamps`；关闭裁尾时 `convert` | `audio` / `audio.speech` |
| `eleven_text_sound_v2` | `eleven_text_to_sound_v2` | 同上，`textToSoundEffects.convert` | `audio` / `audio.soundEffect` |
| `music_v2_5` | `music_v2_5` | 同上，`music.compose` | `audio` / `audio.music` |
| Alibaba: Wan 3.0 | `alibaba/wan-3.0` | `@openrouter/sdk`，`videoGeneration.generate` / `getGeneration` / `getVideoContent` | `video` / `video.generated` |
| Grok Imagine Image 2.0 | `x-ai/grok-imagine-image-2.0` | 同上，`images.generate`，`/api/v1/images` | `image` / `image.generated` |

Eleven v4 的官方模型标识为 `eleven_v4`；音效端点的官方标识含 `to`，因此将用户给出的 `eleven_text_sound_v2` 登记为同一模型的输入别名，规范化后才保存请求。[ElevenLabs 模型目录](https://elevenlabs.io/docs/overview/models)、[音效 API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)。音乐明确传递 `music_v2_5`，不依赖 API 的默认模型。[音乐 API](https://elevenlabs.io/docs/api-reference/music/compose)。

Wan 与 Grok 使用用户指定的版本，不在失败时自动换成相邻模型。[Wan 3.0 模型页](https://openrouter.ai/alibaba/wan-3.0)、[Grok Imagine Image 2.0 模型页](https://openrouter.ai/x-ai/grok-imagine-image-2.0)。SDK 协议与依赖版本分别见[ElevenLabs TypeScript SDK](https://github.com/elevenlabs/elevenlabs-js)、[OpenRouter TypeScript SDK](https://github.com/OpenRouterTeam/typescript-sdk)及仓库 `package-lock.json`。

## 2. 单一语义目录与 schema

[models.ts](../src/models.ts) 的 `modelRegistry` 提供 `resolve()`、`describe()`、`query()`、`prepareRequest()` 与 `createPlugin()`。描述包括模型版本、输出种类、字段声明、settings / 草稿 params / 可执行 params 的 JSON Schema，以及引用种类与数量边界。查询默认 5 项、最多 20 项，支持 cursor、过滤与 exclude。GUI、CLI、Agent 可以消费同一份目录；基于对象、权限的 `CapabilityCatalog` 查询服务仍待接线。

`ModelTimelinePlugin` 复用 `BaseTimelinePlugin`，各模型拥有自己的 Item kind 与字段。草稿可以先保留空文本，生成前必须通过可执行 schema。未知字段、错误单位、互斥参数和不支持的引用都会在调用 SDK 之前被拒绝。schema 的默认值在后端一次规范化，保存到请求快照，执行中不再读取对象的新参数。

1.5 将内容目录与生成模型目录分开：`TimelineRegistry` 包含四种本地插件并组合 `ModelRegistry`，本地轨没有模型 ID 或 SDK 调用。模型 descriptor 声明 `referenceTextFields`、必需文本字段、引用条件限额和跨字段生成 schema；GUI 与后端消费共同规则，不从模型名称猜测 `prompt`、`text` 或引用上限。新增模型及窗口的具体接线步骤见[本地时间线与扩展边界](local-timelines-and-extension.zh-CN.md)。

生产初始项目不预置模型、Item 或示例提示词。主 Timeline 空白处、名称、时间位置和片段右键共用“新建时间线 → 选择模型”，只创建空 Timeline，满轨时也可使用。已有 Timeline 时间位置右键 → 新建生成草稿，经 `item.createDraft` 显式创建无输出的 Item；Asset → Timeline 时间位置则经带 `assetId` 的 `item.create` 放置已有素材。参数字段随后通过对象详情披露。模型 schema 默认值是已明确创建对象的规范化，不是自动向项目填入示例内容；创建模型本身不会附送草稿。

| 模型 | `params` 中的主要字段 | `settings` | 生成时长含义 |
| --- | --- | --- | --- |
| Eleven v4 | `text`、`voiceId`、`voiceSettings`、`languageCode`、nullable `seed`、`outputFormat`、`contextMode`、`previousText` / `nextText`、`trimTail`、`tailPaddingMs` / `tailFadeMs` | 严格 `{}` | 由文本与语音决定，不接受固定 `durationMs` |
| Sound Effects v2 | `text`、nullable `durationSeconds`、`promptInfluence`、`loop`、`outputFormat` | 严格 `{}` | 自动选择，或 0.5–30 秒 |
| Music v2.5 | `prompt` 或 `compositionPlan`、nullable `musicLengthMs`、`forceInstrumental`、nullable `seed`、`finetuneId`、`outputFormat` | 严格 `{}` | prompt 模式自动选择或 3000–600000 毫秒；计划模式为 chunks 总时长 |
| Wan 3.0 | `prompt`、`durationSeconds`、`generateAudio`、nullable `seed`、`referenceMode` | `resolution`、`aspectRatio` | 2–30 整秒，默认 5 秒 |
| Grok Imagine Image 2.0 | `prompt` | `resolution`、`quality`、`aspectRatio` | 静态图像，不接受 `durationMs` |

Eleven v4 生成前必须指定真实 `voiceId`，代码不编造默认音色。正文最多 10000 字符；官方 Dialogue 文档建议每次正文不超过 2000 字符以保证可靠性，长文应由用户拆成片段，后端不擅自截断正文或拆成多个收费请求。v4 使用 Text to Dialogue，而非此前适配器使用的 Text to Speech：单个 Item 映射成 `inputs: [{ text, voiceId }]`，保留 languageCode 与 seed。本模型的 `voiceSettings` 公开 `stability` 与 `similarityBoost`，SDK 边界把后者映射为 Dialogue 的 `settings.similarity`；nullable 对象表示采用已有声音设置。`speed`、`style` 等不支持字段仍拒绝。[ElevenLabs 模型目录](https://elevenlabs.io/docs/overview/models)、[Dialogue API](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)。

`contextMode` 为 neighbors / manual / none，默认 neighbors。工作台提交时按同一 Timeline 的时间顺序捕获相邻同音色文本，各取前段末尾及后段开头最多 100 个 Unicode 字符；音色改变形成连续性边界。manual 使用 Item 的 previousText / nextText，各最多 100 字符；none 不发送上下文。SDK 分别映射为 previousText 与 futureText，正文只包含当前片段。捕获 context 进入请求快照与输入指纹，不能在执行中重新读取邻居。[官方上下文参数](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)。

`trimTail` 默认 true，tailPaddingMs 默认 40（0–500），tailFadeMs 默认 5（0–50）。开启时采用 `convertWithTimestamps`，以当前正文最后有效发音字符的时间戳确定边界，余量不越过额外发音起点；音频后处理器实际解码为 PCM、按样本裁切并在正文之后的余量内淡出，再编码为含延迟/填充信息的 MP3。缺失、错配或越界时间戳会明确失败，不能猜测裁掉固定毫秒数或破坏 MP3 字节。关闭裁尾时采用 Dialogue 的普通音频接口。此能力减少已知的尾部多余发音，不能代替真实供应商生成质量验证。实现与验证详见[默认配置与语音连续性升级](timeline-defaults-and-speech.zh-CN.md)。

音频 `outputFormat` 只有一个入口，放在 Item 的 `params`。当前公开 MP3 输出，语音及音效默认 `mp3_44100_128`，音乐默认 `mp3_48000_192`。音效的 `promptInfluence` 默认 0.3，`loop` 默认 false。[音效 API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)。

音乐支持 prompt 与纯生成 chunks 计划两种互斥输入。`musicLengthMs`、`forceInstrumental` 只用于 prompt；`seed` 只用于计划。计划最多 30 个 chunks，每段 3000–120000 毫秒，总时长最多 600000 毫秒；段落声明文本、正向 / 负向风格和上下文贴合程度。上传歌曲的 `songId`、引用型 chunks、`conditioningRef` 与 inpainting 尚未接入，其参数会被严格 schema 拒绝。[音乐 API](https://elevenlabs.io/docs/api-reference/music/compose)、[官方 composition plan 说明](https://github.com/elevenlabs/skills/blob/main/music/references/api_reference.md)。

Wan 公开 480p / 720p / 1080p，支持当前目录声明的五种宽高比；Grok 公开 1K / 2K、low / medium 质量及模型声明的宽高比，当前每次产生一张图。[Wan 模型页](https://openrouter.ai/alibaba/wan-3.0)、[Grok 模型页](https://openrouter.ai/x-ai/grok-imagine-image-2.0)。图像不继承视频的帧率、时长、负向提示词或 seed 参数。

`GenerationRequest.settings` 捕获 Item 的生成设置快照（旧 Item 回退其 Timeline 设置）；`durationMs` 表达模型生成时长，不能自动等同于 Item 在作品中的播放区间。SFX / music prompt 未设时长但提供 `durationMs` 时，将其规范成该模型的秒 / 毫秒参数；同时提供的两种表示必须一致。自然语音时长与静态图像保持独立语义。`PluginFieldDeclaration` 的 `object` / `array`、`children`、`visibleWhen` 与 `nullable` 让宿主逐层显示复杂字段，不要求插件自行增加界面。

### Eleven v4 的声音选择与克隆

Timeline 左侧单击进入 Eleven v4 默认配置详情，直接显示声音来源、声音选择、克隆音频文件选择、声纹名称及“克隆声纹”按钮。默认声音、自己的克隆和手填声音 ID 增强同一个字符串 `voiceId` 字段；选择默认音色并不生成声音，切换来源也不清空当前 ID。列表未找到原 ID 时保留该值，不自动改为第一项。选用声纹经原 `timeline.defaults` 或 `item.params` Action；克隆完成只刷新账号目录并显示结果 ID，不自动选择，也不修改默认配置或已有片段。

`ElevenLabsVoiceProvider` 使用官方 `voices.search()`，默认声音按 `voiceType: 'default'` 查询，自己的克隆按 `voiceType: 'personal'` 查询并保留 IVC / PVC、筛除声音设计及明确非本人资源；不使用已弃用的无分页 `getAll()`。`VoiceService.query()` 默认每页 5 项、最多 20 项，当前 GUI 显式请求每页 20 项并提供搜索与“更多声音”。宿主 cursor 绑定凭证作用域、分类和搜索；供应商首屏多返回的声音会保存为后续页，过滤后的空页仍保留下一页入口，不能切片后丢失声音。[官方声音查询](https://elevenlabs.io/docs/api-reference/voices/search)。

列表将供应商明确的验证及准备状态规范为 `ready`、`verificationRequired` 或 `unavailable`；后两类在声音选择中禁用并显示状态 / 原因，原有 ID 仍保留。缺少验证字段不等于不可用。创建使用 `voices.ivc.create()`，即 Instant Voice Cloning；返回的 `voiceId` 和 `requiresVerification` 会持久化，待验证时保留 ID，提示到 ElevenLabs 完成验证。当前官方 IVC SDK 没有供本实现自动完成验证的端点，不能把 PVC 的 captcha / verification 接口混用于 IVC。[官方 IVC 创建接口](https://elevenlabs.io/docs/api-reference/voices/ivc/create)。

上传限定一个 MP3 或 WAV 文件、非空且不超过 25 MiB；这是 Pixel 的宿主上限，不声称供应商有相同限额。工作台校验当前项目、支持声纹的目标和 revision，按真实字节识别类型并实际探测音频，再调用服务。文件名只作为 multipart 上传名，供应商不能通过前端路径读取本机文件；本地项目不保存克隆音频样本、密钥或供应商完整账号资料。

标准命令 `voice.clone` 创建账号资源，不伪造 Asset、GenerationJob 或项目编辑。`VoiceService` 在上游 POST 前先持久化 attempt；requestId 绑定项目、目标、原 revision、名称、格式、文件名、完整字节哈希及 API key 的凭证作用域哈希。成功回执可重放，重复编号但内容改变会拒绝。凭证哈希不是供应商永久账号 ID，改换密钥后不能复用旧作用域的回执。已尝试而结果未知、超时、断线或重启后的命令不重复 POST，应先刷新自己的声纹或在 ElevenLabs 核对。没有供应商幂等承诺可以代替这个守卫，SDK 写请求禁用自动重试。

`shutdown()` 同步关闭入口并取消本地等待，随后等待查询、克隆结算及回执写入完成；晚到成功不覆盖已经关闭窗口的意图。关闭不能证明远端没有创建声纹，保存成功回执的结果仍可在下一次会话读取。权限、套餐或限流错误返回脱敏原因；模拟测试不能证明真实账号的克隆资格、名额或语音生成权限。

## 3. 引用、异步任务与恢复

Wan / Grok 的 `referenceMaxBytes` 声明当前宿主的单图上限 25 MiB，与 `MAX_IMAGE_REFERENCE_BYTES` 和 SDK 输入转换守卫共用一个来源。界面显示此值并在发送前拒绝超限文件；文件上传保存前、已有素材关联及生成捕获均重新检查实际字节或已知大小。旧素材缺少 `metadata.byteLength` 时由 SDK 的受控读取最终检查，不能把 HTTP 通用 256 MiB 上传上限当成模型支持上限，也不声称这是供应商承诺的同一限额。

请求中的引用保存受控 Asset 记录，可声明 `reference`、`first-frame` 或 `last-frame` 角色。媒体读取由宿主 `MediaReader` 解析 `fileRef`；供应商只接收读取结果，不把资产 metadata 中的任意 URL 当成真实文件。

当前三个 ElevenLabs 生成端点不接收 Asset 媒体引用，声音克隆的账号资源上传另属前节边界；Wan 与 Grok 只接收图片。Grok 最多三张参考图。Wan 的普通参考模式采用宿主上限三张，该上限在 descriptor 中明确标为 `host`；首帧模式 minimum / maximum 均为 1，生成必须恰好一张图，当前不支持末帧。共享 [reference-policy.ts](../src/reference-policy.ts) 的 `referenceMinimum()` / `referenceLimit()` 被目录、GUI 能力提示、关系提交和生成规范化共同消费；不能各自复制数量规则。不会因接口宽泛就静默忽略输入类型或角色。[Grok 模型引用限制](https://openrouter.ai/x-ai/grok-imagine-image-2.0)、[OpenRouter 视频引用协议](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)。

1.6 按用户要求在模型详情直接说明媒体输入能力：支持参考的 Item 显示当前格式、已用数量、最小 / 最大数量和可见文件上传入口；Timeline 默认详情只显示能力说明，引用仍属于具体 Item。三个音频生成模型显示简短的不支持媒体参考说明，不出现无效上传入口，不把“有声音克隆”解释成“语音生成支持音频参考”。Wan 首帧模式缺图时提示必需一张，第二张图在提交前即拒绝；后端在 Action 与生成规范化时继续校验，前端提示不替代业务检查。

原始 PNG / JPEG / WebP 文件从 Item 详情上传，经宿主验证和 `media.referenceExternal` 原子 Action 一次登记项目素材并建立引用。已有库 Asset 拖入 Item 引用区经 `item.reference.add` 只建立关系，拥有不同的前置对象和业务结果；库导入则只创建可复用 Asset。三者不通过菜单询问“导入、引用或替换”，也不把上传控件复制为已有 Asset 的第二条 GUI 入口。引用区仍接受合法素材拖拽，hover/drop 检查类型、重复关系和当前模式上限。

1.7 为生成视频声明 `capabilities.manualOutput`，对应 Item 详情直接显示“上传生成结果”，选择人工上传或外部网页生成来源后上传单个不超过 256 MiB 的 MP4。`Workbench.importOutputMedia()` 走共同真实字节及时长校验，再由受信 `media.outputExternal` 原子挂载到原 Item；它是成片输出，不是模型参考，不发起生成请求。提交保留模型、提示词、设置、位置与引用，重置 `sourceOffsetTicks` 为 0，时长取原编辑区间与源时长较小值；长素材需用户显式调整边缘。`outputOrigin: manual` 与 Asset 的 `metadata.outputProvenance: manual | external` 记录来源；修改参数或刷新默认值继续保留人工输出，只有显式生成及其有效结果可替换。上传成功在同一事务旋转 token 并排入取消命令，旧任务结果不能覆盖；上传失败或 revision 冲突不取消已接受的生成。具体并发与资源契约见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)。

`BaseModelProvider.generate()` 是公共执行模板：严格解析请求、调用统一模型规范化、检查 provider / 适配器版本、设置覆盖请求及流读取的总超时、转发取消、校验产物的 job / attempt 归属，并脱敏供应商错误。扩展点是受保护的 `performGeneration()`。SDK 的生成请求禁用自动重试，避免一次本地失败悄悄产生第二次生成。

ElevenLabs 的网络 fetch 拒绝会触发当前 SDK 的计时器清理缺口；核心 `createSdkFetch()` 将该本地失败转换成无响应内容的错误状态，继续由 SDK 正常处理，再由公共模板返回脱敏错误。模拟 HTTP 测试覆盖该兼容问题、流在收到 headers 后仍挂起的超时，以及取消后的流释放；无需替换供应商 SDK 或改变生成语义。

Wan 使用异步视频 API：先提交，再将供应商任务 ID 通过 `checkpointProviderTask()` 持久化，随后轮询，最后使用固定的 SDK content 端点下载产物。恢复时传入已保存的 `providerTaskId`，只继续查询及下载，不重复 POST。适配器不会直接访问 OpenRouter 响应中的任意 polling / unsigned URL。[OpenRouter 异步视频 API](https://openrouter.ai/docs/api/api-reference/video-generation/create-videos)。

[runtime.ts](../src/runtime.ts) 的 `GenerationRunner` 实现后端的 `run()` / `resume()`；[storage.ts](../src/storage.ts) 的 `FileJobRepository` 将请求快照、状态和远端任务 ID 保存在项目目录，生产媒体及产物索引由 [SeafileArtifactStore](../src/seafile-storage.ts) 统一保存。`MediaArtifactStore` 同时提供写入、索引、受控读取和字节范围读取；模型参考、生成产物、普通导入与人工输出共用此边界。Seafile 官方 JavaScript 客户端已经归档，当前采用隔离的 REST 适配器；`FileArtifactStore` 仅用于测试或旧资源迁移读取，不是生产回退。项目本地 ledger 面向单后端进程，用 attempt / state guard 串行更新；它自身不提供项目与 outbox 的联合事务，也不承担多进程数据库锁。工作台的 `FileWorkbenchRepository` 已原子提交项目 token 与 outbox，随后由宿主消费任务 ledger，并通过内部 Action 检查请求归属后挂载产物。

中断任务恢复到 queued 时，`transitionJob()` 递增 attempt、清除旧运行结果并保留已持久化的远端任务 ID。已有 `providerTaskId` 且供应商支持恢复时，`TIMEOUT`、`UPSTREAM`、`RATE_LIMITED` 或 `AUTHENTICATION` 错误归为 `interrupted`，保留原任务等待显式恢复；不自动重试，也不发起新的生成 POST。没有远端 ID 的任务不会盲目恢复并再次提交。供应商已确认失败 / 取消 / 过期时返回 `REMOTE_FAILED` 并进入 `failed` 终态，不会当作可恢复中断。Grok 与 ElevenLabs 本次没有可恢复的远端任务协议。两家 provider 的本地取消均不声称供应商已经停止计费。

## 4. 后端配置与诊断

`loadBackendConfiguration()` 读取后端模型配置 `ELEVENLABS_API_KEY` 与 `OPENROUTER_API_KEY`；`loadSeafileConfiguration()` 读取服务、资料库和凭证配置，两者均以进程环境变量覆盖 `.env`。资源服务需要 `SEAFILE_URL` 及 `SEAFILE_TOKEN` 或账户凭证；团队应使用 `SEAFILE_REPO_ID` 固定绑定资料库，未指定 ID 时按唯一库名查找，没有匹配才创建专用库，同名歧义明确拒绝。具体可选项见 [`.env.example`](../.env.example)。`createModelBackend()` 注册两个 provider 并接收统一资源存储；默认 `.pixel` 只承担诊断任务 ledger，媒体保存在 Seafile。资源服务配置失败或不可达时明确失败，不悄悄写入本地。凭证不进入 model descriptor、项目文件、任务请求快照、前端或日志。

查询模型无需生成：

```sh
npm run models
```

诊断 CLI 从 JSON 文件读取参数；以下 `generate` 命令会调用真实模型，可能产生费用。先从模型目录查看可执行 schema，填写正确参数。

```sh
npm run generate -- --model eleven_v4 --params-file speech-params.json
npm run generate -- --model eleven_text_sound_v2 --params-file sound-params.json
npm run generate -- --model music_v2_5 --params-file music-params.json
npm run generate -- --model alibaba/wan-3.0 --params-file video-params.json --settings-file video-settings.json
npm run generate -- --model x-ai/grok-imagine-image-2.0 --params-file image-params.json --settings-file image-settings.json
npm run generate -- --resume JOB_ID
```

`speech-params.json` 的最小例子如下，将 `voiceId` 替换成账户有权使用的声音 ID。没有 voiceId 时，在请求前返回输入错误。

```json
{
  "text": "你好，这是 Pixel 的语音生成测试。",
  "voiceId": "填写可用声音的 ID"
}
```

视频参数文件可写 `{"prompt":"日落时海边的缓慢镜头","durationSeconds":5}`，设置文件可写 `{"resolution":"720p","aspectRatio":"16:9"}`。音乐 prompt 模式使用 `{"prompt":"柔和钢琴与弦乐","musicLengthMs":30000,"forceInstrumental":true}`。图像参数只需 `prompt`；省略设置时采用当前模型的默认值。再次执行生成是新的请求；`--resume` 仅用于已有远端任务的中断恢复。

图片参考可重复传入 `--reference-file image.png`；诊断工具先将 PNG / JPEG / WebP 导入 Seafile 受控产物存储，再捕获引用，单图最多 25 MiB。Wan 首帧模式在参数文件中设置 `"referenceMode":"firstFrame"` 并传入恰好一张图片。`--storage-dir path` 只指定诊断任务 ledger 目录；恢复必须使用原任务所在目录和原 Seafile 配置，且不能同时替换参数、设置或引用。成功结果返回 `pixel-asset:<UUID>` 不透明句柄，不暴露媒体路径、凭证或临时下载地址。

该 CLI 是后端接入诊断工具，使用 `projectId: 'backend-example'` 与 `targetItemId: 'example-item'` 捕获 `GenerationRequest`，直接调用 `run()` / `resume()`，复用模型校验与执行内核。它不是当前 GUI 项目的 `ActionEnvelope` 入口，不将生成产物自动挂载到该项目。GUI 的 `generation.submit`、原子 outbox 和内部结果挂载已通过 `Workbench` / `ActionExecutor` 实现；正式项目 CLI / Agent 适配器仍待接线，届时必须调用同一 Action 协议，不能把诊断执行成功宣称为这些入口已经完成。

## 5. 设计哲学评审与当前证据

对应设计哲学第 10 节，模型能力作用于 Timeline 默认配置、Item 生成请求、任务、产物和独立账号声纹资源。标准 GUI 路径为 Timeline 左侧单击配置、左侧右键刷新默认配置、主时间线对象上下文的同一个右键建轨命令、已有时间位置右键创建生成草稿、Item 双击编辑与右键生成。1.6 在相关详情中可见声音选择 / 克隆和原始参考文件上传控件，1.7 增加生成视频结果上传，均使用同一宿主及共享服务，不新增插件 Modal 或主工作区常驻工具。已有 Asset 拖拽仍只建立已有对象关系；原始参考文件上传登记素材并引用，人工成片上传则挂载输出，业务语义明确分开。默认仍只显示 Viewer + Timeline，素材库唯一入口仍为主 Viewer 右键；并行窗口及局部详情隔离保持 1.3 语义。旧片段保留原值、设置快照和明确刷新规则；当前评审见[共享资源与人工输出](shared-resources-and-manual-output.zh-CN.md)，1.6 记录保留在[声音、输入、分组与多轨预览](voices-inputs-groups-and-composition.zh-CN.md)，此前记录保留在[默认配置与语音连续性升级](timeline-defaults-and-speech.zh-CN.md)和[哲学对齐记录](philosophy-alignment.zh-CN.md)。

`ModelRegistry`、共享引用政策与 `BaseModelProvider` 集中校验，正式项目 CLI / Agent 接线时也应复用，避免各自复制供应商规则。项目权威状态边界不变，生成任务 ledger 与 Seafile 产物存储独立于编辑历史，runner 不直接写项目；声纹 ledger 是另一类账号资源记录，不混入生成任务或项目修订。attempt、保存远端 ID 与总超时保护中断执行；工作台已在 `generation.apply` 事务内执行旧结果、含 context 的请求指纹及产物归属检查。音频后处理组合到现有 provider 流程，继承同一取消与总超时。当前基线及调整依据以设计哲学 1.7 为准；旧 Item 缺失的设置快照惰性兼容，无需清空项目，没有调用真实计费服务。

相关自动验证覆盖 schema 默认值与未知字段、模型别名、图像 / 音频 / 视频参数隔离、真实 SDK 编码、禁用自动重试、checkpoint 顺序与远端恢复、引用最小 / 最大边界、声纹分页溢出、回执重放与未知结果、取消、超时、异常产物和脱敏错误。测试使用模拟响应，不能证明账号权限、余额、声纹身份验证结果或供应商实际生成质量；真实端到端验证按明确请求另行执行。
