# Launcher Update Automation

Launcher app updates are automated through GitHub Actions.

## What Happens On Push

When launcher source changes are pushed to `main`, the workflow `.github/workflows/build-macos.yml` runs as `Build and Publish Launchers`.

It does this in order:

1. Builds the Windows 10/11 installer on a Windows runner.
2. Builds macOS Apple Silicon and Intel DMGs on a macOS runner.
3. Builds Ubuntu/Linux AppImage and deb packages on an Ubuntu runner.
4. Creates or updates the GitHub Release named `launcher-v<package.json version>`.
5. Uploads all launcher installers to that GitHub Release.
6. Generates `launcher/latest.json`.
7. Uploads launcher installer files to Cloudflare R2.
8. Uploads `launcher/latest.json` last, so player launchers only see the update after every installer is already available.

Player launchers read:

- `https://aht-curseforge-proxy.mysticgamer312.workers.dev/launcher/latest.json`

## Required Version Rule

Always bump `package.json` before pushing a real launcher update.

The player launcher only forces an app update when the hosted launcher version is higher than the installed app version. Re-publishing the same version updates GitHub/R2 files, but already-installed players will not be forced to update.

## GitHub Release

Release tag format:

- `launcher-v0.1.1`
- `launcher-v0.1.2`
- `launcher-v0.1.3`

Release assets:

- `AHT-Launcher-Windows-10-11-<version>.exe`
- `AHT-Launcher-macOS-arm64-<version>.dmg`
- `AHT-Launcher-macOS-x64-<version>.dmg`
- `AHT-Launcher-Ubuntu-<version>-x64.AppImage`
- `AHT-Launcher-Ubuntu-<version>-x64.deb`
- `launcher-latest.json`

If the release already exists, the workflow updates the release notes and replaces the assets.

## Required GitHub Secrets

For R2 publishing:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

For macOS signing:

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_DEVELOPER_IDENTITY`

For macOS notarization, use either Apple API key secrets:

- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

or Apple ID secrets:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## GitHub Variables

Optional repo variables:

- `AHT_R2_BUCKET`: defaults to `ahtlauncher`
- `AHT_LAUNCHER_UPDATE_URL`: defaults to `https://aht-curseforge-proxy.mysticgamer312.workers.dev/launcher/latest.json`

## Manual Run

The workflow can be run manually from GitHub Actions. Manual runs can disable R2 upload with `publish_to_r2=false`; GitHub Release assets are still created or updated.

## Local Validation

Run:

```bash
npm run test:launcher-update-manifest
npm run test:platform-builds
```

These tests validate the launcher update manifest shape and platform build configs. They do not upload to GitHub or R2.
