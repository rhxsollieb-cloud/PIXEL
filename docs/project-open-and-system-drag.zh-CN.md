# 共享项目输入、会话切换与系统拖拽

更新日期：2026-10-10。当前遵循[设计哲学1.8](design-philosophy.zh-CN.md)及[核心架构](core-architecture.zh-CN.md)。1.8按用户明确要求取消本地项目文件系统；旧1.4–1.7的“原目录持续保存”和“空目录补写项目”已被只读迁移替代。当前项目管理、工程包和恢复规范见[共享项目管理与工程包](shared-project-manager-and-packages.zh-CN.md)。

## 对象与固定入口

Viewer 右键 → 项目管理器是唯一管理导航，空预览和已有输出均可。管理器为共同窗口宿主的非模态工作窗口，显示共享项目列表、名称创建、打开、导入、整项目/单轨导出和哈希恢复，保留当前素材/分组及跨窗口关系。项目打开通过可信宿主按共享Project ID切换运行时，不由前端编辑旧快照伪造。

| 输入 | 结果 | 原件及执行边界 |
| --- | --- | --- |
| 共享项目列表“打开项目” | 校验共享状态，获取单宿主lease后进入 | 不复制为本地可写项目，不允许其他活跃宿主覆盖 |
| 名称表单“创建共享项目” | 新建空Seafile项目，在列表打开 | 没有示例时间线/片段/素材，没有本地project.json |
| .pixel.zip通过管理器picker或项目列表drop | 同一服务校验媒体/清单后导入新共享ID | 保留包，清可执行记录，不合并也不启动生成，随后明确打开 |
| .pixel.zip拖入桌面主窗口根 | 同一导入后进入新共享项目 | picker/drop有限等价触发，按固定来源和目标判断 |
| 旧Pixel目录或project.json拖入桌面主窗口 | 只读迁移到新共享项目后进入 | 源路径及完整项目/任务摘要映射目的UUID；保留原件，不再保存原目录 |
| 真正空文件夹拖入桌面主窗口 | 用目录名称创建空共享项目 | 不在空目录创建project.json，不授予持续存储权 |
| 普通非空目录、未知/空文件、结构/插件版本无效项目 | 明确拒绝并保留当前会话 | 不猜测素材合并、不覆盖原文件 |

浏览器源码调试可按字节导入工程包，不能获得可信本机目录位置。旧目录迁移和共享会话切换由桌面宿主处理，调试界面明确说明边界；不新增Pixel网页部署服务。详情仍隔离所属窗口，文件drop不能越过顶部作用域。

## 严格校验及只读迁移

旧持久化信封包括version、snapshot、requests、history及outbox；固定文件及任务读取共用validateWorkbenchProjectFile和插件/模型registry，真实路径与旧artifacts限制在来源容器，不读取其中.env或任意URL。新项目权威状态使用DurableWorkbenchRepository共同事务和Seafile不可变版本；File适配器只供测试与旧读取。

importLegacyProject先校验旧文件与jobs，再按真实来源路径和完整项目/任务摘要创建持久迁移claim，映射新的共享Project UUID。不同路径或不同完整状态不能因旧default ID同名覆盖其他共享项目。Item/Asset/时间线ID、fileRef、历史和媒体内容保留；canonical媒体摘要由Seafile补齐，原文件不删除。重复同源同状态迁移复用原目的项目。

旧请求缓存和outbox清空；queued/running/cancelRequested转interrupted，保留远端providerTaskId并更新项目归属/输入指纹，不自动重放收费。原参考角色（如Wan first-frame）保留；没有可恢复远端ID时不能盲目重提。终态job和已中断job保留，旧声纹operation账本也迁入共享operations，仍独立于项目撤销历史。这不等于宿主/插件schema迁移器，未知版本保留源文件并拒绝。

工程包通过fflate ZIP32，限定manifest.json、project/project.json、UUID媒体路径；核验清单/字节数/SHA256及项目schema，拒绝重复/越界路径、ZIP64/DEFLATE、额外文件和可执行记录。ZIP和解压总量上限256MiB，文档16MiB，清单1万媒体。导入新Project ID/revision0/生成token，不带任务执行或收费副作用。

合法共享项目即使媒体移动或缺失仍可进入管理器，保留对象供扫描恢复。恢复只扫描配置库，先大小后完整内容SHA256，以独立locations ledger更新定位，不改AssetID或revision；索引损坏、配置/权限/服务故障明确报错，不回退本地。扫描上限1万目录/5万文件，未找到保留缺失状态。

## 拖拽适配边界

