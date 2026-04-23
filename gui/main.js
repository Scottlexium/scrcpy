const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const CONFIG_PATH = path.join(os.homedir(), '.scrcpy-gui.json');

function loadConfigSync() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// Clear saved paths pointing to the old ~/.scrcpy-gui/bin location.
function migrateStaleConfig() {
  const cfg     = loadConfigSync();
  const oldRoot = path.join(os.homedir(), '.scrcpy-gui');
  let dirty = false;
  for (const key of ['adbPath', 'scrcpyPath']) {
    if (cfg[key] && cfg[key].startsWith(oldRoot)) {
      delete cfg[key];
      delete cfg[`${key.replace('Path', '')}InstalledBy`];
      dirty = true;
    }
  }
  if (dirty) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let mainWindow;
let scrcpyProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 700,
    minWidth: 720,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0b14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  migrateStaleConfig();
  createWindow();
  setupTray();
});

app.on('before-quit', () => {
  if (scrcpyProcess) scrcpyProcess.kill();
  if (logcatProc)    logcatProc.kill();
  stopReconnectWatch();
});

app.on('window-all-closed', () => {
  if (scrcpyProcess) scrcpyProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Binary resolution ───────────────────────────────────────────────────────
//
// Search order:
//   1. User-saved custom path (in config)
//   2. System PATH
//   3. Platform-specific well-known install locations

const ADB_LOCATIONS = {
  darwin: [
    '/opt/homebrew/bin/adb',                              // Homebrew (Apple Silicon)
    '/usr/local/bin/adb',                                  // Homebrew (Intel)
    `${os.homedir()}/Library/Android/sdk/platform-tools/adb`,  // Android Studio
    '/Applications/Android Studio.app/Contents/plugins/android-adb/resources/adb',
  ],
  linux: [
    '/usr/bin/adb',
    '/usr/local/bin/adb',
    `${os.homedir()}/Android/Sdk/platform-tools/adb`,
  ],
  win32: [
    `${process.env.LOCALAPPDATA}\\Android\\sdk\\platform-tools\\adb.exe`,
    `${process.env.ProgramFiles}\\Android\\platform-tools\\adb.exe`,
  ],
};

const SCRCPY_LOCATIONS = {
  darwin: [
    '/opt/homebrew/bin/scrcpy',
    '/usr/local/bin/scrcpy',
    path.join(__dirname, '..', 'build', 'x86_64', 'app', 'scrcpy'),  // meson build
  ],
  linux: [
    '/usr/bin/scrcpy',
    '/usr/local/bin/scrcpy',
    path.join(__dirname, '..', 'build', 'x86_64', 'app', 'scrcpy'),
  ],
  win32: [
    `${process.env.ProgramFiles}\\scrcpy\\scrcpy.exe`,
    path.join(__dirname, '..', 'build', 'scrcpy.exe'),
  ],
};

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function resolveFromPath(name) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    exec(cmd, (err, stdout) => {
      resolve(err ? null : stdout.trim().split('\n')[0].trim() || null);
    });
  });
}

async function findBinary(name, extraLocations = []) {
  const cfg = loadConfigSync();
  const customPath = cfg[`${name}Path`];
  if (customPath && fileExists(customPath)) return customPath;

  const fromPath = await resolveFromPath(name);
  if (fromPath) return fromPath;

  const platform = process.platform;
  const candidates = [
    ...(extraLocations || []),
    ...((name === 'adb' ? ADB_LOCATIONS : SCRCPY_LOCATIONS)[platform] || []),
  ];

  for (const p of candidates) {
    if (p && fileExists(p)) return p;
  }

  return null;
}

