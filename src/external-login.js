function getExternalLoginCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "open",
      args: ["-a", "Google Chrome", url],
    };
  }

  return null;
}

module.exports = {
  getExternalLoginCommand,
};
