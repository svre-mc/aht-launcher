# A Hard Time Launcher

A Hard Time Launcher installs and updates the A Hard Time Minecraft modpack with a CurseForge-style pack import flow. The launcher creates its own managed Minecraft instance, downloads required files from the hosted update feed, and opens the CurseForge Minecraft Launcher when available, with the official Minecraft Launcher as a fallback.

## Downloads

Use the build made for your operating system:

- Windows 10/11: NSIS installer
- macOS: DMG package for Apple Silicon and Intel Macs

Players do not need Node.js, Git, Wrangler, or terminal commands to use a packaged build.

## Install Locations

The launcher manages the modpack in its own folder:

- Windows 10/11: `C:\AHT\A Hard Time`
- macOS: `~/Library/Application Support/A Hard Time/Instance`

The app also writes a Minecraft Launcher profile that points at that managed folder as `gameDir`.

## Player Flow

The launcher handles installation, updates, repair, and game startup through its desktop interface.

## Launcher Updates

The launcher checks its own update feed on startup. When a launcher update is required, the app shows an update overlay, downloads the correct installer/package for Windows or macOS, applies the update, and restarts.

## Build Targets

The repository builds player launchers for Windows and macOS only:

- Windows 10/11: `npm run dist:regular:windows`
- macOS: `npm run dist:regular:macos`

GitHub Actions can build the platform packages and publish player launcher release assets.

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
