'use strict';
/* School Manager desktop app.
   This window is just a shell — all the real work (students, fees, exams...) is done by the
   same server.js used by the browser version. Electron starts that server as a background
   process the moment the app opens, and closes it again when the app quits.

   Requires Node.js to be installed on this computer (the same requirement as the browser
   version's start.bat) — this window finds it on PATH and runs the bundled server.js with it,
   so the packaged app carries its own node_modules but not its own copy of Node itself. */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const isPackaged = app.isPackaged;
const SERVER_DIR = isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js');
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const PORT = 47821; // an unusual, unlikely-to-clash local port for the desktop app specifically

let serverProcess = null;
let mainWindow = null;

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) return reject(new Error('The app took too long to start.'));
          setTimeout(poll, 200);
        });
    })();
  });
}

function findNode() {
  // Prefer whatever "node" resolves to on PATH; fall back to a few common install locations.
  const candidates = [
    'node',
    '/usr/local/bin/node', '/usr/bin/node',
    'C\\Program Files\\nodejs\\node.exe',
  ];
  return candidates[0]; // spawn() with shell-less exec still searches PATH for a bare command name on all platforms
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(findNode(), [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), DATA_DIR, HOST: '127.0.0.1' },
      windowsHide: true,
    });
    serverProcess.on('error', (err) => reject(err));
    serverProcess.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
    serverProcess.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));
    waitForServer(`http://127.0.0.1:${PORT}/api/health`).then(resolve).catch(reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#f2f5f3',
    title: 'School Manager',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  // Links to somewhere outside the app (there aren't many, but be safe) open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open data folder',
          click: () => shell.openPath(DATA_DIR),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startServer();
    createWindow();
  } catch (err) {
    dialog.showErrorBox(
      'School Manager could not start',
      'This app needs Node.js installed on this computer.\n\n' +
      'Download it from https://nodejs.org (choose the LTS version), install it, then open School Manager again.\n\n' +
      'Details: ' + err.message
    );
    app.quit();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { if (serverProcess) serverProcess.kill(); });


