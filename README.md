# A Hard Time Launcher

Cross-platform desktop launcher/update tooling for A Hard Time.

The player app installs and updates the modpack from a CurseForge export ZIP model. The developer app builds new releases, uploads them to Cloudflare R2 through Wrangler, and reads install/change telemetry from the Cloudflare Worker. The same Worker can serve `latest.json`, pack ZIPs, fallback cache files, and server artifacts from R2.

## App Targets

- Windows 10/11 regular launcher: NSIS installer from `npm run dist:regular:windows`
- macOS regular launcher: DMG app package from `npm run dist:regular:macos`
- Ubuntu/Linux regular launcher: AppImage and `.deb` from `npm run dist:regular:ubuntu`

Players do not need Node.js or terminal commands once the app is packaged.

## Developer Setup On Ubuntu Desktop

```bash
cd /opt/aht-launcher
npm ci
chmod +x scripts/*.sh
npx wrangler login
```

Start the normal player app:

```bash
npm start
```

Start the developer app:

```bash
npm run start:dev
```

The developer tab is only visible in developer mode.

## Package Desktop Apps

The developer app can write the player defaults for you after Cloudflare is set up. In developer mode:

1. Log in with the developer credentials.
2. Open `Release Builder`.
3. Pick the CurseForge export ZIP.
4. Enter the CurseForge API key.
5. Click `Setup Cloud` once for the Worker/R2 setup.
6. If the Worker already exists and you only need fresh installs to know the feed URL, enter the Player Feed URL and click `Write Defaults`; this writes `app.defaults.json` without uploading a release.
7. Click `Publish Update` for each pack update.

`Publish Update` builds the release, validates the ZIP, uploads all artifacts to R2, uploads `latest.json` last, verifies the public Worker feed, and writes `app.defaults.json` with the Worker URLs players need.

If you are running the developer app from source before packaging, the generated defaults are written to `config/app.defaults.json` and get baked into the next installer build. If you are running the packaged developer app, the generated defaults are written beside the app as `app.defaults.json`; distribute that sidecar with an unpacked app, or rebuild the installer from source after copying those defaults into `config/app.defaults.json`.

You can also create the defaults manually from the example:

```bash
cp config/app.defaults.example.json config/app.defaults.json
```

The packaged app copies those defaults into the player's user config on first launch. It also reads a sidecar `app.defaults.json` beside the executable, which is useful for testing or unpacked builds.

The player app uses its own managed instance folder, so players do not need to pick a CurseForge instance path:

- Windows 10/11: `C:\AHT\A Hard Time`
- macOS: `~/Library/Application Support/A Hard Time/Instance`
- Ubuntu/Linux: `${XDG_DATA_HOME:-~/.local/share}/aht-launcher/A Hard Time`

For cloud production builds, ship the real Worker URLs in `config/app.defaults.json`; players download through the Worker, and the private R2 bucket stays behind the Worker's `AHT_RELEASES` binding. For local testing, use Settings > Latest Feed > Browse to point at a generated `latest.json`.

For the Ubuntu host, the packaged developer app is the preferred release tool. The shell wrapper is equivalent when `CACHE_MODS_DIR` is set:

```bash
PACK_ZIP="/srv/aht/uploads/A Hard Time Dregora-2.8.2.zip" \
BASE_URL="https://aht-curseforge-proxy.example.workers.dev" \
OUT_DIR="/opt/aht-launcher/dist-r2" \
CACHE_MODS_DIR="/opt/aht-launcher/curseforge/Instances/RLCraft Dregora/mods" \
scripts/build-release.sh
```

Build the Ubuntu/Linux regular launcher on Ubuntu:

```bash
sudo apt update
sudo apt install -y ruby ruby-dev build-essential
sudo gem install fpm
npm run dist:regular:ubuntu
```

Build the Windows 10/11 regular launcher on Windows:

```powershell
npm run dist:regular:windows
```

Build the macOS regular launcher on a Mac:

```bash
npm run dist:regular:macos
```

Cross-building macOS from Windows/Linux is not a reliable release path because signing/notarization requires macOS tooling.

