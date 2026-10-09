# 时间线默认配置与语音连续性升级

日期：2026-10-09。遵循[设计哲学 1.4](design-philosophy.zh-CN.md)及[核心架构](core-architecture.zh-CN.md)。模型接口依据见[模型接入文档](model-integrations.zh-CN.md)。

## 用户要求与能力检查

用户要求时间轴左侧点击设置默认配置，已有片段保留原值，并增加明确刷新选项；Eleven v4 需要前后文参考及生成后的尾音处理。检查发现原基类能统一执行、取消和保存生成结果，但缺少可校验的时间线参数默认值、文本上下文快照及音频后处理边界。原 v4 适配器还调用了不适用的 Text to Speech 接口。升级在共享契约、插件构造和 provider 适配边界补齐这些能力，不把模型规则写入前端事件。

## 默认配置的业务语义

Timeline 的 `itemDefaults` 是显式、稀疏的参数映射，`settings` 是新片段的生成设置默认值。默认参数声明来自同一个模型目录，不由宿主猜测哪些文本可以批量复制。正文、提示词、音乐计划、手动前后文和素材引用不能成为默认值。

`BaseTimelinePlugin.resolveItemDefaults()` 按插件声明解析有效默认值，供新片段创建与显式刷新共用。新片段通过 `createItem()` 再合并显式参数，同时捕获 `generationSettings`。已有片段不随默认值变化；旧项目缺少设置快照的片段，在默认设置改变前由后端事务固定原设置。旧项目不需要重建或清空。

| 入口 | Action / 行为 | 作用 |
| --- | --- | --- |
| 时间轴左侧单击（Enter 等价） | 局部详情导航 | 进入唯一默认配置详情，复用单 Modal path |
| 默认配置字段编辑 | `timeline.defaults` / `timeline.settings` | 保存新片段默认配置，保留已有片段原值 |
| 时间轴左侧右键 → 刷新时间轴默认配置 | `timeline.refreshDefaults` | 把当前有效默认参数及生成设置应用到该 Timeline 已有片段 |

刷新不创建片段、不启动生成、不移动片段，也不改变正文或引用。有效默认参数仅包含模型 defaultFields 声明的字段，由模型基础值与时间线稀疏覆盖合并，与配置窗口显示及新片段继承一致；未登记为默认字段的片段参数继续保留。相同配置刷新无须改变片段 token；实际生成输入变化才换 token，解除旧生成输出关联。`outputOrigin` 明确区分 generated 与 placement；放置已有真实素材的输出继续保留。旧输出通过已有导入/provider 元数据识别，不能确定来源时保守保留。解除关联不删除资产或文件。

## 文本上下文与旧结果保护

`GenerationRequest.context` 是纯数据，可包含 previousText / nextText。模型声明 `contextMaxCharacters` 能力；其他模型不能借此接收未支持参数。Eleven v4 的 contextMode 默认 neighbors，工作台提交时在同一 Timeline 按时间排序，寻找邻接非空文本，以音色切换为连续性边界。捕获前文最后 100、后文最前 100 个 Unicode 字符。manual 使用片段自己的前后文，none 不发送前后文。

当前片段正文单独传入 Dialogue 的 inputs，参考文本分别传 previousText / futureText，不通过拼接正文让模型同时朗读邻居。请求捕获后不会跟随邻居继续变化。结果挂载时重新计算相同捕获规则和包含 context 的输入指纹，邻接文本、顺序或音色已改变则拒绝旧结果；不比较全局 revision，其他无关编辑不影响结果。

## 音频后处理的边界

v4 改用官方 `textToDialogue.convertWithTimestamps`。开启 trimTail 时，适配器验证字符对齐与当前正文匹配，确定最后实际发音字符的结束时间；保留 tailPaddingMs 余量，若检测到额外发音，余量不能越过其起点。默认保留 40ms，淡出 5ms，可在片段或时间线默认配置调整。

