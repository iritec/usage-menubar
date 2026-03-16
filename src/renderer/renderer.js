const providersRoot = document.getElementById("providers");
const providerTemplate = document.getElementById("provider-template");
const itemTemplate = document.getElementById("item-template");
const loadingSkeleton = document.getElementById("loading-skeleton");
const lastUpdated = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");

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
      return "Refresh failed";
    default:
      return "Idle";
  }
}

function renderUsageItem(item) {
  const fragment = itemTemplate.content.cloneNode(true);
  fragment.querySelector(".usage-label").textContent = item.label;
  fragment.querySelector(".usage-percent").textContent =
    typeof item.remainingPercent === "number" ? `${item.remainingPercent}% left` : "N/A";
  fragment.querySelector(".usage-reset").textContent = item.resetText || item.detail || "";
  fragment.querySelector(".progress-fill").style.width =
    typeof item.remainingPercent === "number" ? `${item.remainingPercent}%` : "0%";
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
  } else {
    const empty = document.createElement("p");
    empty.className = "provider-message";
    empty.textContent =
      provider.status === "needs-auth"
        ? "Open login to authenticate this provider."
        : "No usage data available yet.";
    itemList.appendChild(empty);
  }

  const loginButton = fragment.querySelector(".login-button");
  if ((provider.status === "needs-auth" || provider.status === "error") && !provider.chromeConnected) {
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
  const hasData = Object.values(state.providers).some(
    (p) => p.status === "ok" || p.status === "needs-auth" || p.status === "error"
  );
  if (hasData) {
    loadingSkeleton.classList.add("hidden");
  }

  lastUpdated.textContent = `Last updated: ${formatTimestamp(state.lastUpdatedAt)}`;

  providersRoot.innerHTML = "";
  Object.entries(state.providers).forEach(([providerId, provider]) => {
    providersRoot.appendChild(renderProvider(providerId, provider));
  });
}

refreshButton.addEventListener("click", () => {
  window.usageMonitor.refreshAll();
});

window.usageMonitor.getState().then(render);
window.usageMonitor.onStateUpdated(render);
