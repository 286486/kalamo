# Zibel

浏览器里的矢量绘图工具。文档模型为 AI Agent 通过 MCP 读写而设计，人类用户在同一份文档上用 Illustrator 风格的画布编辑。术语以 Adobe Illustrator 的用法为准，Illustrator 没有的概念才自造。

## 文档结构

**Document（文档）**：
一份独立的矢量作品，由 Artboard 集合、Node 树和 Asset 库组成。一个 Document 对应一个文件。
_Avoid_: File、Project、Canvas

**Artboard（画板）**：
Document 中的一块矩形区域，是导出、对齐和渲染范围的边界。Artboard 不是 Node，不能作为任何 Node 的父级。
_Avoid_: Page、Frame、Canvas

**Node（节点）**：
Document 中任何可寻址的图稿对象，有稳定 ID 与父级。Layer、Group、Path、Text 等都是 Node。
_Avoid_: Element、Object、Item、Shape（泛指时）

**Layer（图层）**：
组织图稿的容器 Node，带颜色、锁定、模板等管理属性。Layer 的父级只能是 Document 根或另一个 Layer；Group 不能包含 Layer。
_Avoid_: Folder、Sublayer 作为独立类型（嵌套 Layer 就叫 Layer）

**Template Layer（模板图层）**：
放参考图供描摹的 Layer，对应 Illustrator 置入时勾选 Template：`image_place` 的 `asTemplate` 在父级所在 Layer 下方新建一个锁定的 Layer，名为 `Template <文件名>`，其中的 Image 不透明度 50%。Illustrator 的模板图层不打印；Zibel 的 Layer 还没有 `template` 标志，所以它照常导出与渲染（ADR-0027）。
_Avoid_: Reference layer、Trace layer、Background layer

**Group（编组）**：
把若干 Node 合为一个整体的容器 Node，本身是图稿的一部分，可出现在 Layer 或其他 Group 内。
_Avoid_: Container、Frame

**Selection（选区）**：
人类用户在 UI 中当前选中的 Node 集合。它是 UI 便利，不是文档状态；Agent 操作以显式 Node ID 为准。
_Avoid_: 把 Selection 作为工具调用的隐式参数

**Isolation Mode（隔离模式）**：
只编辑一个 Group（含 Clip Group）、子 Layer 或单个 Live Shape / Path 的状态，对应 Illustrator 的 Isolation Mode：双击 Group 或路径进入，子 Layer 从 Layers 面板底部的 Enter Isolation Mode 进入，顶层 Layer 不能隔离。画布的点选、框选、Select All 与新绘图稿都限于被隔离的 Node 内，其余图稿淡化且不可选，Layers 面板只列出它；Esc 或面包屑逐级退出，其上的每个 Group 与子 Layer 各是一级。它与 Selection 一样是每个 Document Tab 的浏览器状态，不写入 Document，MCP 不感知（ADR-0057、ADR-0058）。
_Avoid_: Focus mode、Edit mode、Enter group

**Auto-name（自动名称）**：
`name` 为空的 Node 在 Layers 面板中显示的名称，如 `<Rectangle>`、`<Path>`、`<Group>`、`<Image>`；Text Node 取其内容。只用于显示，不写入 Document。
_Avoid_: Default name、Placeholder name

## 几何

**Path（路径）**：
由 Anchor 与 Handle 定义的贝塞尔曲线 Node，可开放或闭合。
_Avoid_: Shape（泛指时）、Curve、Polyline

**Anchor（锚点）**：
Path 上的一个顶点。分角点（Corner）与平滑点（Smooth）：两侧 Handle 共线的是平滑点，其余是角点（ADR-0032）。
_Avoid_: Vertex、Point、Node（几何意义上）

**Handle（手柄）**：
从 Anchor 伸出、控制相邻曲线段方向与曲率的控制点。
_Avoid_: Control point、Direction point、Bezier point