Before distributing a player build, run:

```bash
npm run verify:local
npm run check:production
```

`npm run verify:local` runs the local profile, Worker, telemetry, account, install/repair, update-log, item-fire-fix, developer publish, player update, UI publish, and single-instance smoke checks. It does not require a real Cloudflare login because the R2/Worker path is tested with a local fake Wrangler and fake R2 host.

Use `npm run check:production:strict` when you want a non-zero exit code for automation. The check verifies required source files, R2 bucket names, packaged artifacts, desktop shortcuts on Windows, Wrangler availability/authentication, and whether a real non-local `app.defaults.json` exists for fresh player installs.

For OS-specific regular launcher behavior, `npm run test:platforms` verifies the Windows 10/11, macOS, and Ubuntu/Linux instance folders and package target labels.

For automated launcher app updates, `npm run test:launcher-update-manifest` verifies the GitHub/R2 `launcher/latest.json` manifest shape for Windows, macOS Apple Silicon, macOS Intel, and Ubuntu/Linux. The GitHub Actions workflow builds all platform launchers, creates or updates the `launcher-v<version>` GitHub Release, uploads release assets, uploads launcher files to R2, then uploads `launcher/latest.json` last.

For the first-time Cloudflare setup path, `npm run test:cloud-login` verifies that the developer app does not treat Wrangler's `You are not authenticated` output as a successful login, even when Wrangler exits with code 0.

For player config freedom, `npm run test:mod-only-changes` verifies that local-change reports and integrity scans ignore `config/` edits and only check files under `mods/`.

For the player launch gate, `npm run test:play-gate` verifies that Play runs a managed-mod integrity scan and refuses to open Minecraft when a required mod file is corrupted.

For the first-run player account gate, `npm run test:account-duplicate` verifies that duplicate Minecraft usernames stay blocked with `That username is not available.` and that a later available username can still be registered.

For private fallback-cache recovery, `npm run test:cache-fallback` verifies that a manifest mod can be installed from `cache/files/<sha256>.jar` when the CurseForge metadata/download path fails.

For the player update feed, `npm run test:update-logs` verifies that the launcher requests `limit=3` and renders exactly the three newest developer update logs, with no fourth placeholder or stale card.

For ItemPhysic lava/fire parity, `npm run test:item-fire-fix-release` verifies that release building automatically injects the bundled AHT item fire fix jar into Forge 1.12.2 and Fabric 26.1.2 CurseForge export ZIPs.

For duplicate-launch protection, `npm run test:single-instance` verifies that launching the app twice against the same app data exits the second process, keeps the first process alive, and does not open a second launcher window.

For the complete local release path, `npm run test:release-flow` verifies developer Cloud setup, release build, R2 upload ordering, public feed verification, player update detection, and install against a fake local R2 host. `npm run test:release-ui-flow` covers the same publish-to-update path through the visible developer UI and confirms generated player defaults stay platform-neutral.

## Player App Flow

The player app:

- Creates the managed instance directory automatically on first run.
- Downloads `latest.json` from Cloudflare.
- Downloads the CurseForge-style pack ZIP from R2.
- Reads `manifest.json`.
- Downloads public mods through the CurseForge proxy.
- Uses `cache/mod-cache.json` fallback entries for permitted cached jars.
- Extracts `overrides/`.
- Records managed mod hashes for repair and local-change reports. Config overrides can still be installed by updates, but player edits inside `config/` are not reported and do not block Play.
- Writes `.aht-launcher/installed.json`, which the version-lock mod uses to prove the client is on the required pack version.
- Creates or refreshes a vanilla Minecraft Launcher profile using the CurseForge manifest's Minecraft/Forge loader metadata.
- Locks Play until the release feed can be checked and the installed pack id/version matches the required release.

Local-change reports include file paths, sizes, and hashes only. The app does not upload file contents. The Worker records the request IP because Cloudflare provides it at the server edge.

## Play Integration

By default, the desktop app writes a profile into the user's `launcher_profiles.json`:

