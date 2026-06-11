export function getProviderActionLabels(providerId, provider = {}) {
  const labels = [];
  const itemCount = Array.isArray(provider.items) ? provider.items.length : 0;

  if (provider.status === "needs-auth" || (providerId === "codex" && provider.status === "error")) {
    labels.push("Login");
  }

  if (provider.status === "ok" || itemCount > 0) {
    labels.push("Logout");
  }

  labels.push("Open");
  return labels;
}
