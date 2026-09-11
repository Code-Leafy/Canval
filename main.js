const { app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.code-leafy.canval'); } catch { /* ignore */ }
}

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  console.error('[updater] electron-updater missing:', err.message);
}

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('[pty] native module missing:', err.message);
}

let mainWindow = null;
const sessions = new Map();

function userRoot() {
  return app.getPath('userData');
}

function projectsRoot() {
  return path.join(userRoot(), 'projects');
}

function indexFile() {
  return path.join(userRoot(), 'library.json');
}

function emptyIndex() {
  return {
    settings: {
      defaultPreset: 'powershell',
      defaultCwd: os.homedir(),
      snap: true,
      grid: true,
    },
    recents: [],
  };
}

function readIndex() {
  try {
    return { ...emptyIndex(), ...JSON.parse(fs.readFileSync(indexFile(), 'utf8')) };
  } catch {
    return emptyIndex();
  }
}

function writeIndex(data) {
  fs.mkdirSync(userRoot(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(data, null, 2));
}

function projectDir(id) {
  return path.join(projectsRoot(), id);
}

function projectFile(id) {
  return path.join(projectDir(id), 'project.json');
}

function emptyProject(id, name, settings) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    camera: { x: 80, y: 64, zoom: 1 },
    settings: {
      snap: settings?.snap ?? true,
      grid: settings?.grid ?? true,
      defaultCwd: settings?.defaultCwd || os.homedir(),
      defaultPreset: settings?.defaultPreset || 'powershell',
    },
    terminals: [],
    notes: [],
    wires: [],
    zCounter: 1,
  };
}

