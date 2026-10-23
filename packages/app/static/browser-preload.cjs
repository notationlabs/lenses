const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lenses", {
  onTabs: (listener) => ipcRenderer.on("tabs", (_event, state) => listener(state)),
  onStatus: (listener) => ipcRenderer.on("status", (_event, state) => listener(state)),
  onFocusAddress: (listener) => ipcRenderer.on("focus-address", () => listener()),
  onTogglePanel: (listener) => ipcRenderer.on("toggle-panel", (_event, open) => listener(open)),
  ready: () => ipcRenderer.send("ready"),
  viewport: (insets) => ipcRenderer.send("browser:viewport", insets),
  command: (command, id, arg) => ipcRenderer.send("browser:command", command, id, arg),
});
