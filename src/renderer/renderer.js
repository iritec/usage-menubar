const providersRoot = document.getElementById("providers");
const providerTemplate = document.getElementById("provider-template");
const itemTemplate = document.getElementById("item-template");
const loadingSkeleton = document.getElementById("loading-skeleton");
const lastUpdated = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const trayModeToggle = document.getElementById("tray-mode-toggle");

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

function getProgressColorClass(percent) {
  if (typeof percent !== "number") return "";
  if (percent <= 20) return "progress-fill--bad";
  if (percent <= 50) return "progress-fill--warn";
  return "";
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
  fragment.querySelector(".provider-message").textContent = provider.message || "";

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
      empty.innerHTML =
        '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
        + '<span>Log in via Chrome, then press Refresh</span>';
    } else {
      empty.innerHTML =
        '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>'
        + '<span>No usage data yet</span>';
    }
    itemList.appendChild(empty);
  }

  const loginButton = fragment.querySelector(".login-button");
  if (provider.status === "needs-auth" || provider.status === "error") {
    loginButton.textContent = "Login in Chrome";
    loginButton.addEventListener("click", () => {
      window.usageMonitor.openLogin(providerId);
    });
  } else {
    loginButton.remove();
  }

  fragment.querySelector(".open-button").addEventListener("click", () => {
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

document.getElementById("quit-button").addEventListener("click", () => {
  window.usageMonitor.quit();
});

// Tray mode toggle
function setToggleActive(mode) {
  trayModeToggle.querySelectorAll(".toggle-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

trayModeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".toggle-option");
  if (!btn) return;
  const mode = btn.dataset.mode;
  setToggleActive(mode);
  window.usageMonitor.setTrayMode(mode);
});

// Initialize tray mode toggle
window.usageMonitor.getTrayMode().then(setToggleActive);

window.usageMonitor.getState().then(render);
window.usageMonitor.onStateUpdated(render);