- Windows: `%APPDATA%\.minecraft`
- macOS: `~/Library/Application Support/minecraft`
- Linux: `~/.minecraft`

For this pack, the profile targets `1.12.2-forge-14.23.5.2860` and uses the launcher-managed modpack folder as `gameDir`. Update creates the profile and automatically installs the required Forge loader into the selected Minecraft Launcher folder when it is missing. The Play button opens the official Minecraft Launcher with the A Hard Time profile selected; the player clicks Play inside Minecraft Launcher.

## Developer App Flow

The developer app can:

- Pick a CurseForge export ZIP.
- Set up Cloudflare with one `Setup Cloud` action.
- Publish a release with one `Publish Update` action.
- Generate the fallback cache from a local `mods/` folder or CurseForge instance folder when configured under advanced settings.
- Build `latest.json`, `release-report.json`, and the versioned pack ZIP internally.
- Validate the release before upload, including ZIP size/hash, CurseForge manifest, cache manifest, and release report.
- Upload artifacts to R2 with `latest.json` last so players do not see a half-uploaded update.
- Verify the player Worker feed after upload.
- Write player defaults so fresh installs know the Worker feed.
- Force a local developer login on startup before any release or telemetry tools unlock.
- Log in to the Worker admin API when a Worker admin URL is configured.
- View install counts, repair counts, unique IP count, and recent events.

The developer app login is local to the developer build and is not shown in the player app. Set the Worker `ADMIN_USERNAME` and `ADMIN_PASSWORD` secrets to the same credentials when you want the developer dashboard to read hosted telemetry.

## Cloudflare Worker

The developer app is the preferred setup path. Click `Setup Cloud`; it checks Wrangler auth first, opens browser login only when needed, creates/verifies the release and telemetry R2 buckets, writes Worker secrets, deploys the Worker, fills the Player Feed URL, and writes player defaults. The Launcher Proof Secret field is written to the Worker as `LAUNCHER_PROOF_SECRET`; set the same value on the Minecraft server before enforcing launcher-only joins. If the Worker URL is already known, `Write Defaults` only writes player defaults from the current Player Feed URL and does not upload release artifacts.

Manual deployment is still available for server-side maintenance:

```bash
cd /opt/aht-launcher
npm run cloudflare:login
npm run cloudflare:deploy
npx wrangler secret put CURSEFORGE_API_KEY
npx wrangler secret put LAUNCHER_PROOF_SECRET
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_TOKEN_SECRET
```

`cloudflare/wrangler.toml` includes separate R2 bindings for release files and telemetry:

```toml
[[r2_buckets]]
binding = "AHT_RELEASES"
bucket_name = "ahtlauncher"

[[r2_buckets]]
binding = "AHT_DATA"
bucket_name = "ahtlauncher-data"
```

You can bind both names to the same R2 bucket for a small private deployment, but separate buckets keep public release objects and private telemetry/account records apart.

After manual deploy, set the Developer Launcher Player Feed URL to the Worker `/latest.json` URL, for example `https://aht-curseforge-proxy.<account>.workers.dev/latest.json`, then run `Publish Update` from the developer app.

Worker endpoints:

- `GET /latest.json`
- `GET /packs/{packZip}`
- `GET /cache/mod-cache.json`
- `GET /cache/files/{sha256}.jar`
- `GET /server/{serverArtifact}`
- `GET /cf/mods/{projectId}/files/{fileId}`
- `GET /cf/mods/{projectId}/files/{fileId}/download-url`
- `POST /api/events`
- `POST /api/users/register`
- `GET /api/update-logs`
- `POST /admin/login`
- `GET /admin/summary`
- `GET /admin/events`
- `GET /admin/update-logs`
- `POST /admin/update-logs`

## Release Hosting

The release folder contains:

- `latest.json`
- `packs/a-hard-time-dregora-<version>.zip`
- `cache/mod-cache.json`
- `cache/files/<sha256>.jar`
- `server/aht_version_lock.cfg`
- `server/mods/aht-version-lock-<version>.jar`
- `release-report.json`

Upload with `Publish Update` in the developer app. For server-side maintenance, the lower-level shell upload is:

