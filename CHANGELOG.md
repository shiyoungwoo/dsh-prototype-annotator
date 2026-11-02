# Changelog

## Unreleased

- Add a native session-header annotation button independent of sidebar DOM selectors, with session-specific delivery.
- Recognize the collapsed sidebar control and avoid `:has()` for browser-toolbar discovery.

- Open the note editor without waiting for optional screenshot capture.
- Report selection errors and clear picker resources instead of leaving selection pending.
- Ignore stale selection and screenshot results after cancellation or a new pick.
- Use the preview iframe's DOM constructors when selecting its elements.
- Ignore hidden toolbar anchors and keep the editor inside the viewport.
- Keep unsent annotations open on outside clicks.
- Report navigation, timeout, unrecognized elements, and missing selection results.

## 0.0.2 — 2026-10-30

- Dismiss the annotation-added success notice automatically after 3 seconds.

## 0.0.1 — 2026-10-29

First public GitHub release for DSH Desktop `0.2.1-rc.3` on macOS.

- Pick elements directly in the sidebar Browser or accessible HTML preview.
- Show hover highlights and element metadata; collect change requests with DOM context.
- Merge annotations into one native composer reference chip.
- Render sent annotations as a compact chip with read-only details, including older untagged messages.
- Keep screenshots out of model text; retain small thumbnails for pre-send preview.
- Add Chinese and English installation guides, MIT license, GitHub CI, and tarball smoke checks.

Distribution: GitHub source and Release tarball; no npm publication. Package identity remains `@local/dsh-proto-annotate-spike`.
