import { getProviderActionLabels } from "./provider-actions.mjs";

const providersRoot = document.getElementById("providers");
const providerTemplate = document.getElementById("provider-template");
const itemTemplate = document.getElementById("item-template");
const loadingSkeleton = document.getElementById("loading-skeleton");
const lastUpdated = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const updateButton = document.getElementById("update-button");
const updateStatus = document.getElementById("update-status");
const trayModeToggle = document.getElementById("tray-mode-toggle");
const autoLaunchToggle = document.getElementById("auto-launch-toggle");

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatStatus(status) {
  switch (status) {
    case "ok":
      return "Synced";
    case "loading":
      return "Refreshing";
    case "needs-auth":
      return "Login required";
    case "browser-auth":
      return "Chrome connected";
    case "error":
      return "Update failed";
    default:
      return "Not loaded";
  }
}

function setButtonContent(button, iconPath, label) {
  button.innerHTML =
    `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + iconPath
    + "</svg>"
    + `<span>${label}</span>`;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function getProgressColorClass(percent) {
  if (typeof percent !== "number") return "";
  if (percent <= 20) return "progress-fill--bad";
  if (percent <= 50) return "progress-fill--warn";
  return "";
}

function formatDiagnosticMessage(provider) {
  const snapshot = provider.diagnostic?.snapshot;
  if (!snapshot) {
    return "";
  }

  const bits = [];
  if (snapshot.url) {
    bits.push(`URL: ${snapshot.url}`);
  }
  if (snapshot.title) {
    bits.push(`Title: ${snapshot.title}`);
  }
  if (snapshot.textLength) {
    bits.push(`Text: ${snapshot.textLength} chars`);
  }
  return bits.length ? ` ${bits.join(" | ")}` : "";
}

function renderUsageItem(item) {
  const fragment = itemTemplate.content.cloneNode(true);
  fragment.querySelector(".usage-label").textContent = item.label;
  fragment.querySelector(".usage-percent").textContent =
    typeof item.remainingPercent === "number" ? `${item.remainingPercent}% left` : "N/A";
  fragment.querySelector(".usage-reset").textContent = item.resetText || item.detail || "";
  const fill = fragment.querySelector(".progress-fill");
  fill.style.width =
    typeof item.remainingPercent === "number" ? `${item.remainingPercent}%` : "0%";
  const colorClass = getProgressColorClass(item.remainingPercent);
  if (colorClass) fill.classList.add(colorClass);
  return fragment;
}

function renderProvider(providerId, provider) {
  const fragment = providerTemplate.content.cloneNode(true);
  const root = fragment.querySelector(".provider-card");
  root.dataset.status = provider.status;
  fragment.querySelector(".provider-name").textContent =
    providerId === "claude" ? "Claude" : "Codex";
  fragment.querySelector(".provider-status").textContent = formatStatus(provider.status);
  const providerMessage = provider.stale && provider.items.length
    ? `${provider.message || ""} Showing last successful snapshot.`.trim()
    : `${provider.message || ""}${provider.status === "error" ? formatDiagnosticMessage(provider) : ""}`.trim();
  fragment.querySelector(".provider-message").textContent = providerMessage;
  const actionLabels = getProviderActionLabels(providerId, provider);

  const itemList = fragment.querySelector(".item-list");
  if (provider.items.length) {
    provider.items.forEach((item) => itemList.appendChild(renderUsageItem(item)));
  } else if (provider.status === "loading" || provider.status === "idle") {
    const shimmer = document.createElement("div");
    shimmer.className = "item-shimmer";
    shimmer.innerHTML =
      '<div class="skeleton-line skeleton-short"></div>'
      + '<div class="skeleton-bar"></div>'
      + '<div class="skeleton-line skeleton-short"></div>'
      + '<div class="skeleton-bar"></div>';
    itemList.appendChild(shimmer);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    if (provider.status === "needs-auth") {
      const loginHint = "Log in in Chrome, then return here";
      empty.innerHTML =
        '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
        + `<span>${loginHint}</span>`;
    } else {
      empty.innerHTML =
        '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>'
        + '<span>No usage data yet</span>';
    }
    itemList.appendChild(empty);
  }

  const loginButton = fragment.querySelector(".login-button");
  if (actionLabels.includes("Login")) {
    setButtonContent(loginButton, '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>', "Login");
    loginButton.addEventListener("click", () => {
      window.usageMonitor.openLogin(providerId);
    });
  } else {
    loginButton.remove();
  }

  if (actionLabels.includes("Logout")) {
    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.className = "ghost-button logout-button";
    setButtonContent(logoutButton, '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>', "Logout");
    logoutButton.addEventListener("click", async () => {
      logoutButton.disabled = true;
      logoutButton.textContent = "Logging out…";
      await window.usageMonitor.logoutProvider(providerId);
    });
    fragment.querySelector(".provider-actions").prepend(logoutButton);
  }

  const openButton = fragment.querySelector(".open-button");
  setButtonContent(openButton, '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', "Open");
  openButton.addEventListener("click", () => {
    window.usageMonitor.openExternal(providerId);
  });

  return fragment;
}

function render(state) {
  // Keep skeleton visible until we have real provider data
  const hasAnyData = Object.values(state.providers).some(
    (p) => p.status !== "idle" && p.status !== "loading",
  );
  if (hasAnyData || state.lastUpdatedAt) {
    loadingSkeleton.classList.add("hidden");
  }

  lastUpdated.textContent = state.lastUpdatedAt
    ? `Last updated: ${formatTimestamp(state.lastUpdatedAt)}`
    : "Loading…";

  refreshButton.textContent = state.isRefreshing ? "Refreshing…" : "Refresh";
  refreshButton.disabled = !!state.isRefreshing;

  if (state.update) {
    updateButton.textContent = state.update.actionLabel || "Update";
    updateButton.disabled = !!state.update.actionDisabled;
    updateStatus.textContent = state.update.message || "";
    updateStatus.dataset.status = state.update.status || "idle";
  }

  providersRoot.innerHTML = "";
  Object.entries(state.providers).forEach(([providerId, provider]) => {
    providersRoot.appendChild(renderProvider(providerId, provider));
  });
}

refreshButton.addEventListener("click", () => {
  refreshButton.textContent = "Refreshing…";
  refreshButton.disabled = true;
  window.usageMonitor.refreshAll();
});

updateButton.addEventListener("click", async () => {
  updateButton.disabled = true;
  const state = await window.usageMonitor.getState();
  if (state.update?.status === "downloaded") {
    await window.usageMonitor.installUpdate();
    return;
  }
  await window.usageMonitor.checkForUpdates();
});

document.getElementById("quit-button").addEventListener("click", () => {
  window.usageMonitor.quit();
});

// Tray mode toggle
function setToggleActive(mode) {
  trayModeToggle.querySelectorAll(".toggle-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

function setAutoLaunchActive(enabled) {
  const mode = enabled ? "on" : "off";
  autoLaunchToggle.querySelectorAll(".toggle-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.autoLaunch === mode);
  });
}

trayModeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".toggle-option");
  if (!btn) return;
  const mode = btn.dataset.mode;
  setToggleActive(mode);
  window.usageMonitor.setTrayMode(mode);
});

autoLaunchToggle.addEventListener("click", async (e) => {
  const btn = e.target.closest(".toggle-option");
  if (!btn) return;
  const enabled = btn.dataset.autoLaunch === "on";
  setAutoLaunchActive(enabled);
  const saved = await window.usageMonitor.setAutoLaunch(enabled);
  setAutoLaunchActive(saved);
});

// Initialize tray mode toggle
window.usageMonitor.getTrayMode().then(setToggleActive);
window.usageMonitor.getAutoLaunch().then(setAutoLaunchActive);

window.usageMonitor.getState().then(render);
window.usageMonitor.onStateUpdated(render);