**Endpoint（端点）**：
开放 Path 某条子路径的首个或末个 Anchor。钢笔和铅笔从 Endpoint 续画；Join 连接两个 Endpoint。
_Avoid_: End point、Tip、Terminal

**Stray Point（游离点）**：
只有一个 Anchor、没有线段的 Path，或 Path 中这样的一条子路径（Illustrator 的 Compound Path 由多个 PathItem 组成，每个子路径各算一个）。它不可见也无法打印，Object > Path > Clean Up 删除它。
_Avoid_: Orphan point、Lone anchor

**Live Shape（实时形状）**：
由参数（宽高、圆角、边数、内外半径、起止角、端点、圈数）定义的 Node，如矩形、椭圆、多边形、星形、直线（Illustrator 的 Live Line，端点 `x1, y1, x2, y2`）、螺旋线。多边形和星形另有 Inkscape 的 `angle`（首个顶点方向）、`rounded`（圆滑）、`randomized`（随机扰动），星形还有 `twist`（内顶点扭转）（ADR-0024）。椭圆的起止角 `startAngle` / `endAngle` 从 3 点钟方向顺时针量，弧类型 `arcType` 为 `slice`（扇形）、`chord`（弓形）或 `open`（开放弧）（ADR-0025）。螺旋线（spiral）用 Inkscape 的参数：中心 `cx, cy`、外端半径 `radius`、圈数 `revolution`、展开 `expansion`、起始方向 `argument`（度，从 3 点钟方向顺时针）与内端起点 `t0`；它总是开放的，从中心向外顺时针旋转，逆时针的螺旋线是镜像放在 `transform` 里的同一条螺旋线。Illustrator 的 Decay / Segments 只是 Spiral 工具的选项，映射到这些参数（ADR-0060）。Arc 工具画的弧不是 Live Shape，而是普通 Path，其类型、基准轴与斜率只是工具选项（ADR-0059）。Rectangular Grid / Polar Grid 工具画的网格也不是 Live Shape，而是一个 Group，子级是 Live Shape（矩形网格：外框 `rect` 与每条分隔线一个 `line`），分隔线数量与偏斜只是工具选项（ADR-0061）。锚点级编辑会把它转为 Path。它的派生几何以 `d` 形式只读暴露。
_Avoid_: Primitive、Basic shape、Parametric shape

**Compound Path（复合路径）**：
多条子路径按同一填充规则视为一个 Path，用于挖洞。它是破坏性的：子路径不再各自独立。在模型中它就是一个 `path` Node：`d` 含多个子路径，`fillRule` 为 `nonzero`（默认）或 `evenodd`；没有单独的 `compound_path` 类型（ADR-0018）。
_Avoid_: Compound Shape（另一个概念）、Hole、Cutout

**Compound Shape（复合形状）**：
对若干子 Node 施加布尔运算（Unite / Minus Front / Intersect / Exclude）的非破坏性 Live Object；子 Node 保留、可编辑、结果实时重算。
_Avoid_: Boolean、Boolean group、Pathfinder object

## 文字

**Text（文字）**：
显示字符的 Node，`type` 为 `text`，按 `kind` 分为 Point Type、Area Type、Type on a Path。字符属性（字体族、字体样式、字号、字符间距）存在 Node 上，Character Range 为部分字符覆盖其中一些。
_Avoid_: Label、Text box、Text element

**Point Type（点文字）**：
从一个点开始、只在硬回车处换行的 Text，`kind: "point"`。那个点是第一个字符基线的起点。
_Avoid_: Point text、Label、Single-line text

**Area Type（区域文字）**：
在一个矩形框内自动换行的 Text，`kind: "area"`，`x, y, width, height` 就是那个框。放不下的文字是溢出（Overflow），不绘制，写入时回执警告 `TEXT_OVERFLOW`（ADR-0022）。
_Avoid_: Text box、Paragraph text、Flowed text

