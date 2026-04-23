# scrcpy GUI

A desktop app for mirroring and controlling Android devices — built on top of [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile.

No terminal required. Connect, mirror, control, and manage your Android device through a clean interface.

---

## Download

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | [scrcpy-gui-mac-arm64.dmg](https://github.com/Scottlexium/scrcpy/releases/latest) |
| macOS (Intel) | [scrcpy-gui-mac-x64.dmg](https://github.com/Scottlexium/scrcpy/releases/latest) |
| Windows | [scrcpy-gui-win-x64.exe](https://github.com/Scottlexium/scrcpy/releases/latest) |
| Linux (AppImage) | [scrcpy-gui-linux-x64.AppImage](https://github.com/Scottlexium/scrcpy/releases/latest) |
| Linux (deb) | [scrcpy-gui-linux-x64.deb](https://github.com/Scottlexium/scrcpy/releases/latest) |

→ **[All releases](https://github.com/Scottlexium/scrcpy/releases)**

---

## Features

- **Auto-install ADB and scrcpy** — detects missing dependencies and downloads them to standard system locations on first launch, no terminal required
- **One-click WiFi switch** — connect over USB once, switch to wireless automatically
- **Device info widget** — battery, model, Android version, resolution, and IP address shown while connected
- **Presets** — built-in Low Latency, High Quality, Screencast, and Gaming profiles; save custom ones
- **Quick actions** — Home, Back, Recents, Volume, Screenshot, Rotate, Lock while mirroring
- **APK sideloader** — drag and drop `.apk` files onto the window to install instantly
- **App launcher** — browse installed apps, launch or force-stop with one click
- **ADB terminal** — run shell commands directly inside the app with command history
- **Logcat viewer** — stream device logs with tag/level filtering and colour-coded output
- **Auto-reconnect** — watches for device reconnect and re-launches automatically
- **Multi-device** — run simultaneous sessions across multiple connected devices
- **Session history** — log of past sessions with device, duration, and settings
- **System tray** — minimize to tray, quick-launch from menu bar
- **Broken screen recovery** — OTG input mode (no authorization required), wireless pairing wizard, and ADB key export

---

## Requirements

- macOS 12+, Windows 10+, or Linux (x86-64)
- Android device with **USB debugging** enabled
- USB cable for initial connection (wireless after first connect)

USB debugging is found at: **Settings → Developer Options → USB Debugging**. If Developer Options is hidden, go to **Settings → About Phone** and tap **Build Number** seven times.

---

## Installation notes

### macOS — Gatekeeper warning

On first launch macOS may block the app because it is not signed with a paid Apple certificate.

**Fix:** In Finder (not Launchpad), right-click the app → **Open** → click **Open**. You only need to do this once.

If the option does not appear, go to **System Settings → Privacy & Security** and click **Open Anyway**.

### Windows — SmartScreen warning

Windows may show a blue "Windows protected your PC" dialog.

**Fix:** Click **More info** → **Run anyway**.

### Linux — AppImage permissions

```bash
chmod +x scrcpy-gui-linux-x64.AppImage
./scrcpy-gui-linux-x64.AppImage
```

---

## Running from source

Requires [Node.js](https://nodejs.org) v18 or later.

```bash
git clone https://github.com/Scottlexium/scrcpy.git
cd scrcpy/gui
npm install
npm start
```

## Building a distributable

```bash
cd gui

# All platforms
npm run build

# Platform-specific
npm run build:mac
npm run build:win
npm run build:linux
```

Output is written to `gui/dist/`. The build script generates all icon formats from `gui/assets/icon.svg` before invoking electron-builder.

---

## Project structure

```
scrcpy/
├── gui/                  Electron GUI
│   ├── main.js           Main process (IPC, ADB, subprocess management)
│   ├── preload.js        Context bridge
│   ├── index.html        Renderer (all UI)
│   ├── assets/
│   │   ├── icon.svg      Source icon
│   │   └── icons/        Generated platform icons (icns, ico, png)
│   ├── scripts/
│   │   └── gen-icons.js  Icon generation script
│   └── package.json
├── app/                  scrcpy C source (upstream)
└── server/               Android server (upstream)
```

---

## How ADB and scrcpy are installed

When the app detects that ADB or scrcpy are missing it offers to install them automatically.

**ADB (Android Platform Tools)** is downloaded from Google and installed to:
- macOS: `~/Library/Android/sdk/platform-tools/`
- Linux: `~/Android/Sdk/platform-tools/`
- Windows: `%LOCALAPPDATA%\Android\sdk\platform-tools\`

**scrcpy** is downloaded from the [latest GitHub release](https://github.com/Genymobile/scrcpy/releases/latest) and installed to:
- macOS: `~/Library/Application Support/scrcpy/`
- Linux: `~/.local/share/scrcpy/`
- Windows: `%LOCALAPPDATA%\scrcpy\`

Both directories are added to your shell PATH automatically.

---

## License

The GUI code in `gui/` is released under the **Apache License 2.0**, the same license as the upstream scrcpy project.

scrcpy is developed and maintained by [Genymobile](https://github.com/Genymobile/scrcpy). This repository is an independent fork that adds a graphical interface.
