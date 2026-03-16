const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatTrayTitle,
  isExpectedUsageLocation,
  looksLikeAuthPage,
  parseClaudeUsage,
  parseCodexUsage,
} = require("../src/parsers");

test("parseClaudeUsage extracts current and weekly usage blocks", () => {
  const items = parseClaudeUsage(`
    設定
    プラン使用制限
    現在のセッション
    4時間24分後にリセット
    6% 使用済み
    週間制限
    すべてのモデル
    9:00 (月)にリセット
    6% 使用済み
    Sonnetのみ
    9:00 (月)にリセット
    0% 使用済み
  `);

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.remainingPercent), [94, 94, 100]);
});

test("parseCodexUsage extracts remaining percentages from cards (multi-line format)", () => {
  const items = parseCodexUsage(`
    使用状況ダッシュボード
    残高
    5時間の使用制限
    92%
    残り
    リセット：17:16
    週あたりの使用制限
    61%
    残り
    リセット：2026/03/19 4:55
    GPT-5.3-Codex-Spark 5時間の使用制限
    100%
    残り
    GPT-5.3-Codex-Spark 週あたりの使用制限
    100%
    残り
    コードレビュー
    100%
    残り
  `);

  assert.equal(items.length, 5);
  assert.equal(items[0].label, "5時間の使用制限");
  assert.equal(items[0].remainingPercent, 92);
  assert.equal(items[1].remainingPercent, 61);
});

test("parseCodexUsage still works with single-line format", () => {
  const items = parseCodexUsage(`
    使用状況ダッシュボード
    残高
    5時間の使用制限
    97% 残り
    リセット: 17:16
    週あたりの使用制限
    62% 残り
    リセット: 2026/03/19 4:55
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].label, "5時間の使用制限");
  assert.equal(items[0].remainingPercent, 97);
  assert.equal(items[1].remainingPercent, 62);
});

test("looksLikeAuthPage detects login redirects", () => {
  assert.equal(looksLikeAuthPage("Log in to continue", "https://chatgpt.com/auth/login"), true);
  assert.equal(looksLikeAuthPage("使用状況ダッシュボード", "https://chatgpt.com/codex/settings/usage"), false);
});

test("isExpectedUsageLocation distinguishes redirected pages", () => {
  assert.equal(
    isExpectedUsageLocation("https://chatgpt.com/codex/settings/usage", "https://chatgpt.com/codex/settings/usage"),
    true,
  );
  assert.equal(
    isExpectedUsageLocation("https://chatgpt.com/", "https://chatgpt.com/codex/settings/usage"),
    false,
  );
});

test("formatTrayTitle prefers primary metrics", () => {
  const title = formatTrayTitle({
    providers: {
      claude: {
        status: "ok",
        items: [{ id: "current-session", remainingPercent: 94 }],
      },
      codex: {
        status: "ok",
        items: [{ id: "5-hours-of-usage-limit", remainingPercent: 97 }],
      },
    },
  });

  assert.equal(title, "C 94%  O 97%");
});
