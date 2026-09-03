# A Hard Time Launcher

A Hard Time Launcher installs and updates the A Hard Time Minecraft modpack with a CurseForge-style pack import flow. The launcher creates its own managed Minecraft instance, downloads required files from the hosted update feed, and opens the CurseForge Minecraft Launcher when available, with the official Minecraft Launcher as a fallback.

## Downloads

Use the build made for your operating system:

- Windows 10/11: NSIS installer
- macOS: one universal DMG for both Apple Silicon and Intel Macs
- Linux x64: one portable AppImage for mainstream desktop distributions

Players do not need Node.js, Git, Wrangler, or terminal commands to use a packaged build.

## Install Locations

The launcher manages the modpack in its own folder:

- Windows 10/11: `C:\AHT\A Hard Time`
- macOS: `~/Library/Application Support/A Hard Time/Instance`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/A Hard Time/Instance`

The app also writes a Minecraft Launcher profile that points at that managed folder as `gameDir`.

## Player Flow

The launcher handles installation, updates, repair, and game startup through its desktop interface.

## Launcher Updates

The launcher checks its own update feed on startup. When a launcher update is required, the app shows an update overlay and downloads the correct Windows, universal macOS, or portable Linux package. Linux AppImage updates are applied and reopened by the launcher without requiring a distribution-specific package manager.

## Build Targets

The repository builds player launchers for Windows, macOS, and Linux:

- Windows 10/11: `npm run dist:regular:windows`
- universal macOS (Intel + Apple Silicon): `npm run dist:regular:macos`
- portable Linux x64 AppImage: `npm run dist:regular:linux`

The Linux build also emits a non-public DEB compatibility bridge so launchers installed from releases before 0.2.02 can update once to the portable AppImage line. Only the AppImage is offered as the Linux download.

GitHub Actions can build the platform packages and publish player launcher release assets.

Release labels and artifact filenames use `package.json`'s `ahtLauncherVersion` (for example, `0.2.01`). The separate npm `version` stays valid SemVer for Electron's packaging tools and must not be used as the public launcher version.

## Verification

Useful checks for player builds:

```bash
npm run test:platforms
npm run test:platform-builds
npm run test:profile
npm run test:cache-fallback
npm run test:resourcepack-placement
npm run test:launcher-update-manifest
```

`npm run test:resourcepack-placement` verifies that resourcepack ZIPs are installed into `resourcepacks/` and real mod ZIPs stay in `mods/`.
