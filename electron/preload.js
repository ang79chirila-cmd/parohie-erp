const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("storage", {
  get: (key, shared = false) => ipcRenderer.invoke("storage:get", key, shared),
  set: (key, value, shared = false) => ipcRenderer.invoke("storage:set", key, value, shared),
  delete: (key, shared = false) => ipcRenderer.invoke("storage:delete", key, shared),
  list: (prefix, shared = false) => ipcRenderer.invoke("storage:list", prefix, shared),
});
