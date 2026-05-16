const UPDATE_STATUS = {
  IDLE: "idle",
  DISABLED: "disabled",
  CHECKING: "checking",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  CURRENT: "current",
  ERROR: "error",
};

function createInitialUpdateState(currentVersion) {
  return decorateUpdateState({
    status: UPDATE_STATUS.IDLE,
    message: "Updates not checked yet",
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    percent: null,
    lastCheckedAt: null,
    errorCode: null,
  });
}

function getUpdateAction(update) {
  switch (update?.status) {
    case UPDATE_STATUS.DOWNLOADED:
      return { label: "Install", disabled: false };
    case UPDATE_STATUS.CHECKING:
      return { label: "Checking", disabled: true };
    case UPDATE_STATUS.DOWNLOADING:
      return { label: "Downloading", disabled: true };
    case UPDATE_STATUS.DISABLED:
      return { label: "Update", disabled: true };
    default:
      return { label: "Update", disabled: false };
  }
}

function decorateUpdateState(update) {
  const action = getUpdateAction(update);
  return {
    ...update,
    actionLabel: action.label,
    actionDisabled: action.disabled,
  };
}

function formatDownloadMessage(version, percent) {
  const rounded = Number.isFinite(percent) ? Math.round(percent) : null;
  const suffix = rounded === null ? "" : ` (${rounded}%)`;
  return `Downloading ${version || "update"}${suffix}`;
}

module.exports = {
  UPDATE_STATUS,
  createInitialUpdateState,
  decorateUpdateState,
  formatDownloadMessage,
  getUpdateAction,
};