`AudioPostProcessor` 是宿主可替换接口，供应商只传字节、输出格式和已验证的发音边界。默认 `FfmpegAudioPostProcessor` 使用独立进程解码 PCM、按样本裁尾、仅在正文之后的余量淡出，并重新编码带 gapless 信息的 MP3。没有可靠对齐或音频无法解码时明确失败；不能删除固定数量的 MP3 字节、猜测截去最后一段时间或压低末字。关闭 trimTail 使用普通 Dialogue 接口。

后处理继承同一生成任务的 AbortSignal、总超时及产物归属守卫，限制输入和输出大小；处理完成才保存最终产物。临时输出使用宿主创建的独立临时目录。`ffmpeg-static` 在桌面构建中保持外部模块，并通过 asarUnpack 放置可执行文件；可执行文件路径不进入项目和 renderer。

接口依据：[ElevenLabs 模型目录](https://elevenlabs.io/docs/overview/models)、[Dialogue 字符时间戳与前后文](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)、[FFmpeg](https://ffmpeg.org/ffmpeg-filters.html)。这套处理减少已知的尾部多余发音，不能去除正文内部幻觉或未被对齐标识的抢读，也不意味着整条时间轴混音和合成播放已经完成。

## 设计哲学第 10 节评审

1. 对象为 Timeline 默认配置、Item 的生成输入及生成产物。左侧单击唯一进入配置，右键唯一刷新；删除原双击入口与 Item 详情的重复跳转。
2. 单击配置是用户要求的 P03 局部导航例外，记录为基线 1.4。其他对象的双击、右键和拖拽语义继续保持；刷新不借用新 Action 名称复制入口。
3. 参数只在详情中披露，嵌套对象仍使用所属窗口同一个 Modal path；统一像素组件与 12px 字体，无常驻配置面板。
4. 默认值、刷新、参数构造和生成捕获由后端共享规则处理；GUI 经同一 ActionExecutor。正式项目 CLI / Agent 适配器仍待接线，不把诊断 CLI 宣称为完整项目入口。
5. 项目权威状态仍只有后端一份。默认值与设置快照是序列化领域数据，邻接文本捕获是任务输入；UI 不自行维护可写片段数据库。
6. 插件只提供 defaultFields、schema、基础值及上下文能力。宿主负责字段控件、提交、导航与错误；音频处理器使用组合，不新增实体继承树。
7. 默认编辑保留原值，显式刷新才改变既有输入；实际变化更新 token，邻接上下文变化通过指纹拒绝旧结果。取消及超时覆盖后处理，旧媒体文件不立即删除，不自动重试收费请求。
8. 新扩展点对应实际发现的缺失能力，复用现有任务和 Action 边界；不新增调度框架或第二套状态系统。

## 验证与限制

相关核心测试覆盖默认值稀疏校验、创建继承、既有配置保留、显式刷新、设置快照兼容、真实素材保留、上下文边界及旧结果拒绝。SDK 测试使用真实 SDK 与模拟 HTTP，验证 Dialogue 字段映射、前后文不朗读、字符对齐、关闭裁尾和错误；音频测试使用合成 WAV 与真实 FFmpeg，验证裁切时长、MP3 解码、末字保护和取消。浏览器及原生桌面验证覆盖左侧单击、单 Modal 嵌套、字段持久化和右键刷新。

测试不发起付费模型请求，不能证明当前账户权限、余额和真实生成音质。完整时间轴混音、合成播放、项目撤销重做与插件版本迁移仍待实现，详见核心架构的当前状态表。

最终验证通过：`npm run typecheck`、115 项核心测试、14 项浏览器交互测试及 `npm run test:desktop`（含最新桌面构建与原生左侧单击入口）。原生截图测试使用隔离测试入口的软件合成，避开测试宿主 GPU 驱动的 UnknownVizError；生产窗口设置未改变。源码桌面已验证，Windows 安装器未重新打包，打包配置仅完成依赖及解包路径核对。
