const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

const SIGNALING_URL = process.env.SIGNALING_URL || 'http://192.168.1.15:3001';
const WS_URL = process.env.WS_URL || 'ws://192.168.1.15:3001/ws';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle('get-config', async () => ({ SIGNALING_URL, WS_URL }));
