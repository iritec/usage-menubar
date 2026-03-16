const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  session,
} = require("electron");
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = !app.isPackaged;
const customUserDataDir = process.env.USAGE_MONITOR_USER_DATA_DIR;

if (customUserDataDir) {
  app.setPath("userData", customUserDataDir);
}

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

function getEnvValue(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
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
    const resetText = findNearby(lines, remainingOnNextLine ? index + 1 : index, looksLikeReset, 2);
    seenTitles.add(title);

    items.push({
      id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      label: title,
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
    const match = items.find((item) => item.id === id);
    if (match && typeof match.remainingPercent === "number") {
      return match.remainingPercent;
    }
  }
  const fallback = items.find((item) => typeof item.remainingPercent === "number");
  return fallback ? fallback.remainingPercent : null;
}

function formatTrayTitle(currentState) {
  const claude = currentState.providers.claude;
  const codex = currentState.providers.codex;

  const claudeRemaining =
    claude.status === "ok"
      ? getPrimaryMetric(claude.items, ["current-session", "weekly-all-models"])
      : null;
  const codexRemaining =
    codex.status === "ok"
      ? getPrimaryMetric(codex.items, ["5h", "5-hours", "5", "5hour", "5-hours-of-usage-limit"])
      : null;

  const parts = [];
  parts.push(`C ${claudeRemaining === null ? "--" : `${claudeRemaining}%`}`);
  parts.push(`O ${codexRemaining === null ? "--" : `${codexRemaining}%`}`);
  return parts.join("  ");
}

function getChromeProfileDirs() {
  const chromeRoot = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  if (!fs.existsSync(chromeRoot)) {
    return [];
  }

  return fs
    .readdirSync(chromeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile ")))
    .map((entry) => path.join(chromeRoot, entry.name));
}

function queryChromeCookies(cookieDbPath, domains) {
  const script = `
import base64, json, os, shutil, sqlite3, sys, tempfile

cookie_path = sys.argv[1]
domains = json.loads(sys.argv[2])
fd, temp_path = tempfile.mkstemp(suffix=".sqlite")
os.close(fd)
shutil.copy2(cookie_path, temp_path)

try:
    conn = sqlite3.connect(temp_path)
    conn.row_factory = sqlite3.Row
    where = " OR ".join(["host_key LIKE ?"] * len(domains))
    sql = f"SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value FROM cookies WHERE {where}"
    params = [f"%{domain}%" for domain in domains]
    rows = []
    for row in conn.execute(sql, params):
        rows.append({
            "host_key": row["host_key"],
            "name": row["name"],
            "value": row["value"],
            "path": row["path"],
            "expires_utc": row["expires_utc"],
            "is_secure": row["is_secure"],
            "is_httponly": row["is_httponly"],
            "samesite": row["samesite"],
            "encrypted_value_b64": base64.b64encode(row["encrypted_value"] or b"").decode(),
        })
    print(json.dumps(rows))
finally:
    try:
        conn.close()
    except Exception:
        pass
    os.remove(temp_path)
`;

  const output = execFileSync("python3", ["-c", script, cookieDbPath, JSON.stringify(domains)], {
    encoding: "utf8",
  }).trim();

  return output ? JSON.parse(output) : [];
}

function getChromeSafeStorageKey() {
  const password = execFileSync("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], {
    encoding: "utf8",
  }).trim();
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function decryptChromeCookie(row, key) {
  if (row.value) {
    return row.value;
  }

  const encrypted = Buffer.from(row.encrypted_value_b64 || "", "base64");
  if (!encrypted.length) {
    return "";
  }

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix === "v10" || prefix === "v11") {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const domainHash = crypto.createHash("sha256").update(row.host_key).digest();
    if (decrypted.length > 32 && decrypted.subarray(0, 32).equals(domainHash)) {
      return decrypted.subarray(32).toString("utf8");
    }
    return decrypted.toString("utf8");
  }

  return encrypted.toString("utf8");
}

function chromeSameSiteToElectron(value) {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

function chromeExpiresToUnixSeconds(value) {
  if (!value || value <= 0) {
    return undefined;
  }
  const seconds = value / 1000000 - 11644473600;
  return seconds > 0 ? seconds : undefined;
}

function cookieMatchesDomains(domain, domains) {
  const normalized = domain.replace(/^\./, "");
  return domains.some((target) => normalized === target || normalized.endsWith(`.${target}`));
}

function toCookieUrl(domain, cookiePath, secure) {
  const normalizedDomain = domain.replace(/^\./, "");
  const normalizedPath = cookiePath && cookiePath.startsWith("/") ? cookiePath : "/";
  return `${secure ? "https" : "http"}://${normalizedDomain}${normalizedPath}`;
}

async function clearProviderCookies(targetSession, domains) {
  const existing = await targetSession.cookies.get({});
  for (const cookie of existing) {
    if (!cookieMatchesDomains(cookie.domain, domains)) {
      continue;
    }
    try {
      await targetSession.cookies.remove(toCookieUrl(cookie.domain, cookie.path, cookie.secure), cookie.name);
    } catch {}
  }
}

async function importChromeCookies(provider) {
  try {
    const key = getChromeSafeStorageKey();
    const profiles = getChromeProfileDirs();
    const matches = [];

    for (const profilePath of profiles) {
      const cookieDbPath = path.join(profilePath, "Cookies");
      if (!fs.existsSync(cookieDbPath)) {
        continue;
      }
      try {
        const cookies = queryChromeCookies(cookieDbPath, provider.chromeDomains)
          .map((row) => ({
            ...row,
            decryptedValue: decryptChromeCookie(row, key),
            profilePath,
          }))
          .filter((row) => row.decryptedValue);
        if (cookies.length) {
          matches.push({ profilePath, cookies });
        }
      } catch {}
    }

    matches.sort((left, right) => right.cookies.length - left.cookies.length);
    const best = matches[0];
    if (!best) {
      return { importedCount: 0, profilePath: null };
    }

    const targetSession = session.fromPartition(provider.partition);
    await clearProviderCookies(targetSession, provider.chromeDomains);

    let importedCount = 0;
    for (const row of best.cookies) {
      try {
        await targetSession.cookies.set({
          url: toCookieUrl(row.host_key, row.path, !!row.is_secure),
          name: row.name,
          value: row.decryptedValue,
          domain: row.host_key,
          path: row.path || "/",
          secure: !!row.is_secure,
          httpOnly: !!row.is_httponly,
          sameSite: chromeSameSiteToElectron(row.samesite),
          expirationDate: chromeExpiresToUnixSeconds(row.expires_utc),
        });
        importedCount += 1;
      } catch {}
    }

    return { importedCount, profilePath: best.profilePath };
  } catch {
    return { importedCount: 0, profilePath: null };
  }
}

function getChromeDevToolsActivePortPath() {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort");
}

function getChromeDevToolsSocketEndpoint() {
  const activePortPath = getChromeDevToolsActivePortPath();
  if (!fs.existsSync(activePortPath)) {
    return null;
  }

  try {
    const [port, wsPath] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
    return /^\d+$/.test(port) && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null;
  } catch {
    return null;
  }
}

function hasChromeDebugTarget() {
  return Boolean(
    getEnvValue("USAGE_MONITOR_CHROME_WS_ENDPOINT") ||
      getEnvValue("USAGE_MONITOR_CHROME_BROWSER_URL") ||
      getChromeDevToolsSocketEndpoint(),
  );
}

function getChromeMcpStrategies() {
  const wsEndpoint = getEnvValue("USAGE_MONITOR_CHROME_WS_ENDPOINT");
  const debugSocketEndpoint = getChromeDevToolsSocketEndpoint();
  const browserUrl = getEnvValue("USAGE_MONITOR_CHROME_BROWSER_URL");
  const strategies = [];

  if (wsEndpoint) {
    strategies.push({
      label: "explicit-ws-endpoint",
      args: [`--wsEndpoint=${wsEndpoint}`],
    });
  }

  strategies.push({
    label: "auto-connect",
    args: ["--autoConnect"],
  });

  if (debugSocketEndpoint) {
    strategies.push({
      label: "devtools-active-port",
      args: [`--wsEndpoint=${debugSocketEndpoint}`],
    });
  }

  if (browserUrl) {
    strategies.push({
      label: "explicit-browser-url",
      args: [`--browserUrl=${browserUrl}`],
    });
  }

  return strategies;
}

function getChromeDevtoolsMcpCliPath() {
  const entryPath = require.resolve("chrome-devtools-mcp");
  return path.join(path.dirname(entryPath), "bin", "chrome-devtools-mcp.js");
}

function extractToolText(result) {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function extractJsonFromToolText(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function getSelectedPageId(text) {
  const match = text.match(/^\s*(\d+):.*\[selected\]\s*$/m);
  return match ? Number(match[1]) : null;
}

function isChromeUnavailableResult(result) {
  const text = extractToolText(result);
  return Boolean(result?.isError) && /could not connect to chrome|devtoolsactiveport|check if chrome is running/i.test(text);
}

async function callChromeTool(client, name, args, timeoutMs = 15000) {
  return Promise.race([
    client.callTool({ name, arguments: args }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function createChromeMcpContext() {
  const cliPath = getChromeDevtoolsMcpCliPath();
  const chromeDebugTargetDetected = hasChromeDebugTarget();

  for (const strategy of getChromeMcpStrategies()) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, ...strategy.args, "--no-usage-statistics"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      },
      stderr: "pipe",
    });

    let stderr = "";
    if (transport.stderr) {
      transport.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    try {
      const client = new Client({ name: "usage-menubar", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);

      const probeResult = await callChromeTool(client, "list_pages", {}, 8000);
      if (isChromeUnavailableResult(probeResult)) {
        await transport.close();
        continue;
      }

      return {
        client,
        transport,
        strategy: strategy.label,
        stderr,
      };
    } catch {
      await transport.close().catch(() => {});
    }
  }

  return {
    context: null,
    chromeDebugTargetDetected,
  };
}

async function closeChromeMcpContext(context) {
  if (!context?.transport) {
    return;
  }
  await context.transport.close().catch(() => {});
}

async function collectUsageFromChrome(provider, chromeContext) {
  if (!chromeContext?.client) {
    return null;
  }

  let pageId = null;
  try {
    const openResult = await callChromeTool(
      chromeContext.client,
      "new_page",
      { url: provider.url, timeout: 15000 },
      20000,
    );
    if (openResult?.isError) {
      if (isChromeUnavailableResult(openResult)) {
        return null;
      }

      return {
        status: "error",
        chromeConnected: false,
        items: [],
        message: extractToolText(openResult) || `${provider.label} refresh failed`,
      };
    }

    pageId = getSelectedPageId(extractToolText(openResult));

    if (provider.waitForTexts?.length) {
      await callChromeTool(
        chromeContext.client,
        "wait_for",
        { text: provider.waitForTexts, timeout: 6000 },
        7000,
      ).catch(() => {});
    }

    const evaluateResult = await callChromeTool(
      chromeContext.client,
      "evaluate_script",
      {
        function: `() => ({
          url: window.location.href,
          title: document.title,
          text: document.body ? document.body.innerText : ""
        })`,
      },
      10000,
    );
    const snapshot = extractJsonFromToolText(extractToolText(evaluateResult));

    if (!snapshot) {
      return {
        status: "error",
        chromeConnected: false,
        items: [],
        message: `${provider.label} response could not be read from Chrome`,
      };
    }

    if (looksLikeAuthPage(snapshot.text, snapshot.url)) {
      return {
        status: "needs-auth",
        chromeConnected: false,
        items: [],
        message: `${provider.label} needs login in Chrome`,
        pageUrl: snapshot.url,
      };
    }

    try {
      const items = provider.parser(snapshot.text);
      return {
        status: "ok",
        chromeConnected: true,
        items,
        message: `${provider.label} updated from Chrome`,
        pageUrl: snapshot.url,
      };
    } catch (error) {
      return {
        status: "error",
        chromeConnected: true,
        items: [],
        message: error.message || `${provider.label} refresh failed`,
        pageUrl: snapshot.url,
      };
    }
  } finally {
    if (pageId !== null) {
      await callChromeTool(chromeContext.client, "close_page", { pageId }, 5000).catch(() => {});
    }
  }
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const HIDDEN_SCRAPE_DELAY_MS = 3500;

const PROVIDERS = {
  claude: {
    id: "claude",
    label: "Claude",
    url: getEnvValue("USAGE_MONITOR_CLAUDE_URL") || "https://claude.ai/settings/usage",
    partition: "persist:usage-claude",
    chromeDomains: ["claude.ai"],
    waitForTexts: ["現在のセッション", "Current session", "週間制限", "プラン使用制限"],
    parser: parseClaudeUsage,
  },
  codex: {
    id: "codex",
    label: "Codex",
    url: getEnvValue("USAGE_MONITOR_CODEX_URL") || "https://chatgpt.com/codex/settings/usage",
    partition: "persist:usage-codex",
    chromeDomains: ["chatgpt.com", "openai.com"],
    waitForTexts: ["使用状況ダッシュボード", "Usage dashboard", "残高", "Balance"],
    parser: parseCodexUsage,
  },
};

const state = {
  isRefreshing: false,
  lastUpdatedAt: null,
  providers: {
    claude: {
      status: "idle",
      chromeConnected: false,
      items: [],
      message: "Not loaded yet",
      lastUpdatedAt: null,
    },
    codex: {
      status: "idle",
      chromeConnected: false,
      items: [],
      message: "Not loaded yet",
      lastUpdatedAt: null,
    },
  },
};

let tray = null;
let popupWindow = null;
let refreshTimer = null;

function createTrayIcon() {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="10" width="3" height="6" rx="1" fill="black" />
      <rect x="7.5" y="6" width="3" height="10" rx="1" fill="black" />
      <rect x="13" y="3" width="3" height="13" rx="1" fill="black" />
    </svg>
  `;
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  icon.setTemplateImage(true);
  return icon;
}

function cloneState() {
  return JSON.parse(JSON.stringify(state));
}

function broadcastState() {
  if (!popupWindow || popupWindow.isDestroyed()) {
    return;
  }
  popupWindow.webContents.send("state-updated", cloneState());
}

function updateTrayTitle() {
  if (!tray) {
    return;
  }
  tray.setTitle(formatTrayTitle(state));
  tray.setToolTip("Claude / Codex usage");
}

function setProviderState(providerId, nextState) {
  state.providers[providerId] = {
    ...state.providers[providerId],
    ...nextState,
  };
  state.lastUpdatedAt = new Date().toISOString();
  updateTrayTitle();
  broadcastState();
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 420,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    vibrancy: "menu",
    backgroundColor: "#111827",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (rendererUrl) {
    popupWindow.loadURL(rendererUrl);
  } else {
    popupWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function getPopupPosition() {
  const trayBounds = tray.getBounds();
  const windowBounds = popupWindow.getBounds();

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 8);
  return { x, y };
}

function togglePopupWindow() {
  if (!popupWindow) {
    return;
  }

  if (popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }

  const { x, y } = getPopupPosition();
  popupWindow.setPosition(x, y, false);
  popupWindow.show();
  popupWindow.focus();
  refreshAll(false);
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Refresh",
      click: () => refreshAll(true),
    },
    {
      label: "Open Claude Usage",
      click: () => shell.openExternal(PROVIDERS.claude.url),
    },
    {
      label: "Open Codex Usage",
      click: () => shell.openExternal(PROVIDERS.codex.url),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setContextMenu(buildContextMenu());
  tray.on("click", togglePopupWindow);
  tray.on("right-click", () => tray.popUpContextMenu(buildContextMenu()));
  updateTrayTitle();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectUsage(provider) {
  const authSession = session.fromPartition(provider.partition);
  let hiddenWindow = null;

  try {
    hiddenWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: provider.partition,
        sandbox: true,
      },
    });

    try {
      await hiddenWindow.loadURL(provider.url, {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      });
    } catch (error) {
      const redirectedUrl = hiddenWindow.webContents.getURL();
      if (
        /ERR_ABORTED/i.test(error.message || "") ||
        !isExpectedUsageLocation(redirectedUrl, provider.url) ||
        looksLikeAuthPage("", redirectedUrl)
      ) {
        return {
          status: "needs-auth",
          items: [],
          message: `${provider.label} needs login`,
          pageUrl: redirectedUrl,
        };
      }
      throw error;
    }

    await delay(HIDDEN_SCRAPE_DELAY_MS);

    const snapshot = await hiddenWindow.webContents.executeJavaScript(`
      ({
        url: window.location.href,
        title: document.title,
        text: document.body ? document.body.innerText : ""
      })
    `);


    if (looksLikeAuthPage(snapshot.text, snapshot.url)) {
      return {
        status: "needs-auth",
        items: [],
        message: `${provider.label} needs login`,
        pageUrl: snapshot.url,
      };
    }

    if (!isExpectedUsageLocation(snapshot.url, provider.url)) {
      return {
        status: "needs-auth",
        items: [],
        message: `${provider.label} redirected to ${snapshot.url}`,
        pageUrl: snapshot.url,
      };
    }

    try {
      const items = provider.parser(snapshot.text);
      return {
        status: "ok",
        items,
        message: `${provider.label} updated`,
        pageUrl: snapshot.url,
      };
    } catch (parseError) {
      const preview = (snapshot.text || "").replace(/\n/g, " ").substring(0, 120);
      return {
        status: "error",
        items: [],
        message: `${parseError.message} (url: ${snapshot.url}, text: ${preview}...)`,
        pageUrl: snapshot.url,
      };
    }
  } finally {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.destroy();
    }
    await authSession.flushStorageData();
  }
}

async function refreshProvider(providerId, isManual = false) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return;
  }

  setProviderState(providerId, {
    status: "loading",
    chromeConnected: state.providers[providerId].chromeConnected,
    items: state.providers[providerId].items,
    message: isManual ? "Refreshing..." : "Auto refreshing...",
  });

  try {
    let result = await collectUsage(provider);

    // Try cookie import as fallback
    if (result.status !== "ok") {
      const imported = await importChromeCookies(provider);
      if (imported.importedCount > 0) {
        const retryResult = await collectUsage(provider);
        if (retryResult.status === "ok") {
          retryResult.message = `${provider.label} updated from Chrome`;
          result = retryResult;
        } else if (retryResult.status === "needs-auth") {
          retryResult.status = "browser-auth";
          retryResult.message = `${provider.label} is already logged in on Chrome`;
          result = retryResult;
        }
      }
    }

    // If still not ok, prompt user to log in via the app
    if (result.status !== "ok" && result.status !== "needs-auth") {
      result = {
        status: "needs-auth",
        items: [],
        message: `${provider.label} needs login — click Login below`,
      };
    }

    setProviderState(providerId, {
      ...result,
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    setProviderState(providerId, {
      status: "error",
      items: [],
      message: error.message || `${provider.label} refresh failed`,
      lastUpdatedAt: new Date().toISOString(),
    });
  }
}

async function refreshAll(isManual = false) {
  if (state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  broadcastState();

  try {
    await refreshProvider("claude", isManual);
    await refreshProvider("codex", isManual);
  } finally {
    state.isRefreshing = false;
    state.lastUpdatedAt = new Date().toISOString();
    updateTrayTitle();
    broadcastState();
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    refreshAll(false);
  }, REFRESH_INTERVAL_MS);
}

ipcMain.handle("get-state", () => cloneState());
ipcMain.handle("refresh-all", () => refreshAll(true));
ipcMain.handle("open-login", (_event, providerId) => {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return;
  }

  const loginWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: `Login - ${provider.label}`,
    webPreferences: {
      partition: provider.partition,
      sandbox: true,
    },
  });

  loginWindow.loadURL(provider.url, {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  });

  loginWindow.webContents.on("did-navigate", (_event, url) => {
    if (isExpectedUsageLocation(url, provider.url)) {
      setTimeout(() => {
        loginWindow.close();
        refreshAll(true);
      }, 2000);
    }
  });
});
ipcMain.handle("open-external", (_event, providerId) => {
  const provider = PROVIDERS[providerId];
  if (provider) {
    shell.openExternal(provider.url);
  }
});

app.whenReady().then(() => {
  app.setName("Usage Menubar");
  if (!isDev && app.dock && typeof app.dock.hide === "function") {
    app.dock.hide();
  }
  if (isDev && app.dock && typeof app.dock.show === "function") {
    app.dock.show();
  }

  createPopupWindow();
  createTray();
  if (isDev) {
    popupWindow.center();
    popupWindow.show();
    popupWindow.focus();
  }
  scheduleRefresh();
  refreshAll(false);
});

app.on("activate", () => {
  if (!popupWindow) {
    createPopupWindow();
  }
});

app.on("before-quit", () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
