import { app, BrowserWindow, Menu, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWebServer } from '../server/web-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
let mainWindow = null;
let serverInstance = null;

async function startServer() {
  const rootDir = join(__dirname, '..');
  const staticDir = join(rootDir, 'web', 'dist');

  const server = createWebServer({
    staticDir: existsSync(staticDir) ? staticDir : undefined,
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      console.log(`LoFi Backend listening at http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: 'LoFi Automation',
    backgroundColor: '#f7f5f0',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  // Arayüz süreci çökerse (bellek vb.) pencere beyaz kalmasın: nedeni yaz, sayfayı yeniden yükle.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Arayüz süreci kapandı (${details.reason}, kod ${details.exitCode}) — sayfa yeniden yükleniyor.`);
    if (details.reason !== 'clean-exit') mainWindow?.webContents.reload();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const startUrl = isDev && devServerUrl ? devServerUrl : `http://127.0.0.1:${port}`;

  await mainWindow.loadURL(startUrl);

  if (isDev && process.env.OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const { server, port } = await startServer();
      serverInstance = server;
      await createWindow(port);
    } catch (err) {
      console.error('Failed to launch LoFi Automation:', err);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (serverInstance) {
      serverInstance.close();
      serverInstance = null;
    }
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!serverInstance) {
        const { server, port } = await startServer();
        serverInstance = server;
        await createWindow(port);
      }
    }
  });
}
