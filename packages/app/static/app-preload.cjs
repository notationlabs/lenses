const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lenses", {
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
  onSelect: (listener) => ipcRenderer.on("select", (_event, page) => listener(page)),
  ready: () => ipcRenderer.send("app:ready"),
  viewport: (rect) => ipcRenderer.send("app:viewport", rect),
  onFocusAddress: (listener) => ipcRenderer.on("focus-address", () => listener()),
  command: (command, page, address) => ipcRenderer.send("app:command", command, page, address),
});
