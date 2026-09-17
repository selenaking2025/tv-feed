---
name: TV Feed
description: 窗口本身就是一台可操作的黑红复古电视机。
colors:
  cabinet-red: "#a6392f"
  cabinet-light: "#bd493b"
  cabinet-dark: "#8f2f28"
  face-dark: "#22231f"
  screen: "#030604"
  menu: "#222720"
  settings: "#252521"
  text: "#f2ecde"
  text-muted: "#c3bdb0"
  text-soft: "#aaa497"
  accent: "#efd9b0"
  accent-soft: "rgba(239, 217, 176, 0.12)"
  accent-text: "#38271e"
  line: "rgba(244, 224, 190, 0.13)"
  line-strong: "rgba(244, 224, 190, 0.28)"
  error-text: "#ffc1c1"
  waiting-text: "#d8dda9"
  live: "#ff4e4e"
typography:
  brand:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "21px"
    fontWeight: 850
    letterSpacing: "-0.035em"
  display:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
    fontSize: "clamp(25px, 4vw, 44px)"
    fontWeight: 600
    letterSpacing: "0.06em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "19px"
    fontWeight: 650
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12.5px"
    lineHeight: 1.68
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "11px"
  dial-value:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
    fontSize: "12px"
rounded:
  sm: "6px"
  md: "10px"
  key: "5px"
  cabinet: "40px"
  cabinet-front: "32px"
  face: "25px"
  bezel: "36px / 32px"
  screen: "29px / 26px"
  menu: "15px"
  dialog: "18px"
  circle: "50%"
spacing:
  key-gap: "6px"
  menu-gap: "8px"
  screen-inset: "12px"
  cabinet-gap: "14px"
  face-column-gap: "24px"
components:
  device-key:
    textColor: "#e9dec6"
    rounded: "{rounded.key}"
    width: "38px"
    height: "34px"
  play-key:
    textColor: "#583327"
    rounded: "{rounded.key}"
    width: "42px"
    height: "34px"
  power-key:
    textColor: "#f8e0c1"
    rounded: "{rounded.key}"
    width: "90px"
    height: "36px"
  dialog-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.sm}"
  icon-button:
    backgroundColor: "rgba(255,255,255,0.03)"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.key}"
    width: "32px"
    height: "32px"
  search-field:
    backgroundColor: "rgba(255,255,255,0.04)"
    textColor: "{colors.text}"
    rounded: "{rounded.key}"
    height: "34px"
  view-tabs:
    backgroundColor: "rgba(255,255,255,0.028)"
    rounded: "{rounded.key}"
    padding: "2px"
  source-chip:
    backgroundColor: "rgba(255,255,255,0.025)"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 13px"
  privacy-card:
    backgroundColor: "rgba(255,255,255,0.025)"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "13px 14px"
  rotary-dial:
    rounded: "{rounded.circle}"
    width: "88px"
    height: "88px"
---

# Design System: TV Feed

## Overview

**Creative North Star: "一整台黑红复古电视机"**

窗口本身就是电视机：红色塑料外壳、深黑面板、奶油色铭牌、提手、脚垫、旋钮和扬声器构成同一个物件。形态遵循用户确认的 Learnradio 实体收音机参照；观看、换台和音量操作围绕这台设备展开。

这是桌面 Electron 播放器。装饰负责表达机壳的材质，屏幕负责清楚呈现节目与操作内容。依据为 [README.md](README.md)、[界面结构与方向契约](src/renderer/index.html)、[样式](src/renderer/src/styles.css)及已实现交互；当前没有 PRODUCT.md。

**Key Characteristics:**

- 红色完整机壳，左侧屏幕、右侧旋钮与扬声器，底部实体按键。
- 目录、线路和设置按需进入屏幕；启动时菜单收起。
- 视频保持原始比例；复古纹理只属于设备与待机画面。
- 在受支持的桌面窗口尺寸内保持同一台电视的结构。

## Colors

### Primary