function verifyBinary(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

// ── Dependency check ────────────────────────────────────────────────────────

ipcMain.handle('check-deps', async () => {
  const cfg = loadConfigSync();
  const [adbPath, scrcpyPath] = await Promise.all([
    findBinary('adb'),
    findBinary('scrcpy'),
  ]);

  return {
    adb: adbPath
      ? { found: true, path: adbPath, managedByUs: cfg.adbInstalledBy === 'scrcpy-gui' }
      : { found: false, path: null, managedByUs: false },
    scrcpy: scrcpyPath
      ? { found: true, path: scrcpyPath, managedByUs: cfg.scrcpyInstalledBy === 'scrcpy-gui' }
      : { found: false, path: null, managedByUs: false },
  };
});

ipcMain.handle('open-url', (_e, url) => shell.openExternal(url));

// ── Standard install locations ──────────────────────────────────────────────
//
// ADB  → ~/Library/Android/sdk/platform-tools/   (same path Android Studio uses)
// scrcpy → ~/Library/Application Support/scrcpy/  (macOS app support convention)
// Both directories are added to the user's shell PATH on first install.

const INSTALL_DIRS = {
  adb: {
    darwin: path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools'),
    linux:  path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools'),
    win32:  path.join(process.env.LOCALAPPDATA || os.homedir(), 'Android', 'sdk', 'platform-tools'),
  },
  scrcpy: {
    darwin: path.join(os.homedir(), 'Library', 'Application Support', 'scrcpy'),
    linux:  path.join(os.homedir(), '.local', 'share', 'scrcpy'),
    win32:  path.join(process.env.LOCALAPPDATA || os.homedir(), 'scrcpy'),
  },
};

function installDir(name) {
  return INSTALL_DIRS[name]?.[process.platform] ?? null;
}

// ── Shell PATH management ───────────────────────────────────────────────────

const SHELL_PROFILES = [
  path.join(os.homedir(), '.zshrc'),
  path.join(os.homedir(), '.bashrc'),
  path.join(os.homedir(), '.bash_profile'),
];

const PATH_COMMENT = '# Added by scrcpy GUI';

function addDirToShellPath(dir) {
  if (process.platform === 'win32') {
    // On Windows, append to user PATH via setx (no sudo needed)
    exec(`setx PATH "%PATH%;${dir}"`, () => {});
    return;
  }
  const line = `export PATH="$PATH:${dir}"`;
  for (const profile of SHELL_PROFILES) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
      if (content.includes(dir)) continue;          // already present
      fs.appendFileSync(profile, `\n${PATH_COMMENT}\n${line}\n`);
    } catch {}
  }
}

function removeDirFromShellPath(dir) {
  if (process.platform === 'win32') return;
  for (const profile of SHELL_PROFILES) {
    if (!fs.existsSync(profile)) continue;
    try {
      const lines = fs.readFileSync(profile, 'utf8').split('\n');
      const filtered = lines.filter(l =>
        !l.includes(dir) && !(l.trim() === PATH_COMMENT && lines[lines.indexOf(l) + 1]?.includes(dir))
      );
      fs.writeFileSync(profile, filtered.join('\n'));
    } catch {}
  }
}

// ── Download helpers ────────────────────────────────────────────────────────

function sendProgress(name, phase, pct, detail = '') {
  mainWindow?.webContents.send('download-progress', { name, phase, pct, detail });
}

