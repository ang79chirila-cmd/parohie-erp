const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

// Fixăm explicit numele aplicației. Fără asta, Electron folosește "name" din
// package.json în modul dezvoltare (npm run dev) dar "productName" în aplicația
// construită (.exe) — două nume diferite ar însemna DOUĂ foldere de date diferite
// (%APPDATA%\parohie-erp vs %APPDATA%\ParohieERP), deci un cont creat într-un mod
// n-ar mai fi văzut deloc în celălalt. Fixarea numelui garantează un singur folder,
// stabil, indiferent cum rulează aplicația.
app.setName("ParohieERP");

/* ----------------------------------------------------------------------
 * Persistență locală: un singur fișier JSON în directorul de date al
 * utilizatorului (per sistem de operare), gestionat de procesul main.
 * Înlocuiește API-ul window.storage folosit inițial ca prototip.
 * -------------------------------------------------------------------- */

function storeFilePath() {
  return path.join(app.getPath("userData"), "parohie-store.json");
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storeFilePath(), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveStore(data) {
  const dir = path.dirname(storeFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storeFilePath(), JSON.stringify(data, null, 2), "utf-8");
}

function namespacedKey(shared, key) {
  return `${shared ? "shared" : "personal"}:${key}`;
}

ipcMain.handle("storage:get", (_evt, key, shared) => {
  const store = loadStore();
  const k = namespacedKey(shared, key);
  if (!(k in store)) return null;
  return { key, value: store[k], shared: !!shared };
});

ipcMain.handle("storage:set", (_evt, key, value, shared) => {
  const store = loadStore();
  const k = namespacedKey(shared, key);
  store[k] = value;
  saveStore(store);
  return { key, value, shared: !!shared };
});

ipcMain.handle("storage:delete", (_evt, key, shared) => {
  const store = loadStore();
  const k = namespacedKey(shared, key);
  const existed = k in store;
  delete store[k];
  saveStore(store);
  if (!existed) return null;
  return { key, deleted: true, shared: !!shared };
});

ipcMain.handle("storage:list", (_evt, prefix, shared) => {
  const store = loadStore();
  const nsPrefix = namespacedKey(shared, prefix || "");
  const stripLen = namespacedKey(shared, "").length;
  const keys = Object.keys(store)
    .filter((k) => k.startsWith(nsPrefix))
    .map((k) => k.slice(stripLen));
  return { keys, prefix: prefix || undefined, shared: !!shared };
});

/* --------------------------- Fereastra aplicației ---------------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
