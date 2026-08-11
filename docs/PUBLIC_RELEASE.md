# 公开发布检查清单

本文件保存 TV Feed 公开发布时使用的对外文字和独立人工步骤。`npm run verify:public-release` 会检查仓库内容、Git 状态、远端 `main` 一致性，并依次执行类型检查、测试、生产构建和 Electron 离线 smoke；它不会改变 GitHub 可见性、创建 Release、签名安装包或公证应用。

## 建议的 GitHub 仓库描述

> Local open-source IPTV player and channel reader. Plays user-selected third-party HLS sources without hosting, proxying, recording, or redistributing media.

## 建议的 Topics

`electron`、`hls`、`iptv-player`、`typescript`、`desktop-app`

Topics 不使用 `free-tv`、`free-movies`、`premium-tv` 或其他暗示项目提供免费、付费或已授权节目内容的词语。

## GitHub Release 文案模板

> TV Feed 是一个本地运行的开源 IPTV 播放器和频道阅读器。应用在运行时读取第三方公共目录，并只在用户选择播放后由用户设备直接连接第三方 HLS 源。项目不托管、代理、录制或重新分发电视内容。频道可用性、所在地区和授权状态不作保证；频道名称、Logo、商标和节目内容归各自权利人所有。成人内容过滤依赖上游元数据和本地规则，不是实时内容识别或儿童绝对安全保证。

Release 只附加经过 Apple Developer ID 签名、公证并完成独立验收的安装包。当前 `npm run pack:mac` 生成的 ad-hoc 本地开发包不得作为正式 Release 附件。

## 自动门禁通过后仍需人工完成

- 确认 GitHub 仓库仍处于预期的可见性；从 Private 改为 Public 是单独授权动作。
- 启用并实测 GitHub Private Vulnerability Reporting。
- 把仓库描述和 Topics 与本文件逐字核对。
- 核对准备发布的 Release 标题、正文和附件，不含频道数量、免费影视、授权保证或绝对成人安全承诺。
- 若分发 macOS 安装包，完成 Apple Developer ID 签名、Hardened Runtime、公证、安装包签名和真实下载验收。
- 公有化后从未登录浏览器重新检查 README、MIT 许可证识别、法律与隐私文件、Issue 模板和 Release 页面。
