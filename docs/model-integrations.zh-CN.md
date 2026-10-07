# Pixel 模型接入与执行边界

更新日期：2026-10-08。产品与交互规则沿用[设计哲学](design-philosophy.zh-CN.md)；项目、Action 与任务的完整边界见[核心架构](core-architecture.zh-CN.md)。

这次接入实现后端的官方 SDK 适配器、共享模型语义目录、文件任务 ledger、媒体产物存储和诊断 CLI。验证使用真实 SDK 配合模拟 HTTP 响应，未发起付费生成请求。Electron / React 页面、`generation.submit` 的项目事务与 outbox、`generation.applyResult` 的项目挂载仍待实现；生成文件成功不代表项目已自动关联输出。

## 1. 模型、标识与输出

| 用户指定模型 | 持久化及 API 的 canonical modelId | SDK / 接口 | outputKind / Item 语义 |
| --- | --- | --- | --- |
| `eleven_v4` | `eleven_v4` | `@elevenlabs/elevenlabs-js`，`textToSpeech.convert` | `audio` / `audio.speech` |
| `eleven_text_sound_v2` | `eleven_text_to_sound_v2` | 同上，`textToSoundEffects.convert` | `audio` / `audio.soundEffect` |
| `music_v2_5` | `music_v2_5` | 同上，`music.compose` | `audio` / `audio.music` |
| Alibaba: Wan 3.0 | `alibaba/wan-3.0` | `@openrouter/sdk`，`videoGeneration.generate` / `getGeneration` / `getVideoContent` | `video` / `video.generated` |
| Grok Imagine Image 2.0 | `x-ai/grok-imagine-image-2.0` | 同上，`images.generate`，`/api/v1/images` | `image` / `image.generated` |

