# 共享项目管理、可编辑工程包与媒体恢复

基线 1.8，2026-10-10。产品规则以[设计哲学](design-philosophy.zh-CN.md)为准，具体契约及完成状态见[核心架构](core-architecture.zh-CN.md)。用户明确要求取消本地项目文件系统，将资源管理器升级为项目管理器，支持整项目/单时间线导出、媒体移动后的哈希恢复，并隔离项目文件与媒体；随后明确选择先导出可编辑工程包。

## 对象与固定入口

主工作区仍是 Viewer 与 Timeline。Viewer 右键 → 项目管理器替代原素材库入口，空预览和已有输出均可进入；项目标题详情不增加另一入口。管理器沿用共同 `DesktopWindowHost` / `PixelWindowHost`，是独立非模态工作窗口，内部 `library` 角色及浏览器 `?window=library` 是载体身份。对象详情只隔离所属窗口。

管理器直接显示共享项目列表、名称输入及“创建共享项目”“打开项目”“导入工程包”；当前项目区显示整项目导出、时间线选择/导出、媒体位置状态及“扫描哈希恢复媒体”。下方保留当前项目素材、原分组导航与操作、Asset 详情以及与主窗口的真实关系拖拽，不展示其他项目的素材作为当前项目 Asset。项目列表默认 20、最多 50 条，支持继续查询；打开和创建只在对应管理器控件执行。

工程包 picker 与系统 File 拖入共用一个可信导入服务，是 1.8 按用户要求登记的有限等价触发。`.pixel.zip` 拖入管理器项目列表只导入新项目，随后在列表明确打开；主窗口根接收工程包后导入并进入新项目。普通媒体拖入管理器当前素材区仍只导入可复用 Asset，拖入 Timeline 仍按原 `external.media → timeline.position` 放置，不把工程包当媒体、不猜测合并或替换。详情中的项目管理控件不可绕过顶部作用域。

## Seafile 作为项目及资源权威

生产宿主不再创建或更新本地 `project.json`、`jobs/` 或声纹操作账本。共享项目、生成任务、账户声纹操作、媒体及产物索引全部在 `.env` 绑定的 Seafile 资料库中；服务不可达或配置错误时明确失败，不回退本地。账户记录仍与项目编辑分开，保存于共享 operations 目录，并保持凭证作用域哈希和请求去重。

以默认 `SEAFILE_ROOT_PATH=/pixel` 为例：

| 位置 | 内容与权限边界 |
| --- | --- |
| `/pixel/projects/<projectId>/state/part-<shard>/<sequence>.json` | 项目快照、revision、成功请求回执、编辑历史及 outbox 的共同事务记录 |
| `/pixel/projects/<projectId>/jobs/<jobId>/part-<shard>/<sequence>.json` | 捕获请求、attempt、状态、providerTaskId 与产物关联；不进入项目撤销历史 |
| `/pixel/projects/<projectId>/lease/part-<shard>/<sequence>.json` | 当前编辑/生成宿主的共享租约 |
| `/pixel/operations/.../part-<shard>/<sequence>.json` | 独立账户操作及工程包导入等宿主命令的防重复记录 |
| `/pixel/media/<assetId>.<extension>` | 独立的真实媒体；项目编辑不内嵌字节或通过片段移动重写媒体 |
| `/pixel/artifacts/<assetId>.json` | Asset/fileRef、job 归属、格式、大小、对象版本及 SHA256 的 canonical 索引 |
| `/pixel/locations/<assetId>/part-<shard>/<sequence>.json` | 移动后经内容核验的定位覆盖；不改变 Asset 身份或项目引用 |

`ProjectDocument` 保留浅层 JSON 契约，媒体关系仍是 Asset ID 与 `pixel-asset:<UUID>`。项目文档与媒体的“隔离”指持久化目录、生命周期及权威职责分开，工程包中也分目录；不表示要新增第二份资产数据库。项目 metadata 可以保留内容摘要等语义信息，具体可变位置由存储适配器的 canonical 索引与 locations 解析。

