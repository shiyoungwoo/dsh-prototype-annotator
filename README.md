# DSH 原型批注 · Prototype Annotator

[English](README.en.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [问题反馈](https://github.com/shiyoungwoo/dsh-prototype-annotator/issues)

[![CI](https://github.com/shiyoungwoo/dsh-prototype-annotator/actions/workflows/ci.yml/badge.svg)](https://github.com/shiyoungwoo/dsh-prototype-annotator/actions/workflows/ci.yml)
![DSH Desktop](https://img.shields.io/badge/DSH_Desktop-0.2.1--rc.3-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**在 DSH 里直接点选原型元素、写修改要求，再交给 Agent 修改。** 类似 Codex 的页面批注体验，不用反复截图、画圈或描述“左边第三个按钮”。

支持侧栏浏览器打开的本地开发页面，例如 Vite、React、Vue 开发服务器；无需把项目转换成静态 HTML。输入框和已发送消息都以一个「N 条注释」标签显示，元素选择器和样式等定位信息仍会发送给模型。

## 功能

- **点选定位**：鼠标悬浮高亮元素，显示尺寸、颜色和字体；点击后输入修改说明。
- **批注入口**：会话标题栏固定提供「批注」按钮，侧栏工具栏保留快捷入口。也可按 `Option+A`（Windows/Linux 键盘为 `Alt+A`，未验证）。
- **紧凑标签**：多条批注合并成一个「N 条注释」标签。发送前可打开详情、删除单条批注；发送后可只读查看。
- **带上元素信息**：DOM 选择器、标签、短文本、尺寸、样式、页面地址和视口大小随修改要求发送。
- **适配现有工作流**：只把批注加入会话输入框，由你决定何时发送。插件本身不修改项目源文件。
- **无需额外服务**：无运行依赖、无安装构建脚本、无独立采集服务器。

示例操作：打开本地前端 → 点「批注」→ 选中图标 → 输入「这个图标太卡通，改成适合金融平台的线性图标」→ 输入框出现「1 条注释」→ 发送。

## 兼容范围

| 项目 | 状态 |
| --- | --- |
| DSH Desktop `0.2.1-rc.3`，macOS | 用户已在实际界面确认点选、加入标签和紧凑消息显示可用 |
| 侧栏 Browser 中的本地前端页面 | 支持，通过 Electron webview 读取 DOM |
| 可访问 DOM 的 HTML 预览 iframe | 支持；跨域和沙箱限制会影响读取 |
| Windows / Linux Desktop | 未验证 |
| 纯 Web、TUI、Headless | 不作为此版本的支持目标 |
| DSH Desktop `0.2.1-rc.5`，macOS | 已检查原生标题栏插槽；入口与点选回归测试通过，实际界面未验证 |
| 其他 DSH 版本 | 未验证；包声明范围为 `>=0.2.1-rc.3 <0.3.0`，不表示整个范围均已验证 |

需要默认 Desktop 提供的 sidebar-right 和 sidebar-browser 宿主插件。插件使用 DSH 当前版本的输入标签、用户消息渲染和侧栏接口。这些接口及工具栏 DOM 结构会随宿主版本变化。宿主升级后需要重新验证；请勿同时安装多个副本。

## 安装

### 通过 DSH 安装

在 DSH 对话中粘贴以下内容，让 Agent 使用内置插件管理器安装：

```text
请安装 DSH 插件 github:shiyoungwoo/dsh-prototype-annotator。
请使用插件管理器 install_bundle，不要手动修改 profile 配置。
```

安装后重新加载 DSH 界面。若没有出现「批注」按钮，退出并重新打开 DSH Desktop。

### 通过命令行安装

已配置 `dsh` 命令的用户：

```sh
dsh plugin --profile desktop add github:shiyoungwoo/dsh-prototype-annotator
```

macOS 应用内置 CLI（不要求将 `dsh` 加到 PATH）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:shiyoungwoo/dsh-prototype-annotator
```

此命令用于默认 `desktop` profile。自定义 profile 请替换名称。插件没有 `prepare` / `postinstall` 构建脚本。尚未发布到 npm，请使用 GitHub 地址或 Release 安装包。

如果从此前的本地试用版迁移，请先在 DSH 插件管理器移除旧的本地链接，再安装 GitHub 版本。为保持已有批注来源一致，本次保留包名 `@local/dsh-proto-annotate-spike`；公开仓库名为 `dsh-prototype-annotator`。

## 使用

1. 在 DSH Desktop 侧栏浏览器打开你的前端地址，例如 `http://localhost:5173`，或打开可访问 DOM 的 HTML 预览。
2. 点击会话标题栏的「批注」。侧栏顶部或地址栏旁也可提供入口；快捷键为 `Option+A`。
3. 将鼠标移到元素上查看高亮，点击选中。按 `Esc` 取消点选。
4. 输入修改要求。点击「完成」或按 `Enter` 加入输入框。`Shift+Enter` 换行；中文输入法确认文字不会提交。
5. 输入框出现「N 条注释」。「注释已加入输入框」提示显示 3 秒后自动关闭。继续批注会增加计数。点击标签可查看或删除批注。
6. 根据需要补充普通文字，再发送消息。已发送消息也以紧凑标签显示；点击查看只读详情。

选中元素后直接打开注释框。注释框只使用可见按钮定位，并限制在窗口内；点击框外不会关闭未提交的批注，可用「取消」或 `Esc` 关闭。截图预览在后台加载；截图失败或不返回时仍可输入和提交注释。页面跳转、超时、无法识别元素或未收到选择结果时会显示提示。

从会话标题栏进入时，默认使用该会话的输入框。通过其他入口进入且多个输入框同时存在时，需要在面板中选择目标会话。提交中的输入框不能写入。写入失败时，插件保留批注并显示原因。

## 更新和卸载

GitHub 安装后，重新执行同一安装命令以获取仓库版本，再重启 Desktop。通过 DSH 插件管理器可停用或卸载；命令行卸载：

```sh
dsh plugin --profile desktop remove @local/dsh-proto-annotate-spike
```

## 数据说明

标签保存修改要求和元素上下文。元素截图会缩小到最大 `480×320` 的 JPEG，只用于发送前的详情预览，不随批注文本发送给模型。发送后的详情没有截图。

模型收到修改要求、选择器、元素短文本、尺寸、样式、页面 URL 和视口大小。URL 与选中元素的文本会成为会话内容；在含敏感信息的页面上使用前，请检查这些内容。此插件没有额外网络请求或遥测服务，消息仍通过 DSH 当前选择的模型提供方发送。

批注正文以 `<prototype-annotations>` 块保存在会话消息中。插件只改变气泡的显示方式，不删减模型所需的定位信息。停用插件后，会话中仍保留可读的原始文本。

## 限制与排查

- 按钮未出现：确认使用 Desktop、侧栏已打开页面，并重新加载或重启。`Option+A` 也可开启点选。
- 页面无法点选：跨域 iframe、封闭 Shadow DOM、canvas 绘制内容和嵌套 iframe 不在本版本支持范围内。优先使用侧栏 Browser 打开本地页面。
- 选择器失效：选择器对应点选时的 DOM；页面结构变化后请重新点选。开放 Shadow DOM 使用 ` >>> ` 分隔路径。
- 草稿在重启后能否保留原生引用标签：未验证。
- 部分提示与标签文本目前为中文；插件元数据和主要操作有中英文资源。
- 请勿在不受信任的页面上放宽 iframe 沙箱权限；建议用于你自己的原型和本地开发页面。

## 开发与验证

无需安装依赖或编译，Node.js `22.19+`：

```sh
npm run check
npm test
npm run test:package
```

回归测试覆盖标签注册、合并、发送上下文、旧消息识别、拒绝写入、静默丢弃、多会话、重复回车、输入法、详情删除、截图挂起、取消竞态和点选异常清理。测试加载真实客户端脚本，宿主服务和 DOM 使用测试替身。打包检查解包实际 tarball，核对入口、资源、清单和无本地路径，并从解包后的脚本执行同一组回归测试。它们不能代替 Desktop 界面验证。

入口文件：`index.js`（Host）、`client.js`（Client）、`cordis.patch.yml`（Bundle），`locale/` 为插件显示资源。GitHub Actions 在 Node.js 22/24 上执行语法、回归和打包检查。

首次公开版本见 [更新记录](CHANGELOG.md)。遇到问题请提交 Issue，附 DSH 版本、系统版本、页面类型和复现步骤；请先遮盖隐私内容。

## 参考与许可证

交互目标参考 Codex 的页面批注体验；本项目是独立实现的第三方 DSH 插件，与 OpenAI 无隶属关系。调研过 [react-grab](https://github.com/aidenybai/react-grab) 等元素定位工具；运行时不依赖这些项目。

[MIT License](LICENSE) © 2026 shiyoungwoo。
