const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notice", {
  onNotice: (listener) => ipcRenderer.on("notice", (_event, state) => listener(state)),
  ready: () => ipcRenderer.send("notice:ready"),
  ignore: (page) => ipcRenderer.send("notice:ignore", page),
  open: (page) => ipcRenderer.send("notice:open", page),
});