`WorkbenchRepository` 是工作台需要的持久化接口；`DurableWorkbenchRepository` 统一实现 revision、幂等、历史与 outbox 提交，文件与 Seafile 适配器仅提供读取/发布方式。生产使用 `SharedProjectCatalog` 和 `SharedJobRepository`；`GenerationRunner` 依赖 `JobRepository` 接口，不绑定 `FileJobRepository`。File 适配器仅保留隔离测试和旧项目只读迁移用途，不成为共享失败后的备用写入路径。

本机保留的是应用配置（包括最近共享项目 ID）、有限 FFmpeg 临时输入及导出临时副本。用户明确导出的 `.pixel.zip` 是便携数据包，不会成为正在编辑的本地项目存储；原生 Viewer 拖出仍下载校验后的单媒体临时副本。项目 `.env`、供应商凭证、Cookie、token 和临时下载 URL 不写入共享项目或工程包。

## 发布竞争、租约与生成恢复

`SharedVersionedDocument` 每 1000 条放入一个 part-000000000 等分片，使用补零的不可变版本槽位，如 `000000000000.json`。每条版本带唯一 `publicationId`、sequence、前一版本内容摘要及已校验 value；读取检查分片编号、最新分片连续性及前后记录关系。提交先比较捕获版本，再调用 Seafile `replace=0` create-only 上传，只有返回原定文件名的 publication 成为权威版本。竞争者被服务重命名后不能进入有效版本链，也不能把相同内容误认作自己提交成功；网络响应丢失时仅在已保存的整个 publication 与本次记录一致时接受成功。

