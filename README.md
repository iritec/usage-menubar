# Usage Menubar

[Claude](https://claude.ai) と [Codex](https://chatgpt.com/codex) の使用状況をリアルタイムで追跡する macOS メニューバーアプリです。エディタを離れずに残りのクォータをひと目で確認できます。

A macOS menubar app that tracks your [Claude](https://claude.ai) and [Codex](https://chatgpt.com/codex) usage in real time. See remaining quotas at a glance without leaving your editor.

## 機能 / Features

- **メニューバー表示** — 残りパーセンテージ (`C 81%  O 97%`) が macOS メニューバーに常時表示
- **表示モード切替** — メニューバーに表示する値を「週間制限」と「セッション」で切替可能
- **Claude トラッキング** — 現在のセッション、全モデル、Sonnet のみの使用量とリセット時刻（API 直接取得）
- **Codex トラッキング** — 5時間制限と週間制限、モデル別の内訳
- **Chrome Cookie インポート** — Chrome のログインセッションを自動インポート。再ログイン不要
- **自動更新** — バックグラウンドで10分ごとに更新

## 必要環境 / Requirements

- macOS
- Node.js >= 18
- [pnpm](https://pnpm.io/)
- [Claude Pro](https://claude.ai) または [Codex](https://chatgpt.com/codex) のサブスクリプション

## インストール / Install

```bash
git clone https://github.com/iritec/usage-menubar.git
cd usage-menubar
pnpm install
```

## 使い方 / Usage

### 開発モード

```bash
pnpm dev
```

メニューバーのアイコンをクリックしてポップアップを開き、**更新** ボタンで最新の使用状況を取得します。

### 初回セットアップ

1. Chrome で Claude / Codex にログイン
2. アプリを起動 — Chrome の Cookie が自動インポートされ、データが表示されます
3. セッションは再起動後も保持されます

> **ヒント:** データが表示されない場合は、ポップアップの **更新** ボタンを押してください。ログインボタンを押すと Chrome でログインページが開きます。

### ビルド

```bash
pnpm dist      # macOS 用の配布可能な .zip を生成
```

## 環境変数 / Configuration

| 環境変数 | 説明 |
|---|---|
| `USAGE_MONITOR_CLAUDE_URL` | Claude 使用状況ページの URL を上書き |
| `USAGE_MONITOR_CODEX_URL` | Codex 使用状況ページの URL を上書き |
| `USAGE_MONITOR_USER_DATA_DIR` | カスタム Electron ユーザーデータディレクトリ |

## Built with KingCoding

This app was built with [KingCoding](https://kingcode.shingoirie.com/) — an AI-powered coding assistant that lets you ship real apps fast.

## License

[MIT](LICENSE)
