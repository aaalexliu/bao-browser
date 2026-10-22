const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  app.accessibilitySupportEnabled = true;
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    title: "bao ax electron",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadFile("index.html");
});
