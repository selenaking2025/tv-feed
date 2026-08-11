# Third-Party Notices

本文件记录 TV Feed `0.1.0` 当前直接使用的第三方软件，以及构建产物中需要保留的许可证和版权声明。版本以 `package-lock.json` 为准。

TV Feed 自有代码和自有素材采用 MIT License；该许可证不覆盖本文件列出的第三方软件，也不覆盖频道目录、直播内容、频道名称、Logo 或商标。

## 随应用分发的运行时组件

| 组件 | 当前版本 | 用途 | 许可证 | 随包声明 |
| --- | ---: | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 43.3.0 | 桌面运行时 | MIT | `third_party_licenses/Electron-LICENSE.txt` |
| [@phosphor-icons/web](https://github.com/phosphor-icons/web) | 2.1.2 | 应用界面图标 | MIT | `third_party_licenses/Phosphor-Icons-LICENSE.txt` |
| [hls.js](https://github.com/video-dev/hls.js) | 1.6.17 | 在 Chromium 中播放 HLS | Apache-2.0 | `third_party_licenses/hls.js-LICENSE.txt`、`third_party_licenses/Apache-2.0.txt` |

Electron 运行时还包含 Chromium、Node.js、V8、FFmpeg 以及其他第三方组件。它们的逐项版权与许可证由 Electron 随附的 `LICENSES.chromium.html` 汇总。TV Feed 的打包配置会把该文件原样保留为：

```text
legal/ELECTRON-THIRD-PARTY-NOTICES.html
```

TV Feed 的项目许可证、本文件以及 `third_party_licenses/` 也会一并放入打包应用的 `legal/` 目录。

## 直接构建依赖

以下组件用于开发、类型检查或打包，不作为 TV Feed 应用代码中的独立运行时模块加载。它们及其传递依赖的精确版本由 `package-lock.json` 固定。

| 组件 | 当前版本 | 用途 | 许可证 |
| --- | ---: | --- | --- |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.13.3 | Node.js 类型定义 | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 26.15.3 | Electron 应用打包 | MIT |
| [electron-vite](https://github.com/alex8088/electron-vite) | 5.0.0 | Electron 构建集成 | MIT |
| [Vite](https://github.com/vitejs/vite) | 7.3.6 | 渲染端构建 | MIT；发布包另含 MIT、ISC、BSD-2-Clause、CC0-1.0 组件 |
| [TypeScript](https://github.com/microsoft/TypeScript) | 7.0.2 | 类型检查与编译 | Apache-2.0 |
| [plist](https://github.com/TooTallNate/plist.js) | 3.1.0 | macOS 打包后的 Info.plist 加固 | MIT |

构建工具的传递依赖及许可证标识可在 `package-lock.json` 与安装后各包的 `LICENSE`/`NOTICE` 文件中核对。若依赖或版本发生变化，发布者应在分发新版前重新生成并核对此清单。

## hls.js 原始版权说明

以下内容从已锁定的 `hls.js 1.6.17` 包内 `LICENSE` 原样保留；完整文本也存放于 `third_party_licenses/hls.js-LICENSE.txt`：

```text
Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

src/remux/mp4-generator.js and src/demux/exp-golomb.ts implementation in this project
are derived from the HLS library for video.js (https://github.com/videojs/videojs-contrib-hls)

That work is also covered by the Apache 2 License, following copyright:
Copyright (c) 2013-2015 Brightcove


THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## iptv-org 数据来源

TV Feed 运行时读取 [iptv-org API](https://github.com/iptv-org/api) 提供的频道目录和公开直播 URL 索引。iptv-org 的 `iptv`、`api` 和 `database` 仓库当前分别包含 Unlicense 文本。该许可只适用于上游贡献者有权许可的仓库材料；它不代表电视节目、直播信号、频道 Logo、频道名称或商标已经获得 TV Feed 使用、转播或商业化授权。

详情见 `LEGAL.md`。
