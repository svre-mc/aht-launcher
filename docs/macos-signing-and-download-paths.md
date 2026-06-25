# macOS Signing and Download Paths

Developer name: `au Savant`

The macOS build is produced by GitHub Actions on a real macOS runner. The build can still produce unsigned test DMGs, but signed public releases need Apple certificate secrets added to the GitHub repository.

## GitHub Repository

- Repository: `https://github.com/svre-mc/aht-launcher`
- Workflow file: `.github/workflows/build-macos.yml`
- Workflow name: `Build and Publish Launchers`
- GitHub Release tag: `launcher-v<package.json version>`
- macOS build artifact name: `aht-launcher-macos`

## Required GitHub Secrets for macOS Signing

Add these in GitHub repo settings under `Settings > Secrets and variables > Actions`.

- `APPLE_CERTIFICATE_BASE64`: base64 of the Apple `Developer ID Application` `.p12` certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12` certificate.
- `APPLE_DEVELOPER_IDENTITY`: exact signing identity, usually `Developer ID Application: au Savant (TEAMID)`.

## Optional GitHub Secrets for macOS Notarization

Use Apple API key notarization when possible:

- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Apple ID notarization fallback:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Keychain notarization fallback:

- `APPLE_KEYCHAIN`
- `APPLE_KEYCHAIN_PROFILE`

## Build Outputs

Local download folder for manually downloaded macOS builds:

- `C:\Users\evil\Documents\Codex\2026-06-23\i-w\outputs\macos`

Expected macOS GitHub Release asset names after the next build:

- `AHT-Launcher-macOS-arm64-0.1.1.dmg`
- `AHT-Launcher-macOS-x64-0.1.1.dmg`

Recommended website paths:

- `/downloads/AHT-Launcher-macOS-arm64.dmg`
- `/downloads/AHT-Launcher-macOS-x64.dmg`
- `/downloads/AHT-Launcher-Windows-10-11.exe`
- `/downloads/AHT-Launcher-Ubuntu-x64.AppImage`
- `/downloads/AHT-Launcher-Ubuntu-x64.deb`

## Prompt for Website Codex Chat

```text
Use the AHT launcher builds from the GitHub repository `https://github.com/svre-mc/aht-launcher`.

For macOS, pull the latest `launcher-v<version>` GitHub Release assets. It contains:
- Apple Silicon: `AHT-Launcher-macOS-arm64-0.1.1.dmg`
- Intel: `AHT-Launcher-macOS-x64-0.1.1.dmg`

Upload/serve them from these website paths:
- `/downloads/AHT-Launcher-macOS-arm64.dmg`
- `/downloads/AHT-Launcher-macOS-x64.dmg`

Use these labels on the website:
- `Download for macOS Apple Silicon`
- `Download for macOS Intel`

Also reserve these paths for the other platform builds:
- Windows 10/11: `/downloads/AHT-Launcher-Windows-10-11.exe`
- Ubuntu/Linux AppImage: `/downloads/AHT-Launcher-Ubuntu-x64.AppImage`
- Ubuntu/Linux deb: `/downloads/AHT-Launcher-Ubuntu-x64.deb`

When the launcher version changes, replace the files behind the same stable website paths so website download links do not need to change.
```
