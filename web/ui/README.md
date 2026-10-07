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

所有文本角色使用唯一 `--pixel-font-size: 12px`，行高使用 `--pixel-line-height: 20px`。Title、Description、Body 通过颜色和上下文区分，插件不能另定字号。4px 栅格、直角、有限颜色、硬阴影和明显焦点由组件库统一提供；不要在页面局部重新定义字体或复制另一套控件样式。字体来源、版本、完整许可见 [fonts/README.md](fonts/README.md)。

`PixelContextMenu` 是右键命令临时入口，支持方向键、Home/End、Enter、Esc、Tab 关闭、点击外部关闭与视口边界限制。菜单项可以禁用并解释原因；没有常驻业务按钮。

每个窗口由组合根渲染一个 `PixelModalHost`。`open`、`title`、`description`、`depth` 和 `children` 必须由 `ModalNavigator` 顶部路径派生，`onBack` 弹出一层。组件提供单一 Dialog、焦点限制、背景 `inert`、滚动隔离及关闭后焦点恢复，不自行维护第二条导航路径。宿主仍应使用当前作用域验证菜单、字段和 drop；DOM 隔离不能替代 Action 权限与拖拽规则。

相关设计哲学评审结论：

- 对象详情仍由双击进入，命令仍来自右键，字段按宿主统一完成手势提交；组件库未增加同义入口。
- 只有当前 Modal 内容可以交互；菜单是当前上下文的临时披露，Esc 先关闭菜单，再逐层返回详情。
- 组件不修改项目、不调用模型 SDK、不持有凭证。插件只提供语义字段，宿主用相同组件渲染。
- 字号与视觉集中于 token 和组件样式；没有新增继承树、项目数据库或插件样式系统。
