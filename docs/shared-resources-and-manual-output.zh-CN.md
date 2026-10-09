# 共享资源与人工输出

基线 1.7，2026-10-10。产品依据是[设计哲学](design-philosophy.zh-CN.md)，共同契约见[核心架构](core-architecture.zh-CN.md)。本轮对应用户指出的满屏时间线失去创建入口、普通视频缺少右键添加、人工或网页视频结果上传，以及团队统一 Seafile 资源存储。

## 对象、入口与业务语义

主 Timeline 区域右键的“新建时间线”同时适用于空白、已有轨道标签、轨道内容及 Item。它仍是一个 `timeline.create` 命令和相同的有界类型子菜单，只创建空轨道；详情隔离范围内不新增根层命令。

普通视频、音频和图片轨右键可选择“上传并添加媒体”，对应 MP4、MP3/WAV、PNG/JPEG/WebP，单文件不超过 256 MiB。点击时间位置决定放置位置；左侧标签从零开始。文件选择取消不创建对象。选择结果和系统拖入共用 `placeFileAtTarget()`、原 DragRegistry 的 `external.media → timeline.position` 及受信 `media.placeExternal`：类型、当前对象、作用域、revision、真实内容和时长均复核，素材与片段共同提交。按用户要求，这是严格单 GUI 入口规则的有限例外，不能靠另一 Action 名称掩盖，也不推广为其他能力的多入口。

视频生成 Item 的详情直接显示“上传生成结果”：选择人工上传或外部网页生成来源，再上传一个不超过 256 MiB 的 MP4。外部网页流程是用户在所用网站生成、下载 MP4，然后回到此处上传；软件不自动打开供应商会话、不远程抓取视频，也不隐式调用收费生成 API。该控件由 `capabilities.manualOutput` 及 `supportedActions` 声明驱动，不按模型名称分支。普通媒体轨没有该能力，输入参考的上传保持原来的独立区域和含义。

## 人工输出与异步意图

`HttpDesktopBridge.importOutputFile()` 经 `/api/media-output` 将真实字节交给 `Workbench.importOutputMedia()`。同一个可信媒体事务先检查目标、能力、MIME/内容、FFmpeg 解码及时长，再保存资源，最后通过内部 `media.outputExternal` 原子登记 Asset、挂载输出、旋转 generationToken 并追加相关取消 outbox。renderer 不能自行提交该内部 Action、指定文件路径或指定要取消的任务。

Item 的 `outputOrigin='manual'`，Asset 的 `metadata.outputProvenance` 是 `manual` 或 `external`。提示词、模型、生成配置、起点和引用保留；sourceOffsetTicks 重置为零，编辑时长取原区间与新源时长的较小值。长视频不推开后续片段，用户可继续调整边缘。参数编辑和刷新默认值保留人工输出；显式发起新生成并成功挂载时，才成为新的 generated 输出。

字节、目标、来源及 revision 参与幂等指纹；相同请求重放返回原回执，错参重用被拒绝。revision 冲突或校验失败不会取消原任务。取消出站命令与挂载同事务持久化；排队任务在调用 provider 前再检查 token，已运行任务收到取消信号，过期回调不挂载。供应商实际停止和退款不由本地取消承诺。产物与历史中的前后挂载快照保留，解除关联不删除文件；当前实际 Undo/Redo 用户入口仍待实现。

## Seafile 权威资源存储

`MediaArtifactStore` 组合 ArtifactStore、MediaReader、stat 和 readRange。项目核心及 GenerationRunner 只使用该端口；模型 adapter 无法选择任意文件路径或带凭证 URL。生产桌面、开发服务和诊断生成 CLI 统一创建 `SeafileArtifactStore`，没有本地资源回退。`FileArtifactStore` 保留为显式测试适配器及旧资源迁移读取器。

Seafile 库默认名称为 Pixel，目录为 `/pixel/media` 与 `/pixel/artifacts`；可通过 `SEAFILE_REPO_ID` 和 `SEAFILE_ROOT_PATH` 固定共享位置。服务地址和端口、账号或 token、受允许的文件服务 origin、超时及大小限制均从可信应用 `.env` 读取，拖入的项目目录不能提供凭证。当前 `.env` 已绑定专用库的稳定 ID；不在文档、日志、项目或 renderer 保存账号密码、token 或临时下载链接。不自动公开资料库或修改分享 ACL，团队成员须使用同一库及已有 Seafile 权限。

媒体 UUID 及 `pixel-asset:<UUID>` 保持不变。媒体上传确认大小及对象 ID后，再发布 artifact JSON；索引绑定配置中的库、固定 UUID 路径、种类、格式、大小、对象 ID和 SHA256。完整读取验证摘要，范围读取核对对象版本和 Content-Range。下载地址仅接受配置允许的 origin，账号凭证不转发给文件服务，renderer 只通过经认证的 loopback `/api/media/:id` 代理预览。写失败不会发布项目 Asset；中途留下未关联 blob 时，同 UUID 重试必须完整核验后复用，内容冲突拒绝覆盖。

