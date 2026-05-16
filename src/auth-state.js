function shouldMarkAppSessionAuth(result, options = {}) {
  return !!options.skipChromeImport && result?.status === "ok";
}

function shouldClearAppSessionAuth(result) {
  return result?.status === "needs-auth";
}

module.exports = {
  shouldClearAppSessionAuth,
  shouldMarkAppSessionAuth,
};
