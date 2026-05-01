const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
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
const {
  formatTrayTitle,
  isExpectedUsageLocation,
  looksLikeAuthPage,
  looksLikeChallengePage,
  mergeProviderState,
  parseClaudeUsage,
  parseCodexUsage,
} = require("./parsers");
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = !app.isPackaged;
const customUserDataDir = process.env.USAGE_MONITOR_USER_DATA_DIR;

if (customUserDataDir) {
  app.setPath("userData", customUserDataDir);
}

// --- Settings persistence ---
let cachedTrayMode = null;
let cachedAutoLaunch = null;

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function getTrayMode() {
  if (cachedTrayMode === null) {
    const settings = loadSettings();
    cachedTrayMode = settings.trayMode === "session" ? "session" : "weekly";
  }
  return cachedTrayMode;
}

function setTrayMode(mode) {
  const validated = mode === "session" ? "session" : "weekly";
  cachedTrayMode = validated;
  const settings = loadSettings();
  settings.trayMode = validated;
  saveSettings(settings);
}

function getAutoLaunchEnabled() {
  if (cachedAutoLaunch === null) {
    const settings = loadSettings();
    cachedAutoLaunch = settings.autoLaunch === false ? false : true;
  }
  return cachedAutoLaunch;
}

function getAutoLaunchOptions(enabled) {
  const options = { openAtLogin: enabled };
  if (process.platform === "darwin") {
    options.openAsHidden = enabled;
  }
  return options;
}

function applyAutoLaunchSetting(enabled = getAutoLaunchEnabled()) {
  if (isDev) {
    return false;
  }

  try {
    app.setLoginItemSettings(getAutoLaunchOptions(enabled));
    return true;
  } catch (error) {
    console.warn("Failed to update auto launch setting:", error);
    return false;
  }
}

function setAutoLaunchEnabled(enabled) {
  const validated = enabled !== false;
  cachedAutoLaunch = validated;
  const settings = loadSettings();
  settings.autoLaunch = validated;
  saveSettings(settings);
  applyAutoLaunchSetting(validated);
  return cachedAutoLaunch;
}

function getEnvValue(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
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

function formatResetTime(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `Resets: ${month}/${day} ${hours}:${minutes}`;
  } catch {
    return null;
  }
}

async function collectClaudeUsageViaApi(provider) {
  const ses = session.fromPartition(provider.partition);
  const origin = new URL(provider.url).origin;

  try {
    const orgsResponse = await ses.fetch(`${origin}/api/organizations`);

    if (!orgsResponse.ok) {
      if (orgsResponse.status === 401 || orgsResponse.status === 403) {
        return { status: "needs-auth", items: [], message: `${provider.label} needs login` };
      }

      return null;
    }

    const orgs = await orgsResponse.json();
    if (!Array.isArray(orgs) || orgs.length === 0) {
      return null;
    }

    const orgId = orgs[0].uuid;

    const usageResponse = await ses.fetch(`${origin}/api/organizations/${orgId}/usage`);
    if (!usageResponse.ok) {
      return null;
    }

    const usage = await usageResponse.json();
    const items = [];

    if (usage.five_hour && typeof usage.five_hour.utilization === "number") {
      items.push({
        id: "current-session",
        label: "Current session",
        usedPercent: usage.five_hour.utilization,
        remainingPercent: Math.max(0, 100 - usage.five_hour.utilization),
        resetText: formatResetTime(usage.five_hour.resets_at),
        detail: `${usage.five_hour.utilization}% used`,
      });
    }

    if (usage.seven_day && typeof usage.seven_day.utilization === "number") {
      items.push({
        id: "weekly-all-models",
        label: "All models",
        usedPercent: usage.seven_day.utilization,
        remainingPercent: Math.max(0, 100 - usage.seven_day.utilization),
        resetText: formatResetTime(usage.seven_day.resets_at),
        detail: `${usage.seven_day.utilization}% used`,
      });
    }

    if (usage.seven_day_sonnet && typeof usage.seven_day_sonnet.utilization === "number") {
      items.push({
        id: "weekly-sonnet",
        label: "Sonnet only",
        usedPercent: usage.seven_day_sonnet.utilization,
        remainingPercent: Math.max(0, 100 - usage.seven_day_sonnet.utilization),
        resetText: formatResetTime(usage.seven_day_sonnet.resets_at),
        detail: `${usage.seven_day_sonnet.utilization}% used`,
      });
    }

    if (items.length === 0) {
      return null;
    }

    return {
      status: "ok",
      items,
      message: `${provider.label} updated`,
    };
  } catch (error) {

    return null;
  }
}

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_HIDDEN_PAGE_LOAD_TIMEOUT_MS = 15 * 1000;
const DEFAULT_HIDDEN_SCRAPE_TIMEOUT_MS = 10 * 1000;
const HIDDEN_SCRAPE_POLL_MS = 500;
const HIDDEN_WINDOW_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const DEFAULT_CODEX_USAGE_URL = "https://chatgpt.com/codex/cloud/settings/analytics#usage";
const DEFAULT_CODEX_ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";
const CODEX_SETTINGS_ANALYTICS_URL = "https://chatgpt.com/codex/settings/analytics";
const CODEX_SETTINGS_ANALYTICS_USAGE_URL = "https://chatgpt.com/codex/settings/analytics#usage";
const LEGACY_CODEX_CLOUD_USAGE_URL = "https://chatgpt.com/codex/cloud/settings/usage";
const LEGACY_CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