| 来源 → 目标 | 可信适配及结果 | 边界 |
| --- | --- | --- |
| 工程包 → 管理器项目列表/主窗口根 | 共同工程包导入服务，主窗口后续打开 | 数据包不是Asset，不运行旧生成 |
| 旧项目File/目录 → 主窗口根 | preload实际File路径 → 固定IPC → 只读迁移 → 共享会话 | 不能从renderer传任意路径，原件不持续保存 |
| 系统媒体 → 管理器当前素材区 | HTTP真实字节 → asset.import | 当前项目素材，目录不当文件上传 |
| 系统媒体 → 普通Timeline/空白 | external.media → 原DragRegistry → media.placeExternal | 原子导入放置，不猜引用/替换，不切项目 |
| 当前Asset/Item → 另一工作窗口合法目标 | 不透明token → ObjectDragBroker → 原DragRegistry/Action | 同项目真实放置/引用/复用，作用域与单次消费校验 |
| Viewer当前单媒体 → 外部窗口 | Seafile核验 → 临时副本 → ExportTicket → startDrag | 真实单媒体，不冒充多轨成片；关闭清理 |

capture判别系统Files与对象MIME，防止对象handler抢占工程包或浏览器导航。桌面preload只接收实际drop的File，webUtils.getPathForFile取可信宿主路径；JS构造File/字符串不授权访问。主进程检查sender/窗口/项目作用域，原生票据仍绑定可信窗口、资产、有效期及单次消费，不给renderer任意文件系统API。

## 会话、端口及晚到请求

共享项目state、history/receipts/outbox、jobs与声纹operation都在Seafile；本机last-project.json只记最近共享ID，旧version1目录记录仅作只读迁移输入。源码.env来自应用目录，打包版来自应用数据目录，项目不能覆盖凭证。

桌面服务监听统一在FIREWALL_OPEN_PORT_RANGE=12000-12100、PORT_RANGE_START=12000、PORT_RANGE_END=12100分配；指定越界端口在存储/SDK初始化前拒绝，范围用尽明确失败。仍只绑定loopback并校验origin/Cookie，没有新增网页部署服务，不更改出站供应商URL。Seafile文件下载/上传入口可用SEAFILE_FILE_SERVER_URL显式映射旧内部origin，仅接受已配置来源或API同hostname，文件服务不接账户token。

SharedProjectLease为每项目一个编辑/生成宿主，120秒期限、20秒续租；在Workbench.initialize消费outbox前启动续租/过期守卫，每秒检查本机已确认到期并close/abort，付费调用前再检查lease。一个宿主多个非模态窗口并行，团队可同时编辑不同项目，不宣称同项目实时多人自动合并。初始化失败清同一管线并释放lease，退出等待任务中断/持久化后释放。

切换先准备新运行时，再撤销旧broker/导出票据、关闭详情与管理器，将主窗口导航到新的范围内loopback origin和Cookie；导航失败恢复旧运行时，成功后关闭旧Workbench/server/连接并释放旧lease。GET /api/session动态身份重建前端投影/导航/字段/播放局部状态，旧请求仍去旧会话，不能借晚到结果编辑新项目。文件上传与导出准备继承session关闭守卫。

## 设计哲学第10节评审与验证

对象是共享Project、可编辑包及既有Asset定位；管理器固定控件与Viewer导航登记单路径，文件导入等价触发有限记录。旧原位置打开改为只读迁移，是明确用户要求的1.8覆盖；普通媒体/对象关系不改变含义。非模态窗口及所属详情隔离保持，GUI编辑仍共用Action，目录/包/恢复服务复用领域校验。项目权威只在Seafile，recent ID与临时副本不是第二份状态；publication、lease、attempt/token及独立origin保护竞争/取消/晚到请求。包复用Timeline时钟，不新增渲染器或本地文件系统，完整§10评审见[1.8专文](shared-project-manager-and-packages.zh-CN.md)。

1.8真实Seafile与原生共享项目验证已通过：范围端口、创建/打开/重开、并发publication单winner、整包导入重复请求、真实move/rename后的SHA256恢复，以及整包/文本单轨原生下载解码，确认原revision、时间/正文/历史和本地无project.json；独立fixture清理。类型/核心/UI/原生精确记录见[当前验证](shared-project-manager-and-packages.zh-CN.md)。1.4阶段129核心/17浏览器、1.5阶段152/19及1.7阶段218/36仅历史证据，不能冒充新功能验证。

原生系统输入自动化使用真实磁盘File加Chromium/CDP投放，Viewer由真实鼠标触发startDrag；不宣称已自动化Windows Explorer与任意外部应用的完整屏幕坐标拖拽。模型/声音回归使用模拟服务，未付费生成，本轮源码构建而未重新打包。正式项目CLI/Agent编辑、插件迁移/缺失插件占位、完整undo/redo、实时多人合并和离线成片合成仍待实现。