机壳红由 `cabinet-light`、`cabinet-red`、`cabinet-dark` 构成立体渐变。电源键延续红塑料；红色不是普通内容区的统一强调色。

### Secondary

奶油色 `accent` 用于焦点、收藏、选中线路和确认操作；`accent-soft` 承载轻量选中底色。等待与错误使用 `waiting-text`、`error-text`，同时保留文字说明；`live` 只用于正在播放标识的小圆点。

### Neutral

`face-dark` 是黑面板基调，`screen` 是视频底色；`menu` 与 `settings` 分别承载屏内菜单和设置。正文、辅助信息、铭牌细字依次使用 `text`、`text-muted`、`text-soft`。`line` 与 `line-strong` 提供低对比边界。

## Typography

中文界面使用系统无衬线字体栈，不依赖远程字体。品牌使用斜体粗字；待机字标与旋钮读数使用等宽字体，读数保持等宽数字。

| 层级 | 已实现用途 |
| --- | --- |
| `brand` | 机壳左上角 TV FEED，斜体；旁边“网络电视”为小铭牌。 |
| `display` | 仅待机 TV FEED 字标；不用于节目或菜单大标题。 |
| `title` | 设置标题；线路标题稍小（17px）。 |
| `body` | 设置说明；频道名称采用更紧凑的半粗字（12px、720）。 |
| `label` / `dial-value` | 实体键文字与读数；旋钮说明、频道元数据约为 9–10px。 |

频道名称单行省略，设置说明允许换行。不要把装饰铭牌的字号用于主要操作说明。

## Layout

默认窗口（980 × 780px），最小窗口（720 × 580px），透明、无系统边框。顶部红色区域可拖动窗口，交互控件不参与拖动。

外壳填满可用区域，最大（1260 × 920px）；通常窗口留白为上（30px）、左右（20px）、下（32px）。外壳内依次是标题栏（32px）、主体自适应区域、底部铭牌（20px），间隔（14px）。提手居中伸出机壳顶部，脚垫位于下方两侧。

黑面板使用左右两列：屏幕列占剩余宽度，右侧控制列（146px），列间距（24px）。底部按键横跨两列，行高（45px）。屏幕下方保留频道信息（52px）；右侧从上到下为换台、音量与静音、可伸缩扬声器、电源。换台旋钮始终大于音量旋钮（88px / 70px）。

目录距屏幕四边（10px）；线路靠屏幕底部，左右与底边留（12px）。目录列表与线路内容独立滚动。设置以屏幕矩形为定位依据，四边预留（12px），限制最大高度并内部滚动；标题和关闭键粘在顶部。设置的透明模态背景不遮住机壳，窗口缩放时重新计算位置。

| 窗口条件 | 已实现变化 |
| --- | --- |
| 宽度 ≤ 840px | 外部留白缩小，控制列收至 119px，旋钮为 78px / 62px，隐藏品牌副标题与旋钮刻度，按键更紧凑。 |
| 高度 ≤ 680px | 标题区缩至 28px、底部铭牌至 12px，旋钮为 66px / 52px，频道信息至 42px，扬声器最小高度至 24px。与宽度条件叠加时采用这些旋钮尺寸。 |
| 全屏 | 隐藏机壳、旋钮和频道信息，黑色观看区域铺满窗口；保留底部操作键与退出全屏入口。 |

样式中另有宽度 ≤ 620px 的防御性收缩规则，但小于应用最小窗口，不作为移动端支持承诺，也不作为屏内菜单的验收基准。

## Elevation & Depth

阴影表达实体装配：外壳上沿高光与下沿暗边，黑面板略内陷，屏幕边框进一步凹入，旋钮和按钮凸起。保留这些连续关系，不把每条目录内容都做成浮起的卡片。完整阴影值见配套 `.impeccable/design.json`。

**The Original Program Rule.** 视频始终使用原始比例，不加扫描线、CRT 滤镜、色偏、噪声或形变。暗绿辉光与细扫描线只出现在待机占位层。

