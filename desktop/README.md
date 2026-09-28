# School Manager — Desktop app (Windows, Mac, Linux)

This wraps School Manager in its own window using [Electron](https://electronjs.org) — a proper
app with a taskbar/dock icon, no browser tab or address bar. When it opens, it starts the same
`server.js` your browser version uses, in the background, and shows it in the window. It still
needs **Node.js** installed on this computer (the same requirement as the plain browser version's
`start.bat`) — it uses that to run the server.

## Try it

```
cd desktop
npm install
npm start
```

A window opens with the sign-in screen. Your data is stored separately from the browser
version, in this app's own folder (Windows: `%APPDATA%\School Manager`, Mac:
`~/Library/Application Support/School Manager`, Linux: `~/.config/School Manager`) — use
**Help → Open data folder** in the app's menu to find it, and back that folder up the same way
you'd back up `data/` for the browser version.

## Build an installer to share

```
npm run dist
```

This must be run **on the operating system you want an installer for** — build the Windows
installer on Windows, the Mac one on a Mac, the Linux one on Linux (this is a limitation of
how installers are made, not of this app). Each run produces a ready-to-share file in
`desktop/dist/`:

| Built on | You get |
|---|---|
| Windows | `School Manager Setup.exe` |
| Mac | `School Manager.dmg` |
| Linux | `.AppImage` and `.deb` |

Anyone who runs that installer still needs Node.js on their computer — the installer doesn't
include it. If that's not workable for the people you're sharing this with, the plain browser
version (`start.bat` in the project root) is the simpler option, since it's the same requirement
without a separate app to install.

## Re-branding

Replace `icons/icon-512.png` (and `icons/icon.ico` for Windows) with your own square icon, then
run `npm run dist` again.