这不是先读后覆盖的伪 CAS。依据官方服务端 [post_files_and_gen_commit 实现](https://github.com/haiwen/seafile-server/blob/master/server/repo-op.c)，不覆盖上传在并发提交重试时通过唯一文件名处理竞争；宿主必须核对最终文件名和 publication 身份。适配器仍采用官方 REST，[seafile-js](https://github.com/haiwen/seafile-js) 已归档，不能为了复用归档 SDK 丢掉当前所需的发布约束。共享 JSON 单条最多 16 MiB；不可变版本保留及未成为权威的重命名记录尚未提供自动压缩/回收。

`SharedProjectLease` 限定同一项目只有一个活跃编辑/生成宿主，租期 120 秒、每 20 秒续租。一个宿主的主窗口与管理器并行读取/编辑同一 Workbench，团队可同时打开不同项目；明确打开尚未释放的项目会得到占用提示。默认启动在最多 20 个候选中选择可获取租约的项目，没有可用候选则创建空共享项目；记忆项目不存在或被占用时回到默认选择，仍可进入管理器。租约失效时停止工作台，持久化发布和模型调用前重新检查资格；关闭等待任务中断记录和租约释放。崩溃后可在租约过期后重新进入，不宣称实时多人同项目编辑、自动合并或零时钟偏差的分布式调度。

项目 token、成功回执、history 和 outbox 在同一版本提交；生成 ledger 由持久化 outbox 消费，job 更新继续通过 attempt/state guard 和共享版本竞争保护。实际调用 SDK 前复核 Item token，过期排队任务不收费调用；结果仍通过内部 `generation.apply` 校验输入与产物归属。Wan 保存远端任务 ID 后轮询，interrupted 由用户显式恢复，不盲目重新 POST。读取或导入工程包不会恢复旧任务、重放旧请求或启动模型调用。

## 可编辑整项目与时间线工程包

工程包使用 `.pixel.zip`，通过 `fflate` 标准 ZIP 实现；结构如下：

```text
manifest.json
project/project.json
media/<assetId>.png|jpg|webp|mp3|wav|mp4
```

`manifest.json` 记录格式版本、project/timeline 范围、源项目 ID/revision、可选 timelineId，以及每份媒体的 Asset ID、job 归属、相对路径、字节数与 SHA256。项目文档不嵌媒体字节，移除具体 Seafile storage locator；每份媒体读回并校验后才入包。导出捕获一份项目状态，不修改 revision 或启动生成。

整个项目包含当前快照、编辑历史及其引用的全部媒体，保留组与轨道顺序；不携带成功请求缓存、可执行 outbox、租约或任务 ledger，因此是可编辑便携包，不是可直接接管正在运行生成的宿主备份。媒体缺失或内容核验失败时导出明确失败，提示先恢复，不悄悄制作缺文件的“完整项目”。

单时间线工程包使用原 `TimelineData`，保持 ticksPerSecond、settings、itemDefaults、Item 整数时间/偏移、参数、生成设置及引用/输出关系。它只包含选中轨道、所属 Item 与必要媒体，保留对应素材分组成员，移除跨项目编辑历史；不另建一份时间线序列化模型、不混入其他轨道。用户确认本轮只交付可编辑包；Remotion 多轨实时预览与工程包能力不表示已实现 MP4/WAV 成片导出。

工程包仅接受自身生成的 ZIP32 存储条目，拒绝 ZIP64、DEFLATE、加密及其他压缩方式；单包 ZIP 与解压总量均最多 256 MiB，项目 JSON 最多 16 MiB，媒体清单最多 10,000 份；超过上限时可分时间线导出。导入先检查中央/本地记录、范围和描述符，再检查大小、严格清单、媒体签名、重复/越界 ZIP 路径、项目不变量、插件 schema、全部媒体字节数及 SHA256，再保存媒体、发布新共享项目。包中多余文件、重复路径、任意本机路径、未知媒体格式、可执行 outbox 或请求缓存被拒绝。

导入保留 Asset/Timeline/Item 等对象 ID 和内容身份，创建新的 Project ID，将 revision 设为零并给 Item 更换 generationToken；即使原项目仍存在，也不覆盖或合并它。原工程包不改写，出错保留当前项目。验证前不发布项目，验证后媒体上传成功但项目发布失败可能留下未关联 artifact，其回收是后续存储能力。

## 缺失媒体及按内容恢复

共享项目打开先校验完整状态、history、插件和任务契约；媒体移动或缺失不再使整个合法项目无法进入。管理器媒体状态检查当前和历史使用的媒体，未找到的 Asset 保留原 ID、片段区间、引用和参数，显示需要恢复。不可达、权限或结构错误仍明确报错；不拿保留的本地原文件伪装共享读取成功。

用户点击“扫描哈希恢复媒体”后，只扫描当前 `.env` 绑定的 Seafile 资料库，不访问其他库、本机目录或 metadata 中任意 URL。先用已登记 artifact 的字节数筛选候选，再下载候选实际内容计算 SHA256；只有摘要与原内容身份一致才发布 locations 覆盖，并重新验证读取。它不靠文件名/扩展名猜引用，不自动把同库陌生文件登记为素材，不改项目 revision、Item 关系或生成输入。相同内容有多个位置时采用确定顺序的已核验候选，返回扫描、恢复和仍缺失的数量。

扫描具有取消、请求超时与有界读取；单次最多遍历 10,000 个目录、50,000 个文件，超过上限提示整理目录后再试。原始 canonical artifact 索引仍需存在且合法，索引本身缺失/被篡改或项目摘要与索引不符时不能仅凭文件名重建身份。找不到内容时保留缺失状态，不删除对象。已找到位置通过独立 ledger 持久化，另一个宿主及下次打开继续按同一 Asset 句柄解析。

## 旧项目迁移与会话边界

旧 project.json、history、请求记录、outbox、任务和受控 artifacts 是只读迁移输入。importLegacyProject 按可信真实源路径及完整项目/任务摘要持久映射新共享 Project UUID，保持 Timeline/Item/Asset、媒体句柄和历史；相同源状态重用目的 ID，不因旧默认 ID 相同覆盖其他项目。清请求回执/outbox，旧 queued/running/cancelRequested 转 interrupted，保留 providerTaskId 及参考角色、重算项目归属和指纹，只允许显式恢复，不自动生成。终态和原 interrupted 任务保留，旧声纹操作账本一并共享迁移；原文件全部保留，不在原目录继续保存。这不是插件 schema 迁移器。

真正的空文件夹拖入桌面时只提供共享项目名称，不创建本地 `project.json`。浏览器可上传工程包字节，旧目录迁移及共享项目会话切换使用桌面可信宿主；开发版尚未提供同一页面切换共享运行时，明确提示使用桌面版。

共享项目打开按 Project ID 交给可信宿主，不由 renderer 修改旧快照伪造切换。成功切换撤销旧跨窗口对象会话、导出票据，关闭旧详情/管理器并绑定新的 loopback origin 与 Cookie；失败恢复原运行时。旧请求仍属于旧会话，不能晚到编辑新项目。最近记录只保存共享 Project ID；原目录记录只作一次旧项目迁移依据，模型及 Seafile 配置始终从应用 `.env` 读取。

## 设计哲学第 10 节评审

1. 对象与唯一入口：Project 目录管理、整项目/单轨可编辑数据包及既有 Asset 定位恢复集中于项目管理器的固定控件。Viewer 右键仍是管理器唯一导航；工程包 picker/drop 的有限等价触发明确记录。Viewer 单媒体拖出与工程包导出对象和结果不同。
2. 手势语义：系统 File 按工程包、旧容器、普通媒体及固定目标区分；不弹出合并/引用/替换选择，拖拽 token 仍只能表达同项目既有对象关系。空目录不再获得持续保存权，这是用户取消本地项目系统的明确基线覆盖。
3. 上下文与隔离：项目列表、媒体状态、导出范围及恢复反馈只在管理器出现；非模态并行和各窗口局部详情隔离沿用同一宿主，主工作区不新增全局工具栏。
4. 业务入口：领域编辑继续走 Workbench/ActionExecutor；项目目录、包与恢复使用可信共享宿主服务并复用项目/插件/媒体校验，renderer 不能写 Seafile。正式项目 CLI/Agent 编辑仍待实现，诊断 CLI 不冒充项目 Action。
5. 权威状态：Seafile 承载唯一生产项目及资源，DurableWorkbenchRepository 共用事务语义；窗口投影、目录筛选、预览、最近 ID 和临时文件不成为第二份可写项目。媒体 locator 与项目对象关系分开。
6. 插件与时间线：单轨包直接裁取原 Timeline/Item 契约与时钟，组及能力来自共同数据/声明；项目管理器复用像素字号和窗口宿主，不为每个模型发明导出格式。
7. 并发及异步意图：唯一 publication、版本 guard 与单宿主租约保护竞争；job attempt/token/指纹继续保护晚到结果。导入重置项目身份与 token、清除可执行记录，哈希恢复核验真实内容；失败保留原件和当前会话，不声称同项目实时多人合并。
8. 复杂度取舍：增加实际需要的持久化端口、共享版本/租约、ZIP 服务与位置覆盖；复用 Seafile、既有领域校验、Timeline 基类和窗口宿主，没有另造本地文件系统、另一份项目状态或离线渲染器。

## 验证状态及后续边界

本轮类型检查与完整 265 项核心测试通过，桌面构建/原生回归通过。浏览器完整运行 38 项通过，剩余一项的旧预览缓存断言修正后定向复验 1 项通过；不把定向复验称为完整套件再次运行。SDK及声纹常规测试使用模拟HTTP，无收费生成。

真实 Seafile 小型独立 fixture 已验证范围端口监听、远程项目/媒体保存、工程包导出/导入请求重放、并发 publication 仅一 winner、真实媒体 move+rename 后 SHA256 恢复保持 Asset UUID及项目 revision、关闭后立即重开，并确认本地来源目录未变为持续存储。真实原生 Electron 共享验证还覆盖项目管理器创建/打开的动态 ID/origin、重开、整包和纯文本单轨下载完成并 decode 核对时间3500、正文和历史，导出不改源 revision、本地无project.json且监听在范围内。本轮发布的独立验证项目、媒体及临时配置 profile 已按 fixture 边界清理；服务ACL未改，未验证实时多人合并。

桌面统一读取 FIREWALL_OPEN_PORT_RANGE 与 PORT_RANGE_START/END 的12000–12100监听范围，仅loopback，不新增网页部署服务，不改出站Seafile/OpenRouter/ElevenLabs URL。租约续租/watchdog在Workbench.initialize消费outbox前启动，每秒检查已确认到期，生成收费调用前再检查授权。Seafile返回旧内部文件origin时，通过SEAFILE_FILE_SERVER_URL显式映射到外部可达入口，仅映射已配置来源或API同hostname；文件服务不接收账户token，其他origin仍须allowlist。

正式项目 CLI/Agent 编辑、共享 Action 能力查询、完整撤销重做、插件版本迁移及缺失插件占位、项目版本记录压缩/资源回收、同项目实时多人编辑、离线混音和成片合成导出仍待实现。单编辑宿主与团队共享不同项目、编辑数据包导出及按哈希恢复不应替代这些能力的真实交付。