使用官方 REST 协议而非新增通用文件系统框架。官方 [seafile-js](https://github.com/haiwen/seafile-js) 已归档；小型宿主适配器覆盖当前所需的身份、资料库、目录、上传、索引和范围读取，并保留取消、超时、上限与脱敏边界。协议来源是官方[上传 API](https://cloud.seafile.com/published/web-api/v2.1/file-upload.md)与[文件 API](https://cloud.seafile.com/published/web-api/v2.1/file.md)。

## 项目状态、旧媒体与原生导出

本地 `project.json`、撤销历史、幂等回执、生成任务和声纹操作账本继续表示编辑状态与宿主恢复记录。Seafile 管理实际媒体及 artifact 索引。这不等于已实现多人并发项目编辑，也不自动把同库全部文件变成当前项目的素材列表；项目和分组中的 Asset 关系仍由权威 Action 提交。

启动及可信项目打开先验证项目结构，再迁移旧受控目录中的 UUID 索引和媒体。迁移保留 artifact/job/Asset ID、fileRef、当前项目和历史；校验上传后不删除旧文件，不改写项目 revision。已迁移资源后续只以 Seafile 为权威，不依赖保留的本地副本。正常重开校验当前、历史、outbox 参考与任务产物的共享索引及文件；共享库不通或资源冲突时明确失败，不读取旧文件来伪装共享成功。

Electron `startDrag` 需要真实本机文件。`TemporaryMediaExports` 从同一媒体端口下载并核对真实内容，在系统临时目录创建受控 `pixel-export-*` 会话副本。它不改变 Asset 的 fileRef、项目或共享库，不构成本地素材库；关闭项目/应用会取消待处理准备并清理本次目录。原生导出票据继续绑定可信窗口、当前 Asset、有效期及单次消费。多层画面合成导出仍待实现。

## 设计哲学第 10 节评审

1. 对象与入口：创建针对 Project 的轨道集合，在主 Timeline 上下文执行同一命令；媒体 picker 是已登记的有限例外；人工输出仅在具有声明的视频生成 Item 详情上传。引用、生成和导出不增加同义入口。
2. 手势稳定：右键发现命令，File 选择与 drop 只导入并放置，人工上传只挂载输出；不会弹出“引用还是替换”，也不把普通轨伪装为生成草稿。
3. 上下文及隔离：输入限制和来源说明直接在所属对象显示；根创建不进入详情背景，窗口隔离与并行库保持不变。
4. 标准业务入口：GUI、未来 CLI/Agent 均须经相同可信媒体适配器和 Action 校验；renderer 不能直接写 Seafile。诊断生成 CLI 不冒充项目编辑入口。
5. 权威状态：Project 仍只有一份后端编辑状态，Seafile 只承载权威资源，预览、选文件与临时导出不创造第二份可写项目。
6. 插件与宿主：人工上传由共同能力声明、宿主组件、像素字体及文件适配器实现，不为 Wan 建第二套界面或存储。
7. 异步意图：挂载与 token 失效、取消出站记录原子提交；旧任务、冲突请求、会话关闭及上传失败不覆盖当前结果。完整解码、范围校验及 SHA256 守卫共享资源边界。
8. 复杂度取舍：只增加实际需要的媒体存储端口、Seafile adapter 与原生临时导出服务；没有另造文件管理框架、团队项目数据库或供应商网页登录自动化。

## 本轮验证

本轮 `npm run typecheck`、218 项核心测试、36 项浏览器交互测试、`npm run test:desktop` 与桌面构建通过。核心覆盖人工结果、晚到/排队任务、幂等和 revision 竞争、Seafile 上传取消与索引发布、旧句柄迁移、远程项目重开及临时导出；浏览器覆盖满轨创建、三种普通媒体 picker 和两种人工结果来源；原生覆盖独立窗口、真正目标命中、双向放置/引用/复用、切换重开和真实鼠标文件拖出。原生系统输入仍使用真实磁盘 File 加 Chromium/CDP 投放，不宣称完成 Windows Explorer 与外部应用之间全程屏幕坐标拖动的自动化。

已完成配置账号真实登录、专用 Pixel 库创建、68 字节 PNG 上传/读回、stat、Range、fresh-store 索引读取及按 job 查找；生产宿主使用当前 `.env` 接入共享库、读取空项目投影并确认没有本地媒体目录。远端验证 fixture 已清理，库与目录保留，ACL 未改。常规核心、浏览器与原生回归使用显式隔离测试适配器；原生测试在双重测试标志下按目标项目注入测试目录，生产始终共用 Seafile 资源库。模型生成与声纹调用继续使用模拟测试，不进行付费生成。旧轮 1.6 数字仅作为历史记录。