按钮按下有短距离位移（2px）；普通按钮颜色过渡（140ms），位移过渡（90ms）。目录以轻微上移与淡入出现（150–180ms），不使用持续装饰动画。尊重减少动态效果设置；减少透明效果时取消相应背景模糊。

## Shapes

机壳、红色内壳、黑面板由大圆角逐层收进。屏幕边框与显示区采用椭圆圆角，视频通过显示区裁切。旋钮为正圆，换台旋钮带横向握柄，音量旋钮为浅色圆盘；扬声器使用水平栅格。

实体按键使用小圆角，菜单与设置使用中圆角；频道行在屏内收紧至（7px）。圆角标记仅用于小状态与来源徽章，不扩散成全部操作的形状。

## Components

| 组件 | 外观与状态约束 |
| --- | --- |
| 实体操作键 | 深色凸起按键，播放键单独使用奶油色。选台 / 线路展开时呈棕金色凹陷状态，文字与图标同时说明用途。禁用时降低透明度、不可点击。 |
| 换台与音量旋钮 | 向上拖动增加、向下减少；换台拖动只预览编号，松开后提交一次，取消拖动恢复原值。音量随拖动更新。无频道时换台旋钮禁用。 |
| 电源 | 待机为暗红指示灯；开机为亮灯，并同步“待机、连接中、播放中、已暂停、等待网络、信号中断”文字与按钮语义。按下效果与普通播放 / 暂停键区分。 |
| 目录与搜索 | 打开后焦点进入搜索；关闭后按需回到“选台”。四个范围为全部、中文、收藏、最近。筛选默认收起。搜索框聚焦时强调边界；频道行高（64px），台标（44px），选中行有淡奶油渐变，收藏单独可操作。 |
| 线路 | 与目录互斥展开；选中线路有奶油边界、底色和圆点。等待、连接、不可用同时显示状态文字。打开后聚焦当前线路或关闭键。 |
| 设置 | 原生模态对话框；家庭模式、远程台标、清除操作优先，数据说明放在折叠区。关闭与 Esc 可返回“设置”键。小窗口中必须能滚动到末尾的“知道了”。 |
| 加载、空态与错误 | 待机给出开机提示；目录加载用骨架，播放连接用状态提示。目录失败保留重试、诊断、手动离线演示入口，演示明确显示“离线样例”和数量。错误提示不能伪装成可播放状态。 |

远程台标默认关闭；默认使用本地占位内容。不要在未满足来源核对条件时显示“官方源”，也不添加“精选 / 推荐”等项目背书标签。

可访问性沿用现有语义：图标按钮有中文名称，装饰提手、螺丝、栅格不进入读屏；旋钮保留 slider 角色、数值、禁用状态和文字读数。方向键、Home / End、PageUp / PageDown 操作聚焦旋钮；全局快捷键在输入或设置期间让位给当前控件。目录收起后不可聚焦，状态通过礼貌播报区通知；保留跳到播放器入口。

焦点环为奶油色实线（2px，外偏移 3px）；搜索与选择框使用自身聚焦边界。选中、静音、电源与展开状态同时更新可访问属性，不只改变颜色。

## Do's and Don'ts

### Do:

- **Do** 保持左屏右旋钮、顶部提手、底部脚垫和实体按键组成的完整电视轮廓。
- **Do** 在 980 × 780px 与 720 × 580px 检查待机、目录、线路和设置；设置四边留在屏幕内，滚动到底仍能关闭。
- **Do** 同时检查鼠标拖动、键盘旋钮、菜单焦点返回、禁用状态与减少动态效果。

### Don't:

- **Don't** 把设备改回屏幕外带固定目录侧栏的普通播放器布局。
- **Don't** 为营造复古效果裁掉视频内容、拉伸画面或给实际节目添加滤镜。
- **Don't** 让设置覆盖旋钮、扬声器、机壳或底部按键，或让内容溢出而无法滚动。
- **Don't** 把防御性窄屏样式描述成已经支持的移动端产品。