Eleven v4 的官方模型标识为 `eleven_v4`；音效端点的官方标识含 `to`，因此将用户给出的 `eleven_text_sound_v2` 登记为同一模型的输入别名，规范化后才保存请求。[ElevenLabs 模型目录](https://elevenlabs.io/docs/overview/models)、[音效 API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)。音乐明确传递 `music_v2_5`，不依赖 API 的默认模型。[音乐 API](https://elevenlabs.io/docs/api-reference/music/compose)。

Wan 与 Grok 使用用户指定的版本，不在失败时自动换成相邻模型。[Wan 3.0 模型页](https://openrouter.ai/alibaba/wan-3.0)、[Grok Imagine Image 2.0 模型页](https://openrouter.ai/x-ai/grok-imagine-image-2.0)。SDK 协议与依赖版本分别见[ElevenLabs TypeScript SDK](https://github.com/elevenlabs/elevenlabs-js)、[OpenRouter TypeScript SDK](https://github.com/OpenRouterTeam/typescript-sdk)及仓库 `package-lock.json`。

## 2. 单一语义目录与 schema

[models.ts](../src/models.ts) 的 `modelRegistry` 提供 `resolve()`、`describe()`、`query()`、`prepareRequest()` 与 `createPlugin()`。描述包括模型版本、输出种类、字段声明、settings / 草稿 params / 可执行 params 的 JSON Schema，以及引用种类与数量边界。查询默认 5 项、最多 20 项，支持 cursor、过滤与 exclude。GUI、CLI、Agent 可以消费同一份目录；基于对象、权限的 `CapabilityCatalog` 查询服务仍待接线。

`ModelTimelinePlugin` 复用 `BaseTimelinePlugin`，各模型拥有自己的 Item kind 与字段。草稿可以先保留空文本，生成前必须通过可执行 schema。未知字段、错误单位、互斥参数和不支持的引用都会在调用 SDK 之前被拒绝。schema 的默认值在后端一次规范化，保存到请求快照，执行中不再读取对象的新参数。

| 模型 | `params` 中的主要字段 | `settings` | 生成时长含义 |
| --- | --- | --- | --- |
| Eleven v4 | `text`、`voiceId`、`voiceSettings`、`languageCode`、nullable `seed`、`outputFormat` | 严格 `{}` | 由文本与语音决定，不接受固定 `durationMs` |
| Sound Effects v2 | `text`、nullable `durationSeconds`、`promptInfluence`、`loop`、`outputFormat` | 严格 `{}` | 自动选择，或 0.5–30 秒 |
| Music v2.5 | `prompt` 或 `compositionPlan`、nullable `musicLengthMs`、`forceInstrumental`、nullable `seed`、`finetuneId`、`outputFormat` | 严格 `{}` | prompt 模式自动选择或 3000–600000 毫秒；计划模式为 chunks 总时长 |
| Wan 3.0 | `prompt`、`durationSeconds`、`generateAudio`、nullable `seed`、`referenceMode` | `resolution`、`aspectRatio` | 2–30 整秒，默认 5 秒 |
| Grok Imagine Image 2.0 | `prompt` | `resolution`、`quality`、`aspectRatio` | 静态图像，不接受 `durationMs` |

Eleven v4 生成前必须指定真实 `voiceId`，代码不编造默认音色。文本最多 10000 字符；本模型的 `voiceSettings` 只公开 `stability` 与 `similarityBoost`，nullable 对象表示使用该声音的已有设置。v4 不支持的 `speed`、`style` 等字段会被拒绝。[语音 API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[ElevenLabs 官方 v4 voice settings 说明](https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md)。

音频 `outputFormat` 只有一个入口，放在 Item 的 `params`。当前公开 MP3 输出，语音及音效默认 `mp3_44100_128`，音乐默认 `mp3_48000_192`。音效的 `promptInfluence` 默认 0.3，`loop` 默认 false。[音效 API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)。

音乐支持 prompt 与纯生成 chunks 计划两种互斥输入。`musicLengthMs`、`forceInstrumental` 只用于 prompt；`seed` 只用于计划。计划最多 30 个 chunks，每段 3000–120000 毫秒，总时长最多 600000 毫秒；段落声明文本、正向 / 负向风格和上下文贴合程度。上传歌曲的 `songId`、引用型 chunks、`conditioningRef` 与 inpainting 尚未接入，其参数会被严格 schema 拒绝。[音乐 API](https://elevenlabs.io/docs/api-reference/music/compose)、[官方 composition plan 说明](https://github.com/elevenlabs/skills/blob/main/music/references/api_reference.md)。

Wan 公开 480p / 720p / 1080p，支持当前目录声明的五种宽高比；Grok 公开 1K / 2K、low / medium 质量及模型声明的宽高比，当前每次产生一张图。[Wan 模型页](https://openrouter.ai/alibaba/wan-3.0)、[Grok 模型页](https://openrouter.ai/x-ai/grok-imagine-image-2.0)。图像不继承视频的帧率、时长、负向提示词或 seed 参数。

`GenerationRequest.settings` 捕获 Timeline 设置；`durationMs` 表达模型生成时长，不能自动等同于 Item 在作品中的播放区间。SFX / music prompt 未设时长但提供 `durationMs` 时，将其规范成该模型的秒 / 毫秒参数；同时提供的两种表示必须一致。自然语音时长与静态图像保持独立语义。`PluginFieldDeclaration` 的 `object` / `array`、`children`、`visibleWhen` 与 `nullable` 让宿主逐层显示复杂字段，不要求插件自行增加界面。

## 3. 引用、异步任务与恢复

请求中的引用保存受控 Asset 记录，可声明 `reference`、`first-frame` 或 `last-frame` 角色。媒体读取由宿主 `MediaReader` 解析 `fileRef`；供应商只接收读取结果，不把资产 metadata 中的任意 URL 当成真实文件。

当前三个 ElevenLabs 端点不接收 Asset 引用；Wan 与 Grok 只接收图片。Grok 最多三张参考图。Wan 的普通参考模式采用宿主上限三张，该上限在 descriptor 中明确标为 `host`；首帧模式必须恰好一张图，当前不支持末帧。不会因接口宽泛就静默忽略输入类型或角色。[Grok 模型引用限制](https://openrouter.ai/x-ai/grok-imagine-image-2.0)、[OpenRouter 视频引用协议](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)。

`BaseModelProvider.generate()` 是公共执行模板：严格解析请求、调用统一模型规范化、检查 provider / 适配器版本、设置覆盖请求及流读取的总超时、转发取消、校验产物的 job / attempt 归属，并脱敏供应商错误。扩展点是受保护的 `performGeneration()`。SDK 的生成请求禁用自动重试，避免一次本地失败悄悄产生第二次生成。

ElevenLabs 的网络 fetch 拒绝会触发当前 SDK 的计时器清理缺口；核心 `createSdkFetch()` 将该本地失败转换成无响应内容的错误状态，继续由 SDK 正常处理，再由公共模板返回脱敏错误。模拟 HTTP 测试覆盖该兼容问题、流在收到 headers 后仍挂起的超时，以及取消后的流释放；无需替换供应商 SDK 或改变生成语义。

Wan 使用异步视频 API：先提交，再将供应商任务 ID 通过 `checkpointProviderTask()` 持久化，随后轮询，最后使用固定的 SDK content 端点下载产物。恢复时传入已保存的 `providerTaskId`，只继续查询及下载，不重复 POST。适配器不会直接访问 OpenRouter 响应中的任意 polling / unsigned URL。[OpenRouter 异步视频 API](https://openrouter.ai/docs/api/api-reference/video-generation/create-videos)。

[runtime.ts](../src/runtime.ts) 的 `GenerationRunner` 实现后端的 `run()` / `resume()`；[storage.ts](../src/storage.ts) 的 `FileJobRepository` 与 `FileArtifactStore` 保存请求快照、状态、远端任务 ID 和真实媒体文件。文件 ledger 面向单后端进程，用 attempt / state guard 串行更新；它不提供项目与 outbox 的联合事务，也不承担多进程数据库锁。

中断任务恢复到 queued 时，`transitionJob()` 递增 attempt、清除旧运行结果并保留已持久化的远端任务 ID。已有 `providerTaskId` 且供应商支持恢复时，`TIMEOUT`、`UPSTREAM`、`RATE_LIMITED` 或 `AUTHENTICATION` 错误归为 `interrupted`，保留原任务等待显式恢复；不自动重试，也不发起新的生成 POST。没有远端 ID 的任务不会盲目恢复并再次提交。供应商已确认失败 / 取消 / 过期时返回 `REMOTE_FAILED` 并进入 `failed` 终态，不会当作可恢复中断。Grok 与 ElevenLabs 本次没有可恢复的远端任务协议。两家 provider 的本地取消均不声称供应商已经停止计费。

## 4. 后端配置与诊断

`loadBackendConfiguration()` 只读取后端需要的 `ELEVENLABS_API_KEY` 与 `OPENROUTER_API_KEY`，进程环境变量优先于 `.env`。`createModelBackend()` 注册两个 provider 并使用默认 `.pixel` 存储目录。密钥不进入 model descriptor、项目文件、任务请求快照、前端或日志。

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

图片参考可重复传入 `--reference-file image.png`；诊断工具先将 PNG / JPEG / WebP 导入受控产物存储，再捕获引用，单图最多 25 MiB。Wan 首帧模式在参数文件中设置 `"referenceMode":"firstFrame"` 并传入恰好一张图片。`--storage-dir path` 可指定诊断存储目录；恢复必须使用原任务所在目录，且不能同时替换参数、设置或引用。

该 CLI 是后端接入诊断工具，直接运行捕获的 `GenerationRequest`，使用同一模型校验与执行内核。正式 GUI / CLI / Agent 项目编辑入口仍需通过 `ActionExecutor` 实现 `generation.submit`、原子 outbox 和结果挂载，不能把诊断执行成功宣称为该项目工作流已完成。

## 5. 设计哲学评审与当前证据

对应设计哲学第 10 节，本次作用于模型参数、Item 生成请求、任务与产物；标准 GUI 路径仍为 Timeline 空白处右键选模型创建、Item 双击编辑、Item 右键生成，未增加模型拖拽、常驻按钮或插件 Modal。新增字段仅扩展语义，由宿主决定控件和详情导航。

`ModelRegistry` 与 `BaseModelProvider` 集中校验，不在 GUI / CLI / Agent 各自复制供应商规则。项目权威状态边界不变，任务 ledger 与产物存储独立于编辑历史；没有实现挂载 Action 前，runner 不写项目。attempt、保存远端 ID 与总超时保护中断执行；项目层的旧结果守卫仍需在 `generation.applyResult` 的事务里最终检查。本次是现有哲学的实现补全，不改变产品基线。

相关自动验证覆盖 schema 默认值与未知字段、模型别名、图像 / 音频 / 视频参数隔离、真实 SDK 编码、禁用自动重试、checkpoint 顺序与远端恢复、引用限制、取消、超时、异常产物和脱敏错误。测试使用模拟响应，不能证明账户权限、余额或供应商实际生成质量；付费端到端验证按明确请求另行执行。
