# Pixel 组件库

导入 `web/ui/index.ts` 时加载统一 token 与组件样式，不依赖外部字体 CDN。

```tsx
import { PixelPanel, PixelField, PixelInput, PixelBadge } from './ui/index.js';

<PixelPanel title="对象详情" right={<PixelBadge tone="green">已就绪</PixelBadge>}>
  <PixelField label="名称" description="完成编辑后由宿主提交 Action">
    <PixelInput value={name} onChange={onLocalChange} onBlur={onCommit} />
  </PixelField>
</PixelPanel>
```

组件只表达视觉、键盘和焦点规则，业务提交由宿主 ActionClient 完成。`PixelField` 自动给直接的 Input / Textarea / Select 子节点绑定标签和帮助文本；复杂内容使用 `htmlFor` 与控件 `id` 显式绑定。`PixelProgress.value` 使用 `0..1`，会限制异常值。

所有文本角色使用唯一 `--pixel-font-size: 12px`，行高使用 `--pixel-line-height: 20px`。Title、Description、Body 通过颜色和上下文区分，插件不能另定字号。字体按原生像素尺寸渲染；不要在页面局部重新定义字体或复制另一套控件样式。字体来源、版本、完整许可见 [fonts/README.md](fonts/README.md)。

视觉采用暖白底、海军蓝文字、电粉 / 青 / 紫色状态和 4px 栅格。`PixelPanel` 为平面区域，只在标题处提供细分隔线，不画卡片外框；字段使用淡底和底线；`PixelBadge` 使用方形状态点，不增加胶囊外框。菜单和浏览器详情保留 4px 阶梯角、弱硬阴影及明确键盘焦点。`--pixel-pink`、`--pixel-cyan`、`--pixel-purple` 和对应 `-soft` token 由宿主共享；既有 green / amber / red 状态含义保持不变。

`PixelIcon` 是 16px 整数栅格上的直角 SVG，提供媒体、对象和导航图形。`PixelMark` 提供本地虹色像素 P 标记，接受 `className`、可选无障碍 `label` 和 `size`（默认 24）；图形缩放不改变全应用唯一字号。图标、状态点和品牌标记自身不新增业务入口。

`PixelContextMenu` 是右键命令临时入口，支持方向键、Home/End、Enter、Esc、Tab 关闭、点击外部关闭与视口边界限制。菜单项可以禁用并解释原因；没有常驻业务按钮。

`PixelWindowHost` 是主工作区与素材库的共同窗口外观，统一像素标题栏、窗口控件插槽和内容区。素材库根是独立非模态工作窗口，不创建详情 frame，不将主窗口设为 `inert`；两者读取同一后端只读投影，拥有各自的选择、导航和拖拽状态。

每个窗口由组合根渲染一个 `PixelModalHost`，仅承载对象详情。`open`、`title`、`description`、`depth` 和 `children` 必须由 `ModalNavigator` 顶部路径派生，`onBack` 弹出一层。浏览器默认模式提供单一 Dialog、焦点限制、背景 `inert`、滚动隔离及关闭后焦点恢复，不自行维护第二条导航路径。宿主仍应使用当前作用域验证菜单、字段和 drop；DOM 隔离不能替代 Action 权限与拖拽规则。

独立桌面详情窗口设置 `standalone`：Dialog 占满该窗口、不画遮幕和阴影、不将同窗口的组合根设为 `inert`；焦点限制、Esc 逐层返回和顶部作用域不变。主工作区的独立原生详情由桌面宿主隔离所属父窗口；库内详情在库 document 占满窗口，组合根显式只将库内容设为 `inert`，不隔离其他工作窗口。标题区域可拖动原生窗口；宿主通过 `windowControls` 插槽将原生控件放在标题栏内部，控件及子元素设置 `-webkit-app-region: no-drag`，避免被窗口拖动区域遮挡。插槽容器标记 `data-pixel-window-controls`，纳入独立窗口的键盘焦点范围。窗口控件仅管理窗口，不构成业务命令入口。

相关设计哲学评审结论：

- 对象详情仍由双击进入，命令仍来自右键，字段按宿主统一完成手势提交；组件库未增加同义入口。
- 每个窗口仅当前 Modal 内容可以交互，其他独立工作窗口仍可操作；菜单是当前上下文的临时披露，Esc 先关闭菜单，再逐层返回详情。
- 组件不修改项目、不调用模型 SDK、不持有凭证。插件只提供语义字段，宿主用相同组件渲染。
- 字号与视觉集中于 token 和组件样式；没有新增继承树、项目数据库或插件样式系统。
