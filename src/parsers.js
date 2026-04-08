const CLAUDE_LABELS = [
  {
    id: "current-session",
    match: /^(現在のセッション|current session)$/i,
    label: "Current session",
  },
  {
    id: "weekly-all-models",
    match: /^(すべてのモデル|all models)$/i,
    label: "All models",
  },
  {
    id: "weekly-sonnet",
    match: /sonnet/i,
    label: "Sonnet only",
  },
];

const CODEX_IGNORED_TITLES = [
  /^(使用状況ダッシュボード|usage dashboard)$/i,
  /^(残高|balance)$/i,
  /^(リセット|reset)/i,
  /^(クレジット|credits)/i,
];

function normalizeLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parsePercent(line) {
  const match = line.match(/(\d{1,3})\s*%/);
  return match ? Number(match[1]) : null;
}

function looksLikeReset(line) {
  return /(リセット|reset)/i.test(line);
}

function looksLikeAuthPage(text, url) {
  const authUrl = /(login|signin|sign-in|auth|oauth|accounts\.google|clerk\.|sso)/i.test(url || "");
  const authText =
    /(log in|sign in|sign up|continue with google|continue with github|continue with email|welcome back|create.*account|メールアドレス|メールで続行|ログイン|サインイン|page not found|ページが見つかりません)/i.test(
      text || "",
    );
  return authUrl || authText;
}

function isExpectedUsageLocation(currentUrl, expectedUrl) {
  try {
    const current = new URL(currentUrl);
    const expected = new URL(expectedUrl);
    return current.origin === expected.origin && current.pathname.startsWith(expected.pathname);
  } catch {
    return false;
  }
}

function findNearby(lines, startIndex, predicate, distance = 4) {
  for (let offset = 1; offset <= distance; offset += 1) {
    const line = lines[startIndex + offset];
    if (!line) {
      break;
    }
    if (predicate(line)) {
      return line;
    }
  }
  return null;
}

function parseClaudeUsage(text) {
  const lines = normalizeLines(text);
  const items = [];

  for (let index = 0; index < lines.length; index += 1) {
    const labelConfig = CLAUDE_LABELS.find((entry) => entry.match.test(lines[index]));
    if (!labelConfig) {
      continue;
    }

    const resetLine = findNearby(lines, index, looksLikeReset, 4);
    const percentLine = findNearby(lines, index, (line) => parsePercent(line) !== null, 5);
    const usedPercent = percentLine ? parsePercent(percentLine) : null;

    items.push({
      id: labelConfig.id,
      label: labelConfig.label,
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      resetText: resetLine,
      detail: percentLine || null,
    });
  }

  if (!items.length) {
    throw new Error("Claude usage blocks were not found");
  }

  return items;
}

function findCodexTitle(lines, percentIndex) {
  for (let index = percentIndex - 1; index >= Math.max(0, percentIndex - 3); index -= 1) {
    const line = lines[index];
    if (!line || parsePercent(line) !== null || looksLikeReset(line)) {
      continue;
    }
    if (CODEX_IGNORED_TITLES.some((pattern) => pattern.test(line))) {
      continue;
    }
    return line;
  }
  return null;
}

const CODEX_LABEL_MAP = [
  { match: /5時間の使用制限|5.?hour/i, label: "5-hour limit" },
  { match: /週あたりの使用制限|weekly/i, label: "Weekly limit" },
];

function normalizeCodexLabel(raw) {
  for (const entry of CODEX_LABEL_MAP) {
    if (entry.match.test(raw)) {
      return entry.label;
    }
  }

  const modelMatch = raw.match(/^([\w.-]+)\s+/);
  if (modelMatch) {
    const rest = raw.slice(modelMatch[0].length);
    for (const entry of CODEX_LABEL_MAP) {
      if (entry.match.test(rest)) {
        return `${modelMatch[1]} ${entry.label}`;
      }
    }
  }

  return raw;
}

function normalizeResetText(text) {
  if (!text) return null;
  return text.replace(/^リセット\s*[：:]\s*/i, "Resets: ");
}

function parseCodexUsage(text) {
  const lines = normalizeLines(text);
  const items = [];
  const seenTitles = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (parsePercent(line) === null) {
      continue;
    }
    // "残り"/"remaining" can be on the same line or the next line
    const remainingOnSameLine = /(残り|remaining)/i.test(line);
    const remainingOnNextLine =
      !remainingOnSameLine && index + 1 < lines.length && /^(残り|remaining)$/i.test(lines[index + 1]);
    if (!remainingOnSameLine && !remainingOnNextLine) {
      continue;
    }

    const title = findCodexTitle(lines, index);
    if (!title || seenTitles.has(title)) {
      continue;
    }

    const remainingPercent = parsePercent(line);
    const resetText = normalizeResetText(
      findNearby(lines, remainingOnNextLine ? index + 1 : index, looksLikeReset, 2),
    );
    seenTitles.add(title);
    const label = normalizeCodexLabel(title);

    items.push({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      label,
      remainingPercent,
      usedPercent: remainingPercent === null ? null : Math.max(0, 100 - remainingPercent),
      resetText,
      detail: line,
    });
  }

  if (!items.length) {
    throw new Error("Codex usage cards were not found");
  }

  return items;
}

function getPrimaryMetric(items, preferredIds) {
  for (const id of preferredIds) {
    const match = items.find(
      (item) => item.id === id || item.id.includes(id) || (item.label && item.label.includes(id)),
    );
    if (match && typeof match.remainingPercent === "number") {
      return match.remainingPercent;
    }
  }
  const fallback = items.find((item) => typeof item.remainingPercent === "number");
  return fallback ? fallback.remainingPercent : null;
}

function getProviderDisplayMetric(providerState, preferredIds) {
  if (!providerState || providerState.status === "idle") {
    return null;
  }

  return getPrimaryMetric(providerState.items || [], preferredIds);
}

function formatTrayTitle(state, mode = "weekly") {
  const claude = state.providers.claude || {};
  const codex = state.providers.codex || {};

  const claudeRemaining =
    mode === "session"
      ? getProviderDisplayMetric(claude, ["current-session", "weekly-all-models"])
      : getProviderDisplayMetric(claude, ["weekly-all-models", "current-session"]);
  const codexRemaining =
    mode === "session"
      ? getProviderDisplayMetric(codex, ["5時間", "5h", "5-hour", "5 hour"])
      : getProviderDisplayMetric(codex, ["週あたり", "weekly", "5時間", "5h", "5-hour", "5 hour"]);

  const parts = [];
  parts.push(`C ${claudeRemaining === null ? "--" : `${claudeRemaining}%`}`);
  parts.push(`O ${codexRemaining === null ? "--" : `${codexRemaining}%`}`);
  return parts.join("  ");
}

function mergeProviderState(previousState, nextState) {
  const normalizedNext = {
    ...nextState,
    items: Array.isArray(nextState?.items) ? nextState.items : [],
  };
  const previousItems = Array.isArray(previousState?.items) ? previousState.items : [];

  if (
    normalizedNext.items.length === 0
    && previousItems.length > 0
    && ["loading", "error", "needs-auth"].includes(normalizedNext.status)
  ) {
    return {
      ...normalizedNext,
      items: previousItems,
      stale: true,
    };
  }

  return {
    ...normalizedNext,
    stale: false,
  };
}

module.exports = {
  formatTrayTitle,
  isExpectedUsageLocation,
  looksLikeAuthPage,
  mergeProviderState,
  parseClaudeUsage,
  parseCodexUsage,
};