**Font Style（字体样式）**：
Text 的字符属性 `fontStyle`，Illustrator 字符面板里字体族旁的样式名：字重名（Thin、ExtraLight、Light、Regular、Medium、Semibold、Bold、ExtraBold、Black）加可选的 ` Italic`，单独的 `Italic` 即 Regular Italic，缺省 `Regular`。内置 Source Sans 3 的 Regular、Italic、Bold、Bold Italic、Black、Black Italic；其他样式按 CSS 字体匹配规则以最近的内置字面绘制，回执警告 `FONT_MISSING`（ADR-0028）。
_Avoid_: Font weight、Bold flag、Typeface

**Leading（行距）**：
Text 相邻两行基线之间的距离，单位 pt。未设置即 Auto，为字号的 120%，随字号变化。
_Avoid_: Line height、Line spacing

**Tracking（字符间距）**：
Text 的字符属性 `tracking`，每个字符后增加的间距，单位 1/1000 em，与 Illustrator 字符面板一致，可为负，缺省 0。每行最后一个字符后的间距不计入行宽（ADR-0029）。
_Avoid_: Letter spacing、Character spacing、Kerning（Kerning 是字符对之间的调整）

**Character Range（字符区间）**：
Text 的 `ranges` 中的一项 `{start, end, …}`：按字符（码点）索引 `content` 的 `[start, end)`，为这些字符覆盖 Node 的字符属性，目前是 `fill`（替换每个 Fill 的颜色）、`baselineShift`（pt，向上为正）和 `rotation`（度，顺时针，绕字符基线原点）。存储为规范形式：有序、不重叠、相邻相同合并；写 `content` 而不给 `ranges` 会清空它们（ADR-0029）。
_Avoid_: Run、Span、Character style（Character Style 是具名样式，F-TEXT-08）

## 图像

**Image（图像）**：
置入的位图 Node，`type: "image"`：一个框 `x, y, width, height`、`preserveAspectRatio`（缺省 `none`，即拉伸到框），以及 `src`，即图像文件字节的 SHA-256。同一文件在 Document 中按 `src` 只存一份，Node 里只有这个 id。支持 PNG、JPEG、GIF（首帧）。裁切就是以它为内容的 Clipping Mask（ADR-0023）。Image 分嵌入与链接两种（ADR-0042）：

- **嵌入（embedded）**：没有 `file`，像素就是 `src`。
- **链接（linked）**：有 `file`，即 SVG 引用该文件所写的路径或 URL，对应 Illustrator PlacedItem 的 `file`；可以同时有 `src`，即 Document 存下的一份像素。导出 SVG 写 `xlink:href="<file>"`，不写像素。
- **缺失链接（missing link）**：有 `file` 而没有 `src` 的链接 Image。`render` 和画布把它画成框加两条对角线，如 Illustrator 画找不到的置入文件。

**Relink（重新链接）**：
给 Image 换像素（新的 `src`），链接 Image 还可换 `file`；id、框、变换、名称、不透明度与 Clipping Mask 不变。对应 Illustrator 的 Relink。Agent 经 `node_update` 写 `src`，设计师经 Object > Relink… 从磁盘选文件（ADR-0042）。
_Avoid_: Replace、Swap

**Embed（嵌入）**：
把有像素的链接 Image 变为嵌入 Image，即去掉 `file`，对应 Illustrator 的 Embed。Agent 经 `node_update` 写 `file: null`，设计师用 Object > Embed；缺失链接不能 Embed（ADR-0042）。
_Avoid_: Bitmap、Picture、Raster、Photo、Placed item 作为类型名

## 实时对象

**Live Object（实时对象）**：
保留参数、由参数派生出几何、支持 Expand 与 Release 的 Node 的统称。包括 Live Shape、Compound Shape、Blend、Repeat、Chart、带 Effect 的对象、带画笔的描边。
_Avoid_: Smart object、Dynamic object、Procedural object

**Expand（扩展）**：
把 Live Object 的派生几何固化为普通 Path，丢弃参数。不可逆。
_Avoid_: Flatten、Bake、Rasterize（那是转位图）

