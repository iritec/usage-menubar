# Usage Menubar

<img width="1111" height="545" alt="image" src="https://github.com/user-attachments/assets/2965d617-61f1-4b87-b35b-710fdd3a54e5" />

A macOS menubar app that tracks your [Claude](https://claude.ai) and [Codex](https://chatgpt.com/codex) usage in real time. See remaining quotas at a glance without leaving your editor.

## Download

**[Download for macOS (Apple Silicon)](https://github.com/iritec/usage-menubar/releases/latest)**

> Signed and notarized. Open the DMG, drag to Applications, done.

## Features

- **Menubar display** — remaining percentages (`C 81%  O 97%`) always visible in the macOS menu bar
- **Display mode toggle** — switch between "Weekly" and "Session" values in the menubar
- **Claude tracking** — current session, all models, and Sonnet-only usage with reset timers (direct API)
- **Codex tracking** — 5-hour and weekly limits, per-model breakdowns
- **Chrome cookie import** — automatically imports your Chrome login session so you don't have to log in again
- **Auto-refresh** — updates every 10 minutes in the background

## Getting Started

1. Log in to Claude / Codex in Chrome
2. Launch the app — Chrome cookies are imported automatically and data appears
3. Your session persists across restarts

> **Tip:** If data doesn't show up, click the **Refresh** button in the popup. Press **Login** to open the provider login page in Chrome.

## Development

```bash
git clone https://github.com/iritec/usage-menubar.git
cd usage-menubar
pnpm install
pnpm dev
```

### Build

```bash
pnpm dist      # macOS distributable .dmg / .zip
```

## Built with KingCoding

This app was built with [KingCoding](https://kingcode.shingoirie.com/) — an AI-powered coding assistant that lets you ship real apps fast.

## License

[MIT](LICENSE)
