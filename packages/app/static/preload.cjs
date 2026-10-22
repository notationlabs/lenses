const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lenses", {
  onState: (listener) => {
    ipcRenderer.on("state", (_event, state) => listener(state));
    ipcRenderer.send("ready");
  },
  openSite: (url) => ipcRenderer.send("open-site", url),
  window: (id, action) => ipcRenderer.send("window", id, action),
});