**Release（释放）**：
解除 Live Object 的关系，恢复其子 Node 为独立对象。与 Expand 不同，它保留子 Node 而丢弃结果。
_Avoid_: Ungroup（那是 Group 的操作）、Detach

**Blend（混合）**：
在两个或多个 Node 之间按步数或距离生成过渡对象的 Live Object。
_Avoid_: Morph、Interpolation、Tween

**Repeat（重复）**：
按径向、网格或镜像规则复制一个 Node 的 Live Object。
_Avoid_: Array、Pattern（那是填充）、Clone

**Chart（图表）**：
由数据、编码与主题派生出坐标轴、图形与标签的 Live Object。改数据即重绘；Expand 后成为普通 Node。
_Avoid_: Graph（Illustrator 旧称，仅在映射表中出现）、Plot、Visualization

**Diagram（图示）**：
由节点与边描述（如 Mermaid）生成的流程图、架构图等。生成后是普通 Group，其中的连接线是 Connector。
_Avoid_: Chart、Flowchart 作为总称

**Connector（连接线）**：
两端绑定到其他 Node、随其移动而重新路由的 Path。
_Avoid_: Arrow、Edge（仅在 Diagram 的输入描述中使用）、Link

## 外观

**Appearance（外观）**：
一个 Node 的全部视觉属性：有序的 Fill 列表、Stroke 列表与 Effect 列表。可施加于单个 Node、Group 或 Layer；Group 或 Layer 的 Appearance 描画其每个后代的轮廓（文字描画其字形；内层 Clipping Mask 中的后代只画在其 Clipping Path 内），栈中另有一项 Contents（ADR-0043）。
_Avoid_: Style（保留给 Graphic Style）、Paint、Look

**Contents（内容）**：
Group 或 Layer 的 Appearance 栈中代表其后代的一项。它在栈中的位置决定容器的哪些 Fill 与 Stroke 画在子节点下面、哪些画在上面；默认在所有容器描画之下（ADR-0043）。
_Avoid_: Children（指栈中的项时）、Content

**Fill（填充）**：
Appearance 中给 Path 内部着色的一层：纯色、渐变或图案。一个 Node 可有多个 Fill。
_Avoid_: Background、Color（泛指时）

**Stroke（描边）**：
Appearance 中沿 Path 轮廓绘制的一层，有宽度、端点、连接、虚线、箭头等属性。一个 Node 可有多个 Stroke。
_Avoid_: Outline、Border、Line、笔迹（那是 Ink）

**Gradient（渐变）**：
Fill 或 Stroke 的一种颜色：若干 Color Stop 之间的平滑过渡，线性（沿起点到终点）或径向（从焦点向外到中心、半径、长宽比与角度定出的椭圆）。它的位置属于这一个 Fill 或 Stroke，在 Node 自身坐标中，随 Node 的变换移动；改 Live Shape 参数或锚点不会移动它。它内联在 Fill 或 Stroke 里，不引用 Asset（ADR-0026）。
_Avoid_: Ramp、Blend（那是另一个概念）、Gradient fill 作为类型名

**Color Stop（色标）**：
Gradient 上的一个位置（0–1）与颜色，透明度即颜色的 alpha。一个 Gradient 至少两个。
_Avoid_: Stop（泛指时）、Key、Color point

**Effect（效果）**：
Appearance 中非破坏性修改几何或像素的一层，如阴影、模糊、偏移路径。
_Avoid_: Filter（保留给 SVG filter 的技术语境）

**Graphic Style（图形样式）**：
可复用、可命名的完整 Appearance 定义，存于 Asset 库。
_Avoid_: Style preset、Theme

**Clipping Mask（剪切蒙版）**：
用一个 Path 或文字的形状裁切一组 Node 可见范围的容器。在模型中它就是一个含 Clipping Path 的 `group` 或 `layer`，没有单独的 `clip_group` 类型（ADR-0021）。Layer 作 Clipping Mask 时（Layers 面板底部的 Make/Release Clipping Mask，ADR-0053），它的最上层子 Node 成为 Clipping Path，裁切 Layer 中其余一切，含子 Layer 与之后画入的 Node；Layer 保持原名与结构，不生成 Group。
_Avoid_: Clip、Crop（那是位图操作）、Clip group 作为类型名

