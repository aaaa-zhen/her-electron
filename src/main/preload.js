const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("herAPI", {
  bootstrap: () => ipcRenderer.invoke("her:bootstrap"),
  saveRelationshipProfile: (payload) => ipcRenderer.invoke("her:save-relationship-profile", payload),
  saveApiKey: (apiKey) => ipcRenderer.invoke("her:save-api-key", apiKey),
  getSettings: () => ipcRenderer.invoke("her:get-settings"),
  saveSettings: (patch) => ipcRenderer.invoke("her:save-settings", patch),
  sendMessage: (payload) => ipcRenderer.send("her:send-message", payload),
  cancel: () => ipcRenderer.send("her:cancel"),
  uploadFile: (payload) => ipcRenderer.invoke("her:upload-file", payload),
  sharedFileUrl: (filename) => ipcRenderer.invoke("her:shared-file-url", filename),
  getTodos: () => ipcRenderer.invoke("her:get-todos"),
  togglePin: () => ipcRenderer.invoke("her:toggle-pin"),
  getContext: () => ipcRenderer.invoke("her:get-context"),
  getProfile: () => ipcRenderer.invoke("her:get-profile"),
  checkUpdate: () => ipcRenderer.invoke("her:check-update"),
  openUrl: (url) => ipcRenderer.invoke("her:open-url", url),
  weixinStatus: () => ipcRenderer.invoke("her:weixin-status"),
  weixinLogin: () => ipcRenderer.invoke("her:weixin-login"),
  weixinDisconnect: () => ipcRenderer.invoke("her:weixin-disconnect"),
  onEvent: (listener) => {
    const wrapped = (_event, data) => listener(data);
    ipcRenderer.on("her:event", wrapped);
    return () => ipcRenderer.removeListener("her:event", wrapped);
  },
});