// Follows HTTP/HTTPS redirects; resolves when file fully written.
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'scrcpy-gui' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, destPath, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', chunk => {
        received += chunk.length;
        if (total > 0) onProgress(Math.round((received / total) * 88));
      });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Recursive copy that correctly handles files, subdirectories, and symlinks.
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath  = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat     = fs.lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      try { fs.unlinkSync(destPath); } catch {}
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    if (process.platform === 'win32') {
      exec(
        `powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
        (err) => err ? reject(err) : resolve()
      );
    } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      execFile('tar', ['xzf', archivePath, '-C', destDir],
        (err) => err ? reject(err) : resolve());
    } else {
      execFile('unzip', ['-o', '-q', archivePath, '-d', destDir],
        (err) => err ? reject(err) : resolve());
    }
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'scrcpy-gui' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Auto-install ADB (platform-tools) ──────────────────────────────────────

const PLATFORM_TOOLS_URL = {
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  linux:  'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
  win32:  'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
};

ipcMain.handle('download-adb', async () => {
  const url    = PLATFORM_TOOLS_URL[process.platform];
  const destDir = installDir('adb');
  if (!url || !destDir) return { ok: false, error: 'Platform not supported for auto-install' };

  const tmpZip     = path.join(os.tmpdir(), `platform-tools-${Date.now()}.zip`);
  const tmpExtract = path.join(os.tmpdir(), `pt-extract-${Date.now()}`);

  try {
    sendProgress('adb', 'downloading', 0, 'Connecting to Google…');
    await downloadFile(url, tmpZip, pct =>
      sendProgress('adb', 'downloading', pct, `Downloading… ${pct}%`)
    );

    sendProgress('adb', 'extracting', 90, 'Extracting archive…');
    await extractArchive(tmpZip, tmpExtract);

    sendProgress('adb', 'installing', 96, 'Copying to install directory…');
    fs.mkdirSync(destDir, { recursive: true });

    // Copy entire platform-tools tree (includes lib64/ and other subdirs).
    copyDirRecursive(path.join(tmpExtract, 'platform-tools'), destDir);

    const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const adbPath = path.join(destDir, adbBin);
    if (!fs.existsSync(adbPath))
      throw new Error('adb binary missing after extraction');
    if (process.platform !== 'win32') fs.chmodSync(adbPath, 0o755);

    addDirToShellPath(destDir);

    const cfg = loadConfigSync();
    cfg.adbPath = adbPath;
    cfg.adbInstalledBy = 'scrcpy-gui';
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

    sendProgress('adb', 'done', 100, adbPath);
    return { ok: true, path: adbPath };
  } catch (e) {
    sendProgress('adb', 'error', 0, e.message);
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpZip); }                             catch {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
  }
});

// ── Auto-install scrcpy ─────────────────────────────────────────────────────

// Platform substring to match against GitHub release asset filenames.
const SCRCPY_ASSET_PLATFORM = {
  darwin: 'macos',
  linux:  'linux',
  win32:  'win64',
};

ipcMain.handle('download-scrcpy', async () => {
  const platform = SCRCPY_ASSET_PLATFORM[process.platform];
  const destDir  = installDir('scrcpy');
  if (!platform || !destDir) return { ok: false, error: 'Platform not supported for auto-install' };

  const tmpArchive = path.join(os.tmpdir(), `scrcpy-download-${Date.now()}`);
  const tmpExtract = path.join(os.tmpdir(), `scrcpy-extract-${Date.now()}`);

  try {
    sendProgress('scrcpy', 'fetching', 2, 'Checking latest release…');
    const release = await fetchJson('https://api.github.com/repos/Genymobile/scrcpy/releases/latest');
    const version = release.tag_name;
    const asset   = release.assets?.find(a =>
      a.name.toLowerCase().includes(platform) &&
      (a.name.endsWith('.tar.gz') || a.name.endsWith('.zip'))
    );
    if (!asset) throw new Error(`No ${platform} binary found in release ${version}`);

    const ext = asset.name.endsWith('.tar.gz') ? '.tar.gz' : '.zip';
    const archivePath = tmpArchive + ext;

    sendProgress('scrcpy', 'downloading', 5, `Downloading scrcpy ${version}…`);
    await downloadFile(asset.browser_download_url, archivePath, pct =>
      sendProgress('scrcpy', 'downloading', 5 + Math.round(pct * 0.83), `Downloading… ${pct}%`)
    );

    sendProgress('scrcpy', 'extracting', 90, 'Extracting archive…');
    await extractArchive(archivePath, tmpExtract);

    sendProgress('scrcpy', 'installing', 96, 'Copying to install directory…');
    fs.mkdirSync(destDir, { recursive: true });

    // The archive may contain a single top-level subdirectory (e.g. scrcpy-macos-v3.1/).
    // Unwrap it so destDir contains the files directly.
    const topEntries = fs.readdirSync(tmpExtract);
    const subdir = topEntries.length === 1 && fs.statSync(path.join(tmpExtract, topEntries[0])).isDirectory()
      ? path.join(tmpExtract, topEntries[0])
      : tmpExtract;

    copyDirRecursive(subdir, destDir);

    const scrcpyBin = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
    const scrcpyPath = path.join(destDir, scrcpyBin);
    if (!fs.existsSync(scrcpyPath))
      throw new Error('scrcpy binary missing after extraction');
    if (process.platform !== 'win32') fs.chmodSync(scrcpyPath, 0o755);

    addDirToShellPath(destDir);

    const cfg = loadConfigSync();
    cfg.scrcpyPath = scrcpyPath;
    cfg.scrcpyInstalledBy = 'scrcpy-gui';
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

    sendProgress('scrcpy', 'done', 100, scrcpyPath);
    return { ok: true, path: scrcpyPath, version };
  } catch (e) {
    sendProgress('scrcpy', 'error', 0, e.message);
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpArchive + '.tar.gz'); } catch {}
    try { fs.unlinkSync(tmpArchive + '.zip'); }   catch {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
  }
});

// ── Remove / Repair ─────────────────────────────────────────────────────────

ipcMain.handle('remove-tool', async (_e, name) => {
  const dir = installDir(name);
  if (!dir) return { ok: false, error: 'Unknown tool' };

  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    removeDirFromShellPath(dir);

    const cfg = loadConfigSync();
    delete cfg[`${name}Path`];
    delete cfg[`${name}InstalledBy`];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-binary-path', (_e, name, binPath) => {
  const cfg = loadConfigSync();
  cfg[`${name}Path`] = binPath;
  delete cfg[`${name}InstalledBy`]; // manual path — not managed by us
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return { ok: true };
});

ipcMain.handle('pick-binary', async (_e, name) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Locate ${name} binary`,
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Executable', extensions: ['exe'] }]
      : [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  const p = result.filePaths[0];
  const ok = await verifyBinary(p);
  return ok ? p : { error: `Could not verify ${name} at that path` };
});

// ── ADB device listing ──────────────────────────────────────────────────────

ipcMain.handle('list-devices', async () => {
  const adbPath = await findBinary('adb');
  if (!adbPath) return { error: 'adb_not_found' };

  return new Promise((resolve) => {
    execFile(adbPath, ['devices', '-l'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ error: err.message });
      const lines = stdout.split('\n').slice(1);
      const devices = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Authorized, ready device
        const readyMatch = trimmed.match(/^(\S+)\s+device\b(.*)$/);
        if (readyMatch) {
          const serial = readyMatch[1];
          const meta   = readyMatch[2] || '';
          const modelMatch = meta.match(/model:(\S+)/);
          const label = modelMatch ? modelMatch[1].replace(/_/g, ' ') : serial;
          devices.push({ serial, label: `${label} (${serial})`, status: 'ready' });
          continue;
        }

        // Unauthorized — phone needs to accept the USB debugging prompt
        const unauthMatch = trimmed.match(/^(\S+)\s+unauthorized\b/);
        if (unauthMatch) {
          const serial = unauthMatch[1];
          devices.push({ serial, label: serial, status: 'unauthorized' });
          continue;
        }

        // Offline / other states
        const offlineMatch = trimmed.match(/^(\S+)\s+(offline|connecting|authorizing)\b/);
        if (offlineMatch) {
          devices.push({ serial: offlineMatch[1], label: offlineMatch[1], status: offlineMatch[2] });
        }
      }
      resolve({ devices });
    });
  });
});