**Clipping Path（剪切路径）**：
Clipping Mask 中做裁切的那个子 Node：一个 `clipping: true` 的 Live Shape、Path 或文字。文字按其排好的字形裁切，且仍可编辑（ADR-0052）。每个 Group 或 Layer 至多一个；它裁切同一容器中的其他 Node（ADR-0053）。建立时其 Appearance 清空（文字的 Character Range fill 一并清空）；重新赋予后，Fill 画在被裁切内容之下，Stroke 画在其上且不被自身裁切（ADR-0051）。Illustrator SVG 把它写成 `<clipPath><use>`，导入时按所指形状复制到原处读出，名称与 id 取自该 `<use>`（ADR-0056）。
_Avoid_: Mask path、Clip shape

**Opacity Mask（不透明度蒙版）**：
用一个 Node 的亮度控制一组 Node 透明度的容器。
_Avoid_: Alpha mask、Luminosity mask

## 手绘

**Ink（笔迹）**：
来自鼠标、触控笔或 Agent 的原始点序列（含可选压力），尚未成为 Path。
_Avoid_: Stroke（那是描边）、Gesture、Trace

**Fidelity（保真度）**：
把 Ink 拟合为 Path 时"忠实原点"与"平滑"之间的取舍参数，与 Illustrator Pencil 选项同义。
_Avoid_: Smoothing、Tolerance

## 资源

**Asset（资源）**：
Document 级的可复用定义：色板、图案、符号、Graphic Style、字符与段落样式、画笔、图表主题。被引用的 Asset（全局色板、符号、Graphic Style 等）修改后所有引用处同步；渐变色板在施加时复制进 Fill 或 Stroke，Gradient 不引用它（ADR-0026）。
_Avoid_: Library item、Resource、Definition

**Symbol（符号）**：
一份可复用的图稿定义，存于 Asset 库；放到文档里的每一份是 Symbol Instance。
_Avoid_: Component、Master、Template

**Swatch（色板）**：
命名的颜色或渐变 Asset。标记为全局的颜色 Swatch 被修改时，所有使用处同步变化；渐变 Swatch 施加时复制进 Fill 或 Stroke。
_Avoid_: Palette entry、Color token

## 编辑与协作

**Transaction（事务）**：
一组作为整体提交或回滚的编辑，也是撤销的最小单位。UI 的一次拖拽和 Agent 的一组工具调用都各成一个 Transaction。它属于 Document 而不属于任何连接，只有开启它的 Actor 能使用其 `txId`；5 分钟无活动未提交即回滚。
_Avoid_: Batch、Undo step、Operation group

**Command（命令）**：
浏览器把一次手势（拖动、删除、显示 / 隐藏、锁定）作为一个 core 编辑经 WebSocket 发给 Document。Document 要么把它提交为一个归属 User Actor 的 Transaction 并广播，要么只向发送方回复拒绝；浏览器从不在本地先行应用它。
_Avoid_: Operation、Action、Mutation

**Revision（修订号）**：
Document 单调递增的版本序号，每提交一个 Transaction 加一。用来判断"我读过之后文档是否被别人改过"。
_Avoid_: Version（保留给 schema 版本）、Etag、Snapshot

**Delta Log（增量日志）**：
每个已提交 Transaction 所改 Node 的前后副本，按 Revision 索引。撤销和重做反转其中一条；一个 rev 离开撤销与重做栈（栈只记最近 200 个）时，它的副本随之删除（ADR-0011；ADR-0017 为 Replace 保留 30 天，ADR-0030 删除 Replace 后恢复）。
_Avoid_: History（那是栈）、Changelog、Journal