const PROVIDERS = {
  claude: {
    id: "claude",
    label: "Claude",
    url: getEnvValue("USAGE_MONITOR_CLAUDE_URL") || "https://claude.ai/settings/usage",
    partition: "persist:usage-claude",
    chromeDomains: ["claude.ai"],
    parser: parseClaudeUsage,
  },
  codex: {
    id: "codex",
    label: "Codex",
    url: getEnvValue("USAGE_MONITOR_CODEX_URL") || DEFAULT_CODEX_USAGE_URL,
    acceptedUrls: [
      DEFAULT_CODEX_USAGE_URL,
      DEFAULT_CODEX_ANALYTICS_URL,
      CODEX_SETTINGS_ANALYTICS_URL,
      CODEX_SETTINGS_ANALYTICS_USAGE_URL,
      LEGACY_CODEX_CLOUD_USAGE_URL,
      LEGACY_CODEX_USAGE_URL,
    ],
    partition: "persist:usage-codex",
    chromeDomains: ["chatgpt.com", "openai.com"],
    pageLoadTimeoutMs: 30 * 1000,
    scrapeTimeoutMs: 45 * 1000,
    resetStorageBeforeRefresh: true,
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
  tray.setTitle(formatTrayTitle(state, getTrayMode()));
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
    height: 680,
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

  popupWindow.on("blur", () => {
    if (!isDev && popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
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
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.on("click", togglePopupWindow);
  tray.on("right-click", () => tray.popUpContextMenu(buildContextMenu()));
  updateTrayTitle();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProviderResult(status, provider, message, extras = {}) {
  return {
    status,
    items: [],
    message,
    ...extras,
  };
}

function createTaggedError(code, message, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

function withTimeout(taskFactory, timeoutMs, createTimeoutError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(createTimeoutError());
    }, timeoutMs);

    Promise.resolve()
      .then(taskFactory)
      .then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

async function capturePageSnapshot(hiddenWindow) {
  return hiddenWindow.webContents.executeJavaScript(`
    ({
      url: window.location.href,
      title: document.title,
      text: document.body ? document.body.innerText : ""
    })
  `);
}

async function clearProviderStorage(provider) {
  const targetSession = session.fromPartition(provider.partition);
  try {
    await targetSession.clearStorageData({
      storages: ["appcache", "cachestorage", "indexdb", "localstorage", "serviceworkers", "websql"],
      quotas: ["temporary", "syncable"],
    });
  } catch {}

  try {
    await targetSession.clearCache();
  } catch {}
}

function snapshotHasUsageContent(provider, snapshot) {
  if (!snapshot || !snapshot.text) {
    return false;
  }

  const waitForTexts = provider.waitForTexts || [];
  if (waitForTexts.length > 0 && !waitForTexts.some((text) => snapshot.text.includes(text))) {
    return false;
  }

  try {
    provider.parser(snapshot.text);
    return true;
  } catch {
    return false;
  }
}

async function waitForUsageSnapshot(hiddenWindow, provider) {
  let lastSnapshot = null;

  return withTimeout(
    async () => {
      while (true) {
        lastSnapshot = await capturePageSnapshot(hiddenWindow);

        if (
          looksLikeAuthPage(lastSnapshot.text, lastSnapshot.url)
          || snapshotHasUsageContent(provider, lastSnapshot)
        ) {
          return lastSnapshot;
        }

        await delay(HIDDEN_SCRAPE_POLL_MS);
      }
    },
    provider.scrapeTimeoutMs || DEFAULT_HIDDEN_SCRAPE_TIMEOUT_MS,
    () =>
      createTaggedError("timeout", `${provider.label} usage data timed out`, {
        pageUrl: lastSnapshot?.url || hiddenWindow.webContents.getURL() || provider.url,
        snapshot: lastSnapshot,
      }),
  );
}

function parseSnapshotItems(provider, snapshot) {
  if (!snapshot || !snapshot.text) {
    return null;
  }

  try {
    return provider.parser(snapshot.text);
  } catch {
    return null;
  }
}

function logProviderIssue(providerId, providerState) {
  if (providerState.status !== "error") {
    return;
  }

  console.warn(`[${providerId}] ${providerState.message}`, {
    errorCode: providerState.errorCode || null,
    pageUrl: providerState.pageUrl || null,
    diagnostic: providerState.diagnostic || null,
  });
}

function isExpectedProviderLocation(provider, currentUrl) {
  const expectedUrls = [provider.url, ...(provider.acceptedUrls || [])];
  return expectedUrls.some((expectedUrl) => isExpectedUsageLocation(currentUrl, expectedUrl));
}

async function collectUsage(provider) {
  const authSession = session.fromPartition(provider.partition);
  let hiddenWindow = null;

  try {
    hiddenWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: provider.partition,
      },
    });

    try {
      await withTimeout(
        () =>
          hiddenWindow.loadURL(provider.url, {
            userAgent: HIDDEN_WINDOW_USER_AGENT,
          }),
        provider.pageLoadTimeoutMs || DEFAULT_HIDDEN_PAGE_LOAD_TIMEOUT_MS,
        () =>
          createTaggedError("timeout", `${provider.label} usage page load timed out`, {
            pageUrl: hiddenWindow.webContents.getURL() || provider.url,
          }),
      );
    } catch (error) {
      const redirectedUrl = hiddenWindow.webContents.getURL() || provider.url;
      if (/ERR_ABORTED/i.test(error.message || "") || looksLikeAuthPage("", redirectedUrl)) {
        return createProviderResult("needs-auth", provider, `${provider.label} needs login`, {
          pageUrl: redirectedUrl,
          errorCode: "needs-auth",
        });
      }

      if (!isExpectedProviderLocation(provider, redirectedUrl)) {
        return createProviderResult("error", provider, `${provider.label} redirected away from usage page`, {
          pageUrl: redirectedUrl,
          errorCode: "redirect",
          diagnostic: error.message || null,
        });
      }

      if (error.code === "timeout") {
        return createProviderResult("error", provider, error.message, {
          pageUrl: redirectedUrl,
          errorCode: error.code,
        });
      }

      return createProviderResult("error", provider, `${provider.label} page load failed`, {
        pageUrl: redirectedUrl,
        errorCode: "load-failed",
        diagnostic: error.message || null,
      });
    }

    let snapshot = null;
    try {
      snapshot = await waitForUsageSnapshot(hiddenWindow, provider);
    } catch (error) {
      const finalSnapshot = error.snapshot || await capturePageSnapshot(hiddenWindow).catch(() => null);

      if (finalSnapshot && looksLikeAuthPage(finalSnapshot.text, finalSnapshot.url)) {
        return createProviderResult("needs-auth", provider, `${provider.label} needs login`, {
          pageUrl: finalSnapshot.url,
          errorCode: "needs-auth",
        });
      }

      if (finalSnapshot && looksLikeChallengePage(finalSnapshot.text, finalSnapshot.url)) {
        return createProviderResult("error", provider, `${provider.label} blocked by Cloudflare challenge`, {
          pageUrl: finalSnapshot.url,
          errorCode: "challenge",
          diagnostic: {
            title: finalSnapshot.title || "",
            preview: (finalSnapshot.text || "").replace(/\n/g, " ").substring(0, 120),
          },
        });
      }

      if (finalSnapshot && !isExpectedProviderLocation(provider, finalSnapshot.url)) {
        return createProviderResult("error", provider, `${provider.label} redirected away from usage page`, {
          pageUrl: finalSnapshot.url,
          errorCode: "redirect",
          diagnostic: {
            title: finalSnapshot.title || "",
            preview: (finalSnapshot.text || "").replace(/\n/g, " ").substring(0, 120),
          },
        });
      }

      return createProviderResult("error", provider, error.message || `${provider.label} usage data timed out`, {
        pageUrl:
          finalSnapshot?.url
          || error.pageUrl
          || hiddenWindow.webContents.getURL()
          || provider.url,
        errorCode: error.code || "timeout",
      });
    }

    if (looksLikeAuthPage(snapshot.text, snapshot.url)) {
      return createProviderResult("needs-auth", provider, `${provider.label} needs login`, {
        pageUrl: snapshot.url,
        errorCode: "needs-auth",
      });
    }

    const parsedItems = parseSnapshotItems(provider, snapshot);
    if (parsedItems) {
      return {
        status: "ok",
        items: parsedItems,
        message: `${provider.label} updated`,
        pageUrl: snapshot.url,
      };
    }

    if (!isExpectedProviderLocation(provider, snapshot.url)) {
      return createProviderResult("error", provider, `${provider.label} redirected away from usage page`, {
        pageUrl: snapshot.url,
        errorCode: "redirect",
      });
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
      return createProviderResult("error", provider, `${provider.label} usage data could not be parsed`, {
        pageUrl: snapshot.url,
        errorCode: "parse-failed",
        diagnostic: {
          parserMessage: parseError.message,
          preview,
          title: snapshot.title || "",
        },
      });
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

  const previousState = state.providers[providerId];

  setProviderState(providerId, mergeProviderState(previousState, {
    status: "loading",
    chromeConnected: previousState.chromeConnected,
    items: previousState.items,
    message: isManual ? "Refreshing..." : "Auto refreshing...",
  }));

  try {
    if (provider.resetStorageBeforeRefresh) {
      await clearProviderStorage(provider);
    }

    // Always import Chrome cookies first to ensure session is fresh
    await importChromeCookies(provider);

    let result = null;

    if (providerId === "claude") {
      // Claude: use direct API (no hidden BrowserWindow needed)
      result = await collectClaudeUsageViaApi(provider);
    } else {
      // Codex: use hidden BrowserWindow scraping
      result = await collectUsage(provider);
    }

    if (!result) {
      result =
        providerId === "claude"
        ? {
            status: "needs-auth",
            items: [],
            message: `Log in to ${provider.label} in Chrome, then refresh`,
          }
        : createProviderResult("error", provider, `${provider.label} refresh returned no data`, {
            errorCode: "empty-result",
          });
    }

    const nextState = mergeProviderState(previousState, {
      ...result,
      lastUpdatedAt: new Date().toISOString(),
    });
    setProviderState(providerId, nextState);
    logProviderIssue(providerId, nextState);
  } catch (error) {
    const nextState = mergeProviderState(previousState, {
      status: "error",
      items: [],
      message: error.message || `${provider.label} refresh failed`,
      errorCode: error.code || "refresh-failed",
      lastUpdatedAt: new Date().toISOString(),
    });
    setProviderState(providerId, nextState);
    logProviderIssue(providerId, nextState);
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
  // Open in user's Chrome so they can log in with their real session
  shell.openExternal(provider.url);
});
ipcMain.handle("open-external", (_event, providerId) => {
  const provider = PROVIDERS[providerId];
  if (provider) {
    shell.openExternal(provider.url);
  }
});

ipcMain.handle("get-tray-mode", () => getTrayMode());
ipcMain.handle("set-tray-mode", (_event, mode) => {
  setTrayMode(mode);
  updateTrayTitle();
  return mode;
});

ipcMain.handle("get-auto-launch", () => getAutoLaunchEnabled());
ipcMain.handle("set-auto-launch", (_event, enabled) => setAutoLaunchEnabled(enabled));

ipcMain.handle("quit-app", () => {
  app.quit();
});

app.whenReady().then(() => {
  app.setName("Usage Menubar");
  applyAutoLaunchSetting();
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