// ── Launch scrcpy ───────────────────────────────────────────────────────────

ipcMain.handle('launch-scrcpy', async (_e, opts) => {
  if (scrcpyProcess) return { ok: false, error: 'scrcpy is already running.' };

  const scrcpyPath = await findBinary('scrcpy');
  if (!scrcpyPath) return { ok: false, error: 'scrcpy not found. Set the path in Setup.' };

  const adbPath = await findBinary('adb');
  const env = { ...process.env };
  if (adbPath) {
    // Ensure ADB's directory is on PATH so scrcpy can find it
    env.PATH = `${path.dirname(adbPath)}:${env.PATH || ''}`;
  }

  const args = buildArgs(opts);

  try {
    scrcpyProcess = spawn(scrcpyPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (e) {
    return { ok: false, error: `Failed to start scrcpy: ${e.message}` };
  }

  const sessionStart = Date.now();
  mainWindow.webContents.send('scrcpy-status', 'running');
  refreshTray();
  scrcpyProcess.stdout.on('data', d => mainWindow.webContents.send('scrcpy-log', d.toString()));
  scrcpyProcess.stderr.on('data', d => mainWindow.webContents.send('scrcpy-log', d.toString()));
  scrcpyProcess.on('close', code => {
    const duration = Math.round((Date.now() - sessionStart) / 1000);
    const sessions = loadSessions();
    sessions.unshift({ id: Date.now(), serial: opts.serial || 'unknown', startTime: sessionStart, duration, opts });
    if (sessions.length > 100) sessions.splice(100);
    saveSessions(sessions);
    scrcpyProcess = null;
    refreshTray();
    mainWindow?.webContents.send('scrcpy-status', 'stopped');
    mainWindow?.webContents.send('scrcpy-log', `\n[scrcpy exited with code ${code}]\n`);
  });

  return { ok: true, args };
});

ipcMain.handle('stop-scrcpy', () => {
  if (scrcpyProcess) { scrcpyProcess.kill(); scrcpyProcess = null; }
  return { ok: true };
});

// ── OTG input mode ──────────────────────────────────────────────────────────
// Uses Android Open Accessory (AOA) — no USB debugging auth required.

let otgProcess = null;

ipcMain.handle('launch-otg', async (_e, serial) => {
  if (otgProcess) return { ok: false, error: 'OTG session already running.' };

  const scrcpyPath = await findBinary('scrcpy');
  if (!scrcpyPath) return { ok: false, error: 'scrcpy not found. Install it in Setup first.' };

  const args = ['--otg'];
  if (serial) args.push('--serial', serial);

  try {
    otgProcess = spawn(scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  otgProcess.stderr.on('data', d =>
    mainWindow?.webContents.send('otg-log', d.toString())
  );
  otgProcess.stdout.on('data', d =>
    mainWindow?.webContents.send('otg-log', d.toString())
  );
  otgProcess.on('close', code => {
    otgProcess = null;
    mainWindow?.webContents.send('otg-stopped', code);
  });

  return { ok: true };
});

ipcMain.handle('stop-otg', () => {
  if (otgProcess) { otgProcess.kill(); otgProcess = null; }
  return { ok: true };
});

// ── Wireless ADB pairing (Android 11+) ─────────────────────────────────────

ipcMain.handle('wireless-pair', async (_e, ip, port, code) => {
  const adbPath = await findBinary('adb');
  if (!adbPath) return { ok: false, error: 'adb not found' };

  return new Promise((resolve) => {
    // adb pair <ip>:<port> <code>
    execFile(adbPath, ['pair', `${ip}:${port}`, code], { timeout: 15000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err) return resolve({ ok: false, error: out || err.message });
      if (out.toLowerCase().includes('failed') || out.toLowerCase().includes('error')) {
        return resolve({ ok: false, error: out });
      }
      resolve({ ok: true, message: out });
    });
  });
});

ipcMain.handle('wireless-connect', async (_e, ip, port) => {
  const adbPath = await findBinary('adb');
  if (!adbPath) return { ok: false, error: 'adb not found' };

  return new Promise((resolve) => {
    execFile(adbPath, ['connect', `${ip}:${port}`], { timeout: 10000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err) return resolve({ ok: false, error: out || err.message });
      resolve({ ok: true, message: out });
    });
  });
});

// ── ADB public key ──────────────────────────────────────────────────────────

ipcMain.handle('get-adb-pubkey', () => {
  const keyPath = path.join(os.homedir(), '.android', 'adbkey.pub');
  try {
    return { ok: true, key: fs.readFileSync(keyPath, 'utf8').trim() };
  } catch {
    return { ok: false, error: `Key not found at ${keyPath}. Run adb once to generate it.` };
  }
});

// ── File picker ─────────────────────────────────────────────────────────────

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save recording',
    defaultPath: path.join(os.homedir(), 'Desktop', 'recording.mp4'),
    filters: [
      { name: 'MP4', extensions: ['mp4'] },
      { name: 'MKV', extensions: ['mkv'] },
    ],
  });
  return result.canceled ? null : result.filePath;
});