**WriteReceipt（写入回执）**：
每个写工具的统一返回：`txId`、提交后的 `rev`、新增 / 修改 / 删除的 Node id、`clientKey` 到新 id 的 `keyMap`、受影响范围的 `bounds` 与 `warnings`。Agent 靠它确认改了什么，无需重读。`bounds` 是新增与修改的 Node 在写入后的几何 bounds、与删除的 Node 在写入前的 bounds 的并集；并集为空（例如只改了空 Group）时为 null。修改的 Node 只算新位置，不并入旧位置。每个入口（MCP、HTTP、Command、undo / redo、`tx_commit`、Place）都由 Document 按这一条规则算出。`partial: true` 时另附 `failed`：每个未生效项的下标与错误。Transaction 内的写入，`rev` 仍是已提交的修订号，`tx_commit` 时才递增。
_Avoid_: Result、Response、Ack

**Actor（参与者）**：
做出修改的身份：一个人类 User，或一个 Agent 凭证。每个 Transaction 记录其 Actor；同一个人授权的两个 MCP 客户端是两个不同的 Actor。
_Avoid_: Session、Client、Connection、User（Actor 可能是 Agent）

**User（用户）**：
一个用 GitHub 登录 Zibel 的人，按 GitHub 数字 id 识别，login 每次登录时刷新。每个 User 有一个自己的 User Actor（`user_<userId>`），他在浏览器里的所有标签页都以它编辑。dev 模式只有一个本地 User `local`，其 Actor 是 `user`（ADR-0047）。
_Avoid_: Account、Member（保留给文档成员）、Session（那是一次登录）

**Role（角色）**：
一个 User 在一个 Document 上能做什么：owner（所有者，唯一，可分享与删除）、editor（可编辑）或 viewer（只能查看、选择、缩放和下载）。创建、打开或导入 Document 的 User 是其 owner；owner 把 Document 分享给另一个 User，他就成为 editor 或 viewer 成员。Agent 取其 User 的 Role，只读 token 至多是 viewer。没有 Role 的 Document 对他如同不存在（`DOC_NOT_FOUND`）。dev 模式的本地 User 是每个 Document 的 owner（ADR-0047）。
_Avoid_: Permission、ACL、Access（那是 token 的读写范围）

**Member（成员）**：
owner 分享给的 User，在该 Document 上是 editor 或 viewer。owner 本身从不是 Member（ADR-0047）。
_Avoid_: Collaborator、Participant、Guest

**Quota（配额）**：
托管免费 beta 对一个 User 或一个 Document 的硬上限，超过即 `LIMIT_EXCEEDED`，其 `limit` 字段给出名称、上限与用量：owner 拥有的 50 个 Document、owner 的 200 MB 存储、调用者每个 UTC 日 500 次 `render` 与 200 次 `export`、每个 Document 20 个浏览器连接。只在 GitHub 模式生效；单个 Document 20 MB 的图像文件上限（`document_storage`，ADR-0046）在两种模式都生效，也用同一个 `limit` 字段报告（ADR-0048）。
_Avoid_: Limit（那是请求本身的上限，如 5 MB 位图、4096 px 渲染）、Rate limit、Plan

**Agent**：
通过 MCP 调用 Zibel 的 AI 客户端，以自己的凭证作为一个 Actor。与人类用户拥有同等的编辑能力，只是入口不同。
_Avoid_: Bot、AI、Model、Assistant

## 渲染与导出

**Render Scope（渲染范围）**：
`render` 与 `export` 画出的那块区域：整个 Document（所有 Artboard 的并集）、一个 Artboard、若干 Node（取它们的 visible bounds，且只画这些 Node）或一个文档坐标矩形。它决定 `docRect`；唯独 SVG `export` 在整个 Document 范围时，`viewBox` 与 `docRect` 取位于 (0,0) 的 Artboard，没有则取第一个，其余 Artboard 作为视口外的页面（ADR-0017）。
_Avoid_: Region、Crop、Viewport（那是返回的映射）

