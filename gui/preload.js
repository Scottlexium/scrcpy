const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scrcpy', {
  // Core
  listDevices:      ()         => ipcRenderer.invoke('list-devices'),
  launch:           (opts)     => ipcRenderer.invoke('launch-scrcpy', opts),
  stop:             ()         => ipcRenderer.invoke('stop-scrcpy'),
  pauseRecording:   ()         => ipcRenderer.invoke('pause-recording'),
  resumeRecording:  ()         => ipcRenderer.invoke('resume-recording'),
  pickFile:       ()           => ipcRenderer.invoke('pick-file'),
  loadConfig:     ()           => ipcRenderer.invoke('load-config'),
  saveConfig:     (cfg)        => ipcRenderer.invoke('save-config', cfg),

  // Device info & actions
  getDeviceInfo:  (serial)           => ipcRenderer.invoke('get-device-info', serial),
  wifiSwitch:     (serial)           => ipcRenderer.invoke('wifi-switch', serial),
  keyevent:       (action, serial)   => ipcRenderer.invoke('keyevent', action, serial),
  screenshot:     (serial)           => ipcRenderer.invoke('device-screenshot', serial),

  // APK
  pickApk:        ()                 => ipcRenderer.invoke('pick-apk'),
  installApk:     (path, serial)     => ipcRenderer.invoke('install-apk', path, serial),

  // Apps
  listApps:       (serial)           => ipcRenderer.invoke('list-apps', serial),
  launchApp:      (pkg, serial)      => ipcRenderer.invoke('launch-app', pkg, serial),
  forceStopApp:   (pkg, serial)      => ipcRenderer.invoke('force-stop-app', pkg, serial),

  // Terminal
  shellCommand:   (cmd, serial)      => ipcRenderer.invoke('shell-command', cmd, serial),

  // Logcat
  startLogcat:    (serial, tag, lvl) => ipcRenderer.invoke('start-logcat', serial, tag, lvl),
  stopLogcat:     ()                 => ipcRenderer.invoke('stop-logcat'),

  // Sessions
  getSessions:    ()                 => ipcRenderer.invoke('get-sessions'),
  clearSessions:  ()                 => ipcRenderer.invoke('clear-sessions'),

  // Auto-reconnect
  startReconnectWatch: (serial, opts) => ipcRenderer.invoke('start-reconnect-watch', serial, opts),
  stopReconnectWatch:  ()             => ipcRenderer.invoke('stop-reconnect-watch'),

  // Multi-device
  launchExtra:    (serial, opts)     => ipcRenderer.invoke('launch-extra', serial, opts),
  stopExtra:      (serial)           => ipcRenderer.invoke('stop-extra', serial),
  listExtraSessions: ()              => ipcRenderer.invoke('list-extra-sessions'),

  // Presets
  getPresets:     ()                 => ipcRenderer.invoke('get-presets'),
  savePreset:     (name, opts)       => ipcRenderer.invoke('save-preset', name, opts),
  deletePreset:   (id)               => ipcRenderer.invoke('delete-preset', id),

  // Update checker
  checkUpdate:    ()                 => ipcRenderer.invoke('check-update'),

  // Dependency management
  checkDeps:      ()                 => ipcRenderer.invoke('check-deps'),
  openUrl:        (url)              => ipcRenderer.invoke('open-url', url),
  pickBinary:     (name)             => ipcRenderer.invoke('pick-binary', name),
  saveBinaryPath: (name, p)          => ipcRenderer.invoke('save-binary-path', name, p),
  downloadAdb:    ()                 => ipcRenderer.invoke('download-adb'),
  downloadScrcpy: ()                 => ipcRenderer.invoke('download-scrcpy'),
  removeTool:     (name)             => ipcRenderer.invoke('remove-tool', name),

  // Broken screen
  launchOtg:       (serial)          => ipcRenderer.invoke('launch-otg', serial),
  stopOtg:         ()                => ipcRenderer.invoke('stop-otg'),
  wirelessPair:    (ip, port, code)  => ipcRenderer.invoke('wireless-pair', ip, port, code),
  wirelessConnect: (ip, port)        => ipcRenderer.invoke('wireless-connect', ip, port),
  getAdbPubkey:    ()                => ipcRenderer.invoke('get-adb-pubkey'),

  // Events
  onStatus:            (cb) => ipcRenderer.on('scrcpy-status',       (_e, v) => cb(v)),
  onLog:               (cb) => ipcRenderer.on('scrcpy-log',          (_e, v) => cb(v)),
  onOtgLog:            (cb) => ipcRenderer.on('otg-log',             (_e, v) => cb(v)),
  onOtgStopped:        (cb) => ipcRenderer.on('otg-stopped',         (_e, v) => cb(v)),
  onDownloadProgress:  (cb) => ipcRenderer.on('download-progress',   (_e, v) => cb(v)),
  onApkProgress:       (cb) => ipcRenderer.on('apk-progress',        (_e, v) => cb(v)),
  onLogcatLine:        (cb) => ipcRenderer.on('logcat-line',         (_e, v) => cb(v)),
  onLogcatStopped:     (cb) => ipcRenderer.on('logcat-stopped',      ()      => cb()),
  onDeviceReconnected: (cb) => ipcRenderer.on('device-reconnected',  (_e, v) => cb(v)),
  onExtraSessionStop:  (cb) => ipcRenderer.on('extra-session-stopped',(_e,v) => cb(v)),
  onTrayQuickLaunch:   (cb) => ipcRenderer.on('tray-quick-launch',   (_e, v) => cb(v)),
});
