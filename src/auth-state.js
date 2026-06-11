function shouldMarkAppSessionAuth(result, options = {}) {
  return !!options.skipChromeImport && result?.status === "ok";
}

function shouldClearAppSessionAuth(result) {
  return result?.status === "needs-auth";
}

function shouldImportChromeCookiesForProvider(options = {}) {
  if (options.skipChromeImport) {
    return false;
  }

  return options.loginMode === "external" || !options.hasAppSessionAuth;
}

function shouldRefreshAfterExternalLogin(loginMode) {
  return loginMode === "external";
}

function getExternalLoginRefreshDelays(loginMode) {
  return shouldRefreshAfterExternalLogin(loginMode) ? [0, 5000, 15000, 30000, 60000, 120000] : [];
}

function shouldFallbackToBrowserUsage(result) {
  return !result || result.status !== "ok";
}

function getUsageUrlCandidates(provider = {}) {
  return Array.from(new Set([provider.url, ...(provider.acceptedUrls || [])].filter(Boolean)));
}

function getLoggedOutProviderState(providerLabel) {
  return {
    status: "needs-auth",
    chromeConnected: false,
    items: [],
    message: `Logged out of ${providerLabel} in this app`,
    lastUpdatedAt: null,
  };
}

module.exports = {
  getLoggedOutProviderState,
  getUsageUrlCandidates,
  getExternalLoginRefreshDelays,
  shouldClearAppSessionAuth,
  shouldFallbackToBrowserUsage,
  shouldImportChromeCookiesForProvider,
  shouldRefreshAfterExternalLogin,
  shouldMarkAppSessionAuth,
};