// ── Config ──────────────────────────────────────────────────────────────────


ipcMain.handle('load-config', () => loadConfigSync());

ipcMain.handle('save-config', (_e, cfg) => {
  const existing = loadConfigSync();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...cfg }, null, 2));
  return { ok: true };
});

// ── Shared adb helper ───────────────────────────────────────────────────────

async function adb(serial, args, timeout = 8000) {
  const bin = await findBinary('adb');
  if (!bin) throw new Error('adb not found');
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(bin, fullArgs, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stdout + stderr).trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── Device info ─────────────────────────────────────────────────────────────

ipcMain.handle('get-device-info', async (_e, serial) => {
  try {
    const [batteryRaw, model, manufacturer, androidVer, resolutionRaw, ip] = await Promise.allSettled([
      adb(serial, ['shell', 'dumpsys', 'battery']),
      adb(serial, ['shell', 'getprop', 'ro.product.model']),
      adb(serial, ['shell', 'getprop', 'ro.product.manufacturer']),
      adb(serial, ['shell', 'getprop', 'ro.build.version.release']),
      adb(serial, ['shell', 'wm', 'size']),
      adb(serial, ['shell', 'ip', 'route']),
    ]);

    const val = r => r.status === 'fulfilled' ? r.value : '';

    const batteryText = val(batteryRaw);
    const levelMatch  = batteryText.match(/level:\s*(\d+)/);
    const chargeMatch = batteryText.match(/status:\s*(\d+)/);
    // Android battery status: 2=charging, 5=full
    const charging    = chargeMatch && ['2','5'].includes(chargeMatch[1].trim());
    const battery     = levelMatch ? parseInt(levelMatch[1]) : null;

    const resText  = val(resolutionRaw);
    const resMatch = resText.match(/Physical size:\s*(\d+x\d+)/);
    const resolution = resMatch ? resMatch[1] : null;

    const ipText   = val(ip);
    const wifiIp   = (ipText.match(/src ([\d.]+)/) || [])[1] || null;

    return {
      ok: true,
      battery, charging,
      model:        val(model),
      manufacturer: val(manufacturer),
      androidVer:   val(androidVer),
      resolution,
      wifiIp,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── One-click WiFi switch ────────────────────────────────────────────────────

ipcMain.handle('wifi-switch', async (_e, serial) => {
  try {
    // 1. Get WiFi IP before switching (device may not respond after tcpip)
    const ipOut = await adb(serial, ['shell', 'ip', 'route']);
    const ip = (ipOut.match(/src ([\d.]+)/) || [])[1];
    if (!ip) return { ok: false, error: 'Could not detect WiFi IP. Is the device on WiFi?' };

    // 2. Switch to TCP/IP mode
    await adb(serial, ['tcpip', '5555']);
    await new Promise(r => setTimeout(r, 1500)); // give device time to restart adb

    // 3. Connect wirelessly
    const bin = await findBinary('adb');
    const connectOut = await new Promise((resolve, reject) => {
      execFile(bin, ['connect', `${ip}:5555`], { timeout: 10000 }, (err, stdout, stderr) => {
        resolve((stdout + stderr).trim());
      });
    });

    if (connectOut.toLowerCase().includes('failed') || connectOut.toLowerCase().includes('unable')) {
      return { ok: false, error: connectOut };
    }

    return { ok: true, ip, address: `${ip}:5555`, message: connectOut };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Quick actions ────────────────────────────────────────────────────────────

const KEYEVENTS = {
  home: 3, back: 4, recents: 187,
  volup: 24, voldown: 25, power: 26,
  rotate: 193, mute: 164, screenshot: 120,
};

ipcMain.handle('keyevent', async (_e, action, serial) => {
  const code = KEYEVENTS[action];
  if (!code) return { ok: false, error: `Unknown action: ${action}` };
  try {
    await adb(serial, ['shell', 'input', 'keyevent', String(code)]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Screenshot to folder ─────────────────────────────────────────────────────

ipcMain.handle('device-screenshot', async (_e, serial) => {
  const destDir = path.join(os.homedir(), 'Pictures', 'scrcpy-screenshots');
  fs.mkdirSync(destDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destFile  = path.join(destDir, `screenshot-${timestamp}.png`);

  const bin = await findBinary('adb');
  if (!bin) return { ok: false, error: 'adb not found' };

  return new Promise((resolve) => {
    const args = serial ? ['-s', serial, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
    const proc = spawn(bin, args);
    const out  = fs.createWriteStream(destFile);
    proc.stdout.pipe(out);
    proc.on('close', code => {
      if (code !== 0) { try { fs.unlinkSync(destFile); } catch {} return resolve({ ok: false, error: `adb exited ${code}` }); }
      resolve({ ok: true, path: destFile });
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// ── APK installer ────────────────────────────────────────────────────────────

ipcMain.handle('pick-apk', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select APK to install',
    filters: [{ name: 'Android Package', extensions: ['apk'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('install-apk', async (_e, apkPath, serial) => {
  const bin = await findBinary('adb');
  if (!bin) return { ok: false, error: 'adb not found' };

  mainWindow.webContents.send('apk-progress', { phase: 'installing', detail: path.basename(apkPath) });

  return new Promise((resolve) => {
    const args = serial
      ? ['-s', serial, 'install', '-r', apkPath]
      : ['install', '-r', apkPath];

    const proc = spawn(bin, args);
    let output = '';
    proc.stdout.on('data', d => { output += d; mainWindow.webContents.send('apk-progress', { phase: 'output', detail: d.toString() }); });
    proc.stderr.on('data', d => { output += d; mainWindow.webContents.send('apk-progress', { phase: 'output', detail: d.toString() }); });
    proc.on('close', code => {
      const success = output.includes('Success');
      mainWindow.webContents.send('apk-progress', { phase: success ? 'done' : 'error', detail: output.trim() });
      resolve({ ok: success, output: output.trim() });
    });
  });
});

// ── App launcher ─────────────────────────────────────────────────────────────

ipcMain.handle('list-apps', async (_e, serial) => {
  try {
    const out = await adb(serial, ['shell', 'pm', 'list', 'packages', '-3']);
    const packages = out.split('\n')
      .map(l => l.replace('package:', '').trim())
      .filter(Boolean)
      .sort();
    return { ok: true, packages };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-app', async (_e, pkg, serial) => {
  try {
    await adb(serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('force-stop-app', async (_e, pkg, serial) => {
  try {
    await adb(serial, ['shell', 'am', 'force-stop', pkg]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── ADB terminal ─────────────────────────────────────────────────────────────

ipcMain.handle('shell-command', async (_e, cmd, serial) => {
  const bin = await findBinary('adb');
  if (!bin) return { ok: false, error: 'adb not found' };

  return new Promise((resolve) => {
    const args = serial
      ? ['-s', serial, 'shell', cmd]
      : ['shell', cmd];

    execFile(bin, args, { timeout: 15000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout + (err ? stderr : '')).trimEnd() });
    });
  });
});

// ── Logcat ───────────────────────────────────────────────────────────────────

let logcatProc = null;

ipcMain.handle('start-logcat', async (_e, serial, tag, level) => {
  if (logcatProc) { logcatProc.kill(); logcatProc = null; }

  const bin = await findBinary('adb');
  if (!bin) return { ok: false, error: 'adb not found' };

  const args = serial ? ['-s', serial, 'logcat'] : ['logcat'];
  if (tag)   args.push('-s', `${tag}:${level || 'V'}`);
  else       args.push('-v', 'brief');
  if (level && !tag) args.push(`*:${level}`);

  logcatProc = spawn(bin, args);
  logcatProc.stdout.on('data', d => mainWindow?.webContents.send('logcat-line', d.toString()));
  logcatProc.stderr.on('data', d => mainWindow?.webContents.send('logcat-line', d.toString()));
  logcatProc.on('close', () => { logcatProc = null; mainWindow?.webContents.send('logcat-stopped'); });
  return { ok: true };
});

ipcMain.handle('stop-logcat', () => {
  if (logcatProc) { logcatProc.kill(); logcatProc = null; }
  return { ok: true };
});

// ── Session history ──────────────────────────────────────────────────────────

const SESSIONS_PATH = path.join(os.homedir(), '.scrcpy-gui-sessions.json');

function loadSessions()  { try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch { return []; } }
function saveSessions(s) { fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2)); }

ipcMain.handle('get-sessions',    () => loadSessions());
ipcMain.handle('clear-sessions',  () => { saveSessions([]); return { ok: true }; });
ipcMain.handle('log-session', (_e, session) => {
  const sessions = loadSessions();
  sessions.unshift({ ...session, id: Date.now() });
  if (sessions.length > 100) sessions.splice(100);
  saveSessions(sessions);
  return { ok: true };
});

// ── Auto-reconnect ────────────────────────────────────────────────────────────

let reconnectTimer   = null;
let reconnectSerial  = null;
let reconnectOpts    = null;

function stopReconnectWatch() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  reconnectSerial = null;
  reconnectOpts   = null;
}

async function checkReconnect() {
  if (!reconnectSerial) return;
  try {
    const out = await adb(null, ['devices']);
    const lines = out.split('\n').slice(1);
    const back  = lines.some(l => l.includes(reconnectSerial) && l.includes('\tdevice'));
    if (!back) return;
    stopReconnectWatch();
    mainWindow?.webContents.send('device-reconnected', reconnectSerial);
    // Re-launch with same opts
    if (reconnectOpts) {
      const scrcpyPath = await findBinary('scrcpy');
      if (!scrcpyPath) return;
      const args = buildArgs(reconnectOpts);
      scrcpyProcess = spawn(scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      mainWindow?.webContents.send('scrcpy-status', 'running');
      scrcpyProcess.stderr.on('data', d => mainWindow?.webContents.send('scrcpy-log', d.toString()));
      scrcpyProcess.on('close', code => {
        scrcpyProcess = null;
        mainWindow?.webContents.send('scrcpy-status', 'stopped');
        mainWindow?.webContents.send('scrcpy-log', `\n[scrcpy exited with code ${code}]\n`);
      });
    }
  } catch {}
}

ipcMain.handle('start-reconnect-watch', (_e, serial, opts) => {
  reconnectSerial = serial;
  reconnectOpts   = opts;
  reconnectTimer  = setInterval(checkReconnect, 3000);
  return { ok: true };
});

ipcMain.handle('stop-reconnect-watch', () => { stopReconnectWatch(); return { ok: true }; });

// ── Multi-device sessions ────────────────────────────────────────────────────

const extraSessions = new Map(); // serial -> { process, startTime }

ipcMain.handle('launch-extra', async (_e, serial, opts) => {
  if (extraSessions.has(serial)) return { ok: false, error: 'Already running for this device' };

  const scrcpyPath = await findBinary('scrcpy');
  if (!scrcpyPath) return { ok: false, error: 'scrcpy not found' };

  const adbPath = await findBinary('adb');
  const env = { ...process.env };
  if (adbPath) env.PATH = `${path.dirname(adbPath)}:${env.PATH}`;

  const args = buildArgs({ ...opts, serial });
  const proc = spawn(scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  extraSessions.set(serial, { process: proc, startTime: Date.now() });

  proc.on('close', () => {
    extraSessions.delete(serial);
    mainWindow?.webContents.send('extra-session-stopped', serial);
  });

  return { ok: true };
});

ipcMain.handle('stop-extra', (_e, serial) => {
  const s = extraSessions.get(serial);
  if (s) { s.process.kill(); extraSessions.delete(serial); }
  return { ok: true };
});

ipcMain.handle('list-extra-sessions', () =>
  [...extraSessions.keys()].map(serial => ({
    serial,
    startTime: extraSessions.get(serial).startTime,
  }))
);

// ── Presets ───────────────────────────────────────────────────────────────────

const DEFAULT_PRESETS = [
  { id: 'low-latency',  name: 'Low Latency',  builtIn: true, opts: { maxSize: 720,  maxFps: 60,  videoBitrate: 4,  videoCodec: 'h264', noAudio: false } },
  { id: 'high-quality', name: 'High Quality', builtIn: true, opts: { maxSize: 1080, maxFps: 60,  videoBitrate: 20, videoCodec: 'h265' } },
  { id: 'screencast',   name: 'Screencast',   builtIn: true, opts: { maxSize: 1080, maxFps: 30,  videoBitrate: 8,  noControl: true } },
  { id: 'gaming',       name: 'Gaming',       builtIn: true, opts: { maxSize: 0,    maxFps: 60,  videoBitrate: 16, stayAwake: true, showTouches: false } },
];

ipcMain.handle('get-presets', () => {
  const cfg = loadConfigSync();
  return [...DEFAULT_PRESETS, ...(cfg.customPresets || [])];
});

ipcMain.handle('save-preset', (_e, name, opts) => {
  const cfg = loadConfigSync();
  const customs = cfg.customPresets || [];
  const id = `custom-${Date.now()}`;
  customs.push({ id, name, builtIn: false, opts });
  cfg.customPresets = customs;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return { ok: true, id };
});

ipcMain.handle('delete-preset', (_e, id) => {
  const cfg = loadConfigSync();
  cfg.customPresets = (cfg.customPresets || []).filter(p => p.id !== id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return { ok: true };
});

// ── Update checker ────────────────────────────────────────────────────────────

ipcMain.handle('check-update', async () => {
  try {
    const release  = await fetchJson('https://api.github.com/repos/Genymobile/scrcpy/releases/latest');
    const latest   = release.tag_name?.replace(/^v/, '') || '';
    const scrcpyBin = await findBinary('scrcpy');
    let current = null;
    if (scrcpyBin) {
      current = await new Promise(resolve => {
        execFile(scrcpyBin, ['--version'], { timeout: 3000 }, (err, stdout) => {
          const m = stdout.match(/scrcpy\s+([\d.]+)/i);
          resolve(m ? m[1] : null);
        });
      });
    }
    return { ok: true, latest, current, hasUpdate: latest && current && latest !== current };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── System tray ───────────────────────────────────────────────────────────────

let tray = null;

function buildTrayMenu() {
  const { Menu, nativeImage } = require('electron');
  return Menu.buildFromTemplate([
    {
      label: scrcpyProcess ? 'Running — click to show' : 'scrcpy GUI',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Show Window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    {
      label: 'Quick Launch',
      click: async () => {
        const cfg = loadConfigSync();
        if (!cfg || Object.keys(cfg).length === 0) {
          mainWindow?.show();
          return;
        }
        mainWindow?.webContents.send('tray-quick-launch', cfg);
        mainWindow?.show();
      },
    },
    { type: 'separator' },
    {
      label: 'Stop Session',
      enabled: !!scrcpyProcess,
      click: () => { if (scrcpyProcess) { scrcpyProcess.kill(); scrcpyProcess = null; } },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { if (scrcpyProcess) scrcpyProcess.kill(); app.quit(); } },
  ]);
}

function setupTray() {
  const { Tray, nativeImage } = require('electron');
  // Minimal 1x1 template image — macOS renders it as a menu bar icon
  const img = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScAAAAAElFTkSuQmCC'
  );
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('scrcpy GUI');
  tray.setTitle(' S');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// Refresh tray menu when session state changes
function refreshTray() {
  tray?.setContextMenu(buildTrayMenu());
  tray?.setTitle(scrcpyProcess ? ' ◉ S' : ' S');
}

// ── Build CLI args ──────────────────────────────────────────────────────────

function buildArgs(opts) {
  const args = [];
  if (opts.serial) args.push('--serial', opts.serial);
  if (opts.maxSize) args.push('--max-size', String(opts.maxSize));
  if (opts.maxFps) args.push('--max-fps', String(opts.maxFps));
  if (opts.videoBitrate) args.push('--video-bit-rate', `${opts.videoBitrate}M`);
  if (opts.videoCodec && opts.videoCodec !== 'default') args.push('--video-codec', opts.videoCodec);
  if (opts.videoSource === 'camera') {
    args.push('--video-source', 'camera');
    if (opts.cameraFacing && opts.cameraFacing !== 'default') args.push('--camera-facing', opts.cameraFacing);
  }
  if (opts.orientation && opts.orientation !== 'default') args.push('--orientation', opts.orientation);
  if (opts.noAudio) { args.push('--no-audio'); }
  else {
    if (opts.audioSource && opts.audioSource !== 'default') args.push('--audio-source', opts.audioSource);
    if (opts.audioCodec && opts.audioCodec !== 'default') args.push('--audio-codec', opts.audioCodec);
  }
  if (opts.fullscreen) args.push('--fullscreen');
  if (opts.alwaysOnTop) args.push('--always-on-top');
  if (opts.borderless) args.push('--window-borderless');
  if (opts.windowTitle) args.push('--window-title', opts.windowTitle);
  if (opts.noControl) args.push('--no-control');
  if (opts.turnScreenOff) args.push('--turn-screen-off');
  if (opts.stayAwake) args.push('--stay-awake');
  if (opts.showTouches) args.push('--show-touches');
  if (opts.keyboardMode && opts.keyboardMode !== 'default') args.push('--keyboard', opts.keyboardMode);
  if (opts.mouseMode && opts.mouseMode !== 'default') args.push('--mouse', opts.mouseMode);
  if (opts.record && opts.recordPath) {
    args.push('--record', opts.recordPath);
    if (opts.recordFormat && opts.recordFormat !== 'mp4') args.push('--record-format', opts.recordFormat);
  }
  return args;
}
