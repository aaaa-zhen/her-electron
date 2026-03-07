const path = require("path");
const { BrowserWindow, shell, nativeImage } = require("electron");

function createMainWindow() {
  const window = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: "Her",
    icon: nativeImage.createFromPath(path.join(__dirname, "../../build/icon.png")),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
    backgroundColor: "#0a0a0a",
    show: false,
  });

  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "../renderer/index.html"));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

module.exports = { createMainWindow };
