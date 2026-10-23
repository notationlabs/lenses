const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lenses", {
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
  onSelect: (listener) => ipcRenderer.on("select", (_event, page) => listener(page)),
  ready: () => ipcRenderer.send("app:ready"),
  viewport: (rect) => ipcRenderer.send("app:viewport", rect),
  command: (command, page) => ipcRenderer.send("app:command", command, page),
});
