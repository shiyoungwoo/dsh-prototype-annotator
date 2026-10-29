# DSH Prototype Annotator

[简体中文](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Issues](https://github.com/shiyoungwoo/dsh-prototype-annotator/issues)

[![CI](https://github.com/shiyoungwoo/dsh-prototype-annotator/actions/workflows/ci.yml/badge.svg)](https://github.com/shiyoungwoo/dsh-prototype-annotator/actions/workflows/ci.yml)
![DSH Desktop](https://img.shields.io/badge/DSH_Desktop-0.2.1--rc.3-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Point at a prototype element inside DSH, describe the change, and send the annotation to your agent.** A Codex-style annotation workflow for local frontends, without manually taking screenshots or describing where a button is.

Open a Vite, React, or Vue development page in the Desktop sidebar browser. Pick an element and write a request. The composer and sent message show a single “N 条注释” chip; the model still receives the DOM context needed to locate the element.

## Features

- Hover highlights with element dimensions, color, and font details.
- A sidebar annotation button and `Option+A` shortcut (`Alt+A` on Windows/Linux keyboards, unverified).
- Multiple annotations in one compact chip, with a detail view and deletion before sending. Sent annotations are read-only.
- Selector, tag, short text, bounds, styles, page URL, and viewport sent with your request.
- Adds annotations to the draft; you choose when to send. The plugin does not edit source files itself.
- No runtime dependencies, install build scripts, collector service, or telemetry endpoint.

Some labels and messages currently remain in Chinese. Plugin metadata and primary actions have English and Chinese resources.

## Compatibility

| Environment | Status |
| --- | --- |
| DSH Desktop `0.2.1-rc.3` on macOS | Picking, composer chips, and compact sent-message rendering confirmed by the user in the real app |
| Local development pages in the sidebar Browser | Supported through Electron webview DOM access |
| HTML preview iframes with accessible DOM | Supported; origin and sandbox restrictions apply |
| Windows / Linux Desktop | Not verified |
| Standalone Web, TUI, Headless | Outside this release's support target |
| Other DSH versions | Not verified; the package declares exactly `0.2.1-rc.3` |

The default Desktop sidebar-right and sidebar-browser host plugins must be available. This version depends on the host's current reference, transcript, and toolbar APIs. Recheck after a DSH upgrade. Do not install multiple copies.

## Install

Ask your DSH agent:

```text
Install the DSH plugin github:shiyoungwoo/dsh-prototype-annotator using the built-in plugin manager's install_bundle action. Do not manually edit profile configuration.
```

Or use the CLI:

```sh
dsh plugin --profile desktop add github:shiyoungwoo/dsh-prototype-annotator
```

On macOS, use the bundled CLI if `dsh` is not on PATH:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:shiyoungwoo/dsh-prototype-annotator
```

Replace `desktop` for a custom profile. Reload the UI after installation; if the button is absent, quit and reopen DSH Desktop. The package has no `prepare` or `postinstall` script. It is distributed through GitHub and Release tarballs, not npm.

For migration from the local trial, remove the old local link in the plugin manager before installing the GitHub version. The package retains its original name, `@local/dsh-proto-annotate-spike`, to preserve its existing identity. The public repository is `dsh-prototype-annotator`.

## Use

1. Open a local frontend such as `http://localhost:5173` in the DSH sidebar Browser, or an HTML preview with accessible DOM.
2. Click **批注** or press `Option+A`.
3. Hover and click an element. Press `Esc` to cancel picking.
4. Write the requested change. Click **完成** or press `Enter`; `Shift+Enter` inserts a newline. IME composition confirmation does not submit.
5. Click the composer chip to review or delete individual annotations. More annotations increase the count on the same chip.
6. Add any ordinary message text and send. The sent message also renders as a compact chip with read-only details.

If multiple composers are mounted, select the destination session in the panel. A submitting composer cannot receive annotations. Failed insertion keeps the annotation and reports the reason.

To update, repeat the GitHub install command and restart Desktop. Disable or uninstall through DSH's plugin manager, or run:

```sh
dsh plugin --profile desktop remove @local/dsh-proto-annotate-spike
```

## Data and privacy

The reference stores your note and element context. A screenshot thumbnail, at most `480×320` JPEG, is used only in the pre-send detail view. It is excluded from serialized model text; sent-message details have no screenshot.

Your agent receives the note, selector, tag, short element text, bounds, styles, page URL, and viewport. A `file://` URL can include your local filesystem path. Review these fields before annotating sensitive pages. The plugin makes no additional network requests; the message is sent through your selected DSH model provider.

Messages store readable `<prototype-annotations>` blocks. The plugin compacts their visual rendering without removing model context. Disable it and the original text remains in the conversation.

## Limits and troubleshooting

- No button: use Desktop, open a sidebar page, and reload or restart. Try `Option+A`.
- Cross-origin or nested iframes, closed Shadow DOM, and canvas-drawn content are outside this release's supported selection scope. Prefer opening your own local page in the sidebar Browser.
- Selectors refer to the DOM at selection time. Pick again after structural changes. Open Shadow DOM paths use ` >>> ` separators.
- Native reference persistence across app restarts is unverified.
- Do not relax iframe sandbox settings for untrusted pages. This plugin is intended for your own prototypes and local development pages.

## Development and validation

No dependency installation or build is required. Use Node.js `22.19+`:

```sh
npm run check
npm test
npm run test:package
```

The 13 regression tests load the actual client script with host test doubles. They cover reference registration, merging, serialization, legacy messages, rejected or dropped insertion, multiple composers, double submission, IME, and detail deletion. The package smoke check unpacks a real tarball, checks entries and resources, and runs those tests against the unpacked client. These checks do not replace a Desktop UI test.

GitHub Actions runs syntax, regression, and package checks on Node.js 22 and 24. The entry files are `index.js` (Host), `client.js` (Client), and `cordis.patch.yml` (Bundle); `locale/` holds metadata resources.

See the [changelog](CHANGELOG.md). Include your DSH version, OS, page type, and reproduction steps in an issue; redact private data first.

## Credits and license

The interaction goal was inspired by Codex page annotations. This is an independent third-party DSH plugin with no OpenAI affiliation. [react-grab](https://github.com/aidenybai/react-grab) and other element-selection projects were researched; they are not runtime dependencies.

[MIT License](LICENSE) © 2026 shiyoungwoo.