**Viewport（视口元数据）**：
`render` 返回的 `{docRect, pixelSize, scale}`：图像覆盖的文档矩形、像素尺寸、实际采用的每点像素数。Agent 用 `docX = docRect.x + px / scale` 把截图坐标换回文档坐标。
_Avoid_: Camera、View、Transform

**Render Overlay（渲染叠加层）**：
`render` 画在图稿之上的辅助标记：Node 的 bounds、Node id 标签、Artboard 边界。按像素定尺寸，只出现在 `render` 图像里，不进入 Document，也不进入 `export`。
_Avoid_: Annotation、Guide（那是参考线）；不要单说 Overlay（ADR-0008 的 Transaction overlay 是另一回事）

## 导入与往返

**Round Trip（往返）**：
Document 导出为 SVG、在 Inkscape 中编辑、再在 Zibel 中打开为一个新 Document 的全过程；需要的图稿再经 Copy 粘贴回原 Document。Document 能表达的一切结构都必须保留；Inkscape 能表达而 Zibel 不能的，是 Zibel 的缺口（ADR-0017）。
_Avoid_: Sync、Roundtrip conversion

**Open（打开）**：
把一个文件（`.zibel.json` 或 SVG）变成一个新 Document，在浏览器中新开一个 Document Tab 显示，对应 Illustrator 的 File > Open。导入一个编辑过的文件就是 Open；Zibel 不把文件合并回已有 Document（ADR-0030 删除了 Replace）。
_Avoid_: Load、Import（泛指时）、Replace、Update from file

**Document Tab（文档标签页）**：
浏览器里一个打开着的 Document，对应 Illustrator 的文档标签页。一个 Tab 就是一个 Document，不是 Document 里的一层容器；打开哪些 Tab 只是浏览器状态，关闭 Tab 不删除 Document，MCP 看不到 Tab（ADR-0030）。
_Avoid_: Sheet、Page、Workbook、Window

**Copy（拷贝）**：
把 Selection 作为 Node 范围的 SVG 导出写进系统剪贴板，对应 Illustrator 的 Edit > Copy。Cut 是 Copy 后删除。同一份剪贴板可以粘贴到另一个 Document Tab、另一个浏览器窗口或 Inkscape（ADR-0030）。
_Avoid_: Duplicate（那是在原处复制出新 Node）、Clone

**Place（置入）**：
把一个文件放进已有 Document 的某个父级，对应 Illustrator 的 File > Place 与粘贴。SVG 置入为一个 Group，全部分配新 id；位图置入为 image 节点（F-IO-02）。粘贴 Zibel 的 Copy（根上 `zibel:scope` 为 `nodes:…`）例外：列出的 Node 直接进入目标 Layer，不包 Group（ADR-0030）。
_Avoid_: Insert、Embed（那是位图的链接方式）

## 读取与查询

**Document Outline（文档大纲）**：
`doc_outline` 返回的稀疏 Node 树：每项只有 id、type、name、bounds（`includeBounds: false` 时省略）、childCount、visible、locked，子项展开到 `depth` 层。不带 `rootId` 时顶层永远是 Layer 列表。
_Avoid_: Tree、Layers（那是面板）；不要单说 Outline（Illustrator 的 Outline 是轮廓视图或 Create Outlines）

**Node Query（节点查询）**：
`node_query` 按条件（类型、名称正则、标签、父级、区域）找 Node，条件同时成立才算匹配，结果按 id 排序分页。它是 Agent 侧的"选择"，不改变 Selection。
_Avoid_: Search、Filter、Find

**Cursor（游标）**：
分页结果里的 `nextCursor`：上一页最后一个 Node 的 id，原样传回取下一页。它不在服务器上保存任何状态。
_Avoid_: Page token、Offset、Session

## MCP 接口

**Skill（技能文档）**：
随服务分发的 `skill://zibel/*` 资源，写绘图约定、坐标 / 颜色 / 路径规范与推荐工作流。Agent 按需读取；工具描述只指向它，不重复它。
_Avoid_: Prompt（那是 MCP prompts，F-MCP-20）、Guide、Instructions、README