```bash
R2_BUCKET="your-r2-bucket-name" OUT_DIR="dist-r2" scripts/sync-r2.sh
```

If the Worker is your public release host, set `latestUrl` to `https://<worker-domain>/latest.json`. The developer app builds releases with that Worker URL as the release base URL and writes relative object paths under `packs/`, `cache/`, and `server/`, which the Worker serves from the `AHT_RELEASES` R2 binding.

Wrangler's `r2 object put` uploads one object at a time. Cloudflare documents Wrangler uploads up to 315 MB; if the ZIP grows beyond that, use `rclone` or the S3-compatible R2 API for the pack ZIP.

`Publish Update` runs validation before uploading. It is locked until the developer is logged in and a ZIP is selected. If the Player Feed URL is missing, it runs `Setup Cloud` first. Upload re-runs the cloud preflight, sends `latest.json` last so players do not see a required update until the ZIP/cache artifacts are already in R2, then verifies the public Worker feed and pack/cache objects. A release with errors is blocked. A release with warnings can still be uploaded, but warnings such as an empty fallback cache should be resolved before relying on cache-based mod recovery.

Developer release flow:

1. Open `AHT Developer Launcher`.
2. Log in with the developer credentials.
3. Pick the CurseForge export ZIP.
4. Enter the CurseForge API key.
5. Click `Setup Cloud` once if this machine has not already been set up.
6. Click `Publish Update`.
7. Open the regular launcher; fresh installs read the generated player defaults, and existing installs see the update as required from the Worker feed.

## Server Version Lock

`server-lock-mod/` contains a Forge 1.12.2 mod named `AHT Version Lock`.

Build it with Java 8 and add the jar to both:

- the client modpack `mods/` folder
- the Minecraft server `mods/` folder

The client side reads `.aht-launcher/installed.json` from the instance root and sends the launcher-installed `packId` and `version` to the server. The server side reads `config/aht_version_lock.cfg` and disconnects players whose launcher version is missing, stale, or from the wrong pack.

Each release build writes `server/aht_version_lock.cfg` with the current release version and copies the version-lock jar into `server/mods/`. When the built jar is available, the release builder also injects it into the client pack ZIP under `overrides/mods/`.

Copy `server/aht_version_lock.cfg` into the Minecraft server `config/` folder and `server/mods/aht-version-lock-<version>.jar` into the server `mods/` folder when publishing the update. The developer preflight blocks releases whose client ZIP is missing `aht-version-lock`.

## Cache Fallback

Use the developer app's Fallback Cache Mods Folder field to scan a local CurseForge instance or `mods/` folder. The builder copies jars into `cache/files/` by SHA256 and writes manifest-key entries such as:

```json
{
  "entries": {
    "123456:789000": {
      "fileName": "example.jar",
      "sha256": "64-char-sha256",
      "url": "cache/files/64-char-sha256.jar",
      "redistribution": "private-cache"
    }
  }
}
```

The installer tries CurseForge first, then this cache. Release validation reports whether the cache covers every CurseForge manifest entry. Only upload jars you are allowed to redistribute.

## Current Status

- The desktop app shell is implemented.
- The updater is implemented.
- Developer release build/upload UI is implemented; upload requires admin login.
- Worker release hosting, CurseForge proxy, telemetry, and admin endpoints are implemented.
- Server/client pack-version lock mod is built and included in release preflight.
- Fallback cache generation from a local `mods/` folder is implemented and validated.
- Managed install directory creation and local `latest.json` browsing are implemented.
- Launch is gated by the required release feed and installed version, then opens the official Minecraft Launcher with the A Hard Time profile selected.
- Automatic Forge loader installation runs during Update when the Minecraft Launcher profile is missing Forge.
- GitHub Actions launcher update automation builds Windows/macOS/Ubuntu, creates GitHub Releases, and can publish `launcher/latest.json` to R2 when Cloudflare secrets are configured.
- Full Microsoft/Minecraft account auth is still outside this private launcher build.
- Live Cloudflare/R2 secrets and macOS signing/notarization certificates still need environment-specific setup.