function touchRecent(id, name) {
  const idx = readIndex();
  idx.recents = [
    { id, name, updatedAt: new Date().toISOString() },
    ...idx.recents.filter((r) => r.id !== id),
  ].slice(0, 40);
  writeIndex(idx);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 660,
    show: false,
    frame: false,
    transparent: true,
    title: 'Canval',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    ...(process.platform === 'win32'
      ? { thickFrame: true }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Terminals paint via requestAnimationFrame. Without this, Chromium
      // freezes all frames the moment the window is occluded/minimized and
      // every terminal goes stale or blank until refocused.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false));
  mainWindow.on('closed', () => {
    for (const [id, s] of sessions) {
      try { s.kill(); } catch { /* ignore */ }
      sessions.delete(id);
    }
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  fs.mkdirSync(projectsRoot(), { recursive: true });
  if (!fs.existsSync(indexFile())) writeIndex(emptyIndex());
  createWindow();
  setupUpdater();
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('win:minimize', () => mainWindow?.minimize());
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('win:close', () => mainWindow?.close());
ipcMain.handle('win:isMaximized', () => !!mainWindow?.isMaximized());

ipcMain.handle('settings:get', () => readIndex().settings);
ipcMain.handle('settings:set', (_e, next) => {
  const idx = readIndex();
  idx.settings = { ...idx.settings, ...next };
  writeIndex(idx);
  return idx.settings;
});

ipcMain.handle('projects:list', () => {
  const idx = readIndex();
  const recents = [];
  for (const r of idx.recents) {
    try {
      const data = JSON.parse(fs.readFileSync(projectFile(r.id), 'utf8'));
      recents.push({
        id: r.id,
        name: data.name || r.name,
        updatedAt: data.updatedAt || r.updatedAt,
        terminalCount: (data.terminals || []).length,
        noteCount: (data.notes || []).length,
        cwd: data.settings?.defaultCwd || '',
      });
    } catch {
      /* missing project */
    }
  }
  return { recents, settings: idx.settings };
});

ipcMain.handle('projects:create', async (_e, name) => {
  const id = crypto.randomUUID();
  const idx = readIndex();
  const proj = emptyProject(id, (name || 'Untitled project').trim(), idx.settings);
  await fsp.mkdir(projectDir(id), { recursive: true });
  await fsp.writeFile(projectFile(id), JSON.stringify(proj, null, 2));
  touchRecent(id, proj.name);
  return proj;
});

ipcMain.handle('projects:rename', async (_e, id, name) => {
  const file = projectFile(id);
  const data = JSON.parse(await fsp.readFile(file, 'utf8'));
  data.name = String(name || '').trim() || data.name;
  data.updatedAt = new Date().toISOString();
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
  touchRecent(id, data.name);
  return data;
});

ipcMain.handle('projects:delete', async (_e, id) => {
  await fsp.rm(projectDir(id), { recursive: true, force: true });
  const idx = readIndex();
  idx.recents = idx.recents.filter((r) => r.id !== id);
  writeIndex(idx);
  return true;
});

ipcMain.handle('projects:load', async (_e, id) => {
  const data = JSON.parse(await fsp.readFile(projectFile(id), 'utf8'));
  touchRecent(id, data.name);
  return data;
});

ipcMain.handle('projects:save', async (_e, id, data) => {
  data.updatedAt = new Date().toISOString();
  await fsp.mkdir(projectDir(id), { recursive: true });
  await fsp.writeFile(projectFile(id), JSON.stringify(data, null, 2));
  touchRecent(id, data.name);
  return data.updatedAt;
});

ipcMain.handle('projects:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project',
    filters: [{ name: 'Canval', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const data = JSON.parse(await fsp.readFile(src, 'utf8'));
  if (!data.id) data.id = crypto.randomUUID();
  if (!data.name) data.name = path.basename(src, '.json');
  await fsp.mkdir(projectDir(data.id), { recursive: true });
  await fsp.writeFile(projectFile(data.id), JSON.stringify(data, null, 2));
  touchRecent(data.id, data.name);
  return data;
});

ipcMain.handle('projects:pickDir', async (_e, title) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Working directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('projects:pickFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate executable',
    filters: [
      { name: 'Executables', extensions: ['exe', 'cmd', 'bat', 'ps1'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

// Full-path CLI resolution: manual override (saved in settings) first, then
// PATH + well-known install dirs. Returns absolute path or null.
function resolveCli(key, cmd) {
  if (!cmd) return null;
  try {
    const stored = readIndex().settings || {};
    const ov = stored.cliPaths && stored.cliPaths[key];
    if (ov) {
      try {
        if (fs.statSync(ov).isFile()) {
          whichCache.set(cmd, { full: ov, at: Date.now() });
          return ov;
        }
      } catch { /* stale override, fall through */ }
    }
  } catch { /* ignore */ }
  return resolveExe(cmd);
}

function resolveCommand(preset, command, args) {
  if (preset === 'bash') {
    if (process.platform === 'win32') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      if (fs.existsSync(gitBash)) return { file: gitBash, args: [] };
      return { file: 'powershell.exe', args: ['-NoLogo'] };
    }
    return { file: 'bash', args: [] };
  }
  const presets = {
    powershell: { file: process.platform === 'win32' ? (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe') : 'pwsh', args: ['-NoLogo'] },
    pwsh: { file: 'pwsh', args: ['-NoLogo'] },
    cmd: { file: process.platform === 'win32' ? 'cmd.exe' : 'bash', args: [] },
    claude: { file: 'claude', args: [] },
    codex: { file: 'codex', args: [] },
    cline: { file: 'cline', args: [] },
    opencode: { file: 'opencode', args: [] },
    gemini: { file: 'gemini', args: [] },
    kilo: { file: 'kilo', args: [] },
    freebuff: { file: 'freebuff', args: [] },
  };
  if (preset === 'custom' && command) {
    return { file: command, args: Array.isArray(args) ? args : [] };
  }
  const p = presets[preset] || presets.powershell;
  return p;
}

ipcMain.handle('pty:spawn', (_e, opts) => {
  const id = opts.id || crypto.randomUUID();
  if (!pty) {
    return { id, error: 'node-pty is not available. Run npm start from a machine with build tools, then npm run rebuild.' };
  }
  const resolvedCmd = resolveCommand(opts.preset, opts.command, opts.args);
  const args = resolvedCmd.args;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  // Fail fast with a machine-readable marker when the executable itself is
  // missing, so the UI can show install guidance instead of a raw error.
  // (Custom terminals without a command fall through to the default shell.)
  // Spawn by absolute path whenever resolvable (immune to search quirks).
  let file = resolvedCmd.file;
  if (opts.preset !== 'custom' || opts.command) {
    const probeCmd = presetProbe(opts.preset, opts.command);
    if (probeCmd) {
      const full = resolveCli(opts.preset, probeCmd);
      if (!full) {
        return { id, error: 'MISSING_CLI:' + probeCmd };
      }
      file = full;
    }
  }
  try {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      // WinPTY is the default backend: ConPTY input silently dies in some
      // GUI-hosted environments, while WinPTY works everywhere on Windows.
      // Pass useConpty:true explicitly to opt into ConPTY.
      useConpty: opts.useConpty === true,
      useConptyDll: !!opts.useConptyDll,
    });
    proc.onData((data) => {
      mainWindow?.webContents.send('pty:data', id, data);
    });
    proc.onExit(({ exitCode }) => {
      sessions.delete(id);
      mainWindow?.webContents.send('pty:exit', id, exitCode);
    });
    sessions.set(id, proc);
    return { id, file, cwd };
  } catch (err) {
    return { id, error: String(err.message || err) };
  }
});

ipcMain.on('pty:write', (_e, id, data) => {
  try {
    sessions.get(id)?.write(data);
  } catch { /* ignore */ }
});

ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try {
    sessions.get(id)?.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
  } catch { /* ignore */ }
});

ipcMain.handle('pty:kill', (_e, id) => {
  const s = sessions.get(id);
  if (s) {
    try { s.kill(); } catch { /* ignore */ }
    sessions.delete(id);
  }
  return true;
});

// Resolve an executable the way the OS shell would (PATH + PATHEXT on Windows).
// Returns an ABSOLUTE path when found, null otherwise.
const whichCache = new Map();
function cleanDir(d) {
  let s = String(d || '').trim();
  if (s.length > 1 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/%([^%]+)%/g, (_m, n) => process.env[n] ?? process.env[String(n).toUpperCase()] ?? '');
  return s.trim();
}
function wellKnownCliDirs() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(appData, 'npm'), // `npm i -g` binaries (often missing from PATH)
    path.join(localApp, 'Volta', 'bin'),
    path.join(home, 'scoop', 'shims'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
  ];
}
function resolveExe(cmd) {
  if (!cmd || /[\0]/.test(cmd)) return null;
  const cached = whichCache.get(cmd);
  if (cached !== undefined && Date.now() - cached.at < 60000) return cached.full;
  let full = null;
  try {
    if (/[\\/]/.test(cmd)) {
      const cands = [cmd];
      if (process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(cmd)) {
        for (const ext of ['.exe', '.cmd', '.bat']) cands.push(cmd + ext);
      }
      for (const c of cands) {
        try { if (fs.statSync(c).isFile()) { full = c; break; } } catch { /* next */ }
      }
    } else {
      const dirs = String(process.env.PATH || '').split(path.delimiter).map(cleanDir).filter(Boolean);
      const exts = process.platform === 'win32'
        ? ['.exe', '.cmd', '.bat']
        : [''];
      const names = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(cmd)
        ? exts.map((e) => cmd + e)
        : [cmd];
      outer: for (const d of dirs) {
        for (const n of names) {
          try {
            const cand = path.join(d, n);
            if (fs.statSync(cand).isFile()) {
              full = cand;
              break outer;
            }
          } catch { /* next */ }
        }
      }
      // Well-known install locations (npm globals etc. are often missing from PATH,
      // e.g. version managers or shell-profile shims that GUI apps never inherit).
      if (!full) {
        outer2: for (const d of wellKnownCliDirs()) {
          for (const n of names) {
            try {
              const full2 = path.join(d, n);
              if (fs.statSync(full2).isFile()) {
                full = full2;
                break outer2;
              }
            } catch { /* next */ }
          }
        }
      }
    }
  } catch { full = null; }
  whichCache.set(cmd, { full, at: Date.now() });
  return full;
}

function presetProbe(preset, command) {
  if (preset === 'custom') return command || null;
  switch (preset) {
    case 'powershell': return 'powershell.exe';
    case 'pwsh': return 'pwsh';
    case 'cmd': return 'cmd.exe';
    case 'bash':
      return process.platform === 'win32'
        ? (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'powershell.exe')
        : 'bash';
    default: return preset;
  }
}

ipcMain.handle('pty:which', (_e, probes) => {
  const out = {};
  for (const [key, cmd] of Object.entries(probes || {})) {
    if (!cmd) { out[key] = true; continue; }
    try { out[key] = !!resolveCli(key, cmd); } catch { out[key] = false; }
  }
  return out;
});

ipcMain.handle('term:copy', (_e, text) => {
  try { clipboard.writeText(String(text || '')); return true; }
  catch { return false; }
});

ipcMain.handle('term:paste', () => {
  try { return clipboard.readText(); }
  catch { return ''; }
});

function normalizeAccent(raw) {
  // Electron returns '#RRGGBB' — keep it simple and defensive.
  let s = String(raw || '').replace(/[^0-9a-f]/gi, '');
  if (s.length > 6) s = s.slice(-6);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toUpperCase();
  return '#0078D4';
}

ipcMain.handle('system:accent', () => {
  try {
    return normalizeAccent(systemPreferences.getAccentColor());
  } catch {
    return '#0078D4';
  }
});

function broadcastAccent() {
  try {
    mainWindow?.webContents.send('system:accent-changed', normalizeAccent(systemPreferences.getAccentColor()));
  } catch { /* ignore */ }
}

try {
  systemPreferences.on('accent-color-changed', broadcastAccent);
} catch { /* older Electron */ }

// ---- Auto-updates (GitHub releases, packaged builds only) ----
function updaterSend(state) {
  try { mainWindow?.webContents.send('updater:status', state); } catch { /* ignore */ }
}

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => updaterSend({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => updaterSend({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => updaterSend({ state: 'current' }));
  autoUpdater.on('download-progress', (p) => updaterSend({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => updaterSend({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => updaterSend({ state: 'error', message: String((err && err.message) || err) }));
  try { autoUpdater.checkForUpdatesAndNotify(); } catch { /* offline etc. */ }
  setInterval(() => { try { autoUpdater.checkForUpdatesAndNotify(); } catch { /* ignore */ } }, 6 * 3600 * 1000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('updater:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { state: 'dev', version: app.getVersion() };
  try {
    const res = await autoUpdater.checkForUpdates();
    const v = res?.updateInfo?.version;
    if (v && v !== app.getVersion()) return { state: 'available', version: v };
    return { state: 'current', version: app.getVersion() };
  } catch (err) {
    return { state: 'error', message: String((err && err.message) || err) };
  }
});
ipcMain.handle('updater:quitInstall', () => {
  try { autoUpdater?.quitAndInstall(); } catch { /* ignore */ }
  return true;
});
