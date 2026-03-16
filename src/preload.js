const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usageMonitor", {
  getState: () => ipcRenderer.invoke("get-state"),
  refreshAll: () => ipcRenderer.invoke("refresh-all"),
  openLogin: (providerId) => ipcRenderer.invoke("open-login", providerId),
  openExternal: (providerId) => ipcRenderer.invoke("open-external", providerId),
  onStateUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state-updated", listener);
    return () => ipcRenderer.removeListener("state-updated", listener);
  },
});
