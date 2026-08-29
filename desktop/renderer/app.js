const $ = (id) => document.querySelector(id);
const launchParams = new URLSearchParams(window.location.search);
const bootDeveloperMode = launchParams.get("mode") === "developer";
const LOG_TEXT_LIMIT = 24_000;
const DEV_LOG_TEXT_LIMIT = 60_000;
const DEFAULT_MEMORY_MB = 4096;

function truncateLogText(text = "", limit = LOG_TEXT_LIMIT) {
  const value = String(text ?? "");
  const cap = Math.max(1000, Number(limit) || LOG_TEXT_LIMIT);
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n\n[Log truncated: ${value.length - cap} more characters hidden to keep the launcher responsive.]`;
}

function stringifyLogValue(value, limit = DEV_LOG_TEXT_LIMIT) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncateLogText(text, limit);
}

function setTextContentBounded(element, text = "", limit = LOG_TEXT_LIMIT) {
  if (element) element.textContent = truncateLogText(text, limit);
}

if (bootDeveloperMode) {
  document.body.classList.add("dev-mode", "dev-locked");
}

if (!window.aht) {
  const mockStatus = {
    developerMode: bootDeveloperMode,
    config: {
      latestUrl: "https://packs.example.com/latest.json",
      instanceDir: "C:\\AHT\\A Hard Time Developer",
      curseforge: { proxyBaseUrl: "https://aht.example.workers.dev/cf/" },
      sync: {
        enabled: true,
        sendLocalChanges: true,
        baseUrl: "https://aht.example.workers.dev/",
        playerLabel: "Preview"
      },
      developer: {
        adminBaseUrl: "https://aht.example.workers.dev/",
        defaultOutDir: "C:\\Users\\Player\\Documents\\aht-release",
        defaultCacheModsDir: "C:\\AHT\\fallback-cache\\mods",
        r2Bucket: "ahtlauncher",
        r2AccountId: "",
        githubRepo: "svre-mc/aht-launcher",
        githubBranch: "main",
        githubWorkflow: "build-macos.yml"
      },
      minecraftLauncher: {
        enabled: true,
        rootDir: "C:\\Users\\Player\\AppData\\Roaming\\.minecraft",
        profileId: "a-hard-time-dregora",
        profileName: "A Hard Time",
        memoryMb: DEFAULT_MEMORY_MB,
        java8InstallOverride: null
      },
      playCommand: { command: "", args: [] }
    },
    identity: {
      installId: "preview-7f3a9d20",
      platform: "win32",
      arch: "x64",
      appVersion: "0.1.0"
    },
    latest: {
      name: "A Hard Time",
      version: "2.8.1"
    },
    installed: {
      version: "2.8.0",
      minecraft: {
        version: "1.12.2",
        modLoaders: [{ id: "forge-14.23.5.2860", primary: true }],
        recommendedRam: 6304
      }
    },
    minecraftProfile: {
      enabled: true,
      rootDir: "C:\\Users\\Player\\AppData\\Roaming\\.minecraft",
      profilesPath: "C:\\Users\\Player\\AppData\\Roaming\\.minecraft\\launcher_profiles.json",
      profileId: "a-hard-time-dregora",
      profileName: "A Hard Time",
      profileExists: true,
      versionId: "1.12.2-forge-14.23.5.2860",
      loaderInstalled: true,
      gameDir: "C:\\AHT\\A Hard Time Developer"
    },
    java8Runtime: {
      usable: true,
      path: "C:\\Program Files\\Eclipse Adoptium\\jre8\\bin\\javaw.exe",
      version: "1.8.0_452",
      vendor: "Eclipse Adoptium",
      arch: "amd64",
      is64Bit: true,
      managed: false,
      installSupported: true,
      recommendedInstall: false,
      installSelected: false,
      installOverride: null,
      totalMemoryMb: 16384,
      freeMemoryMb: 8192,
      configuredMemoryMb: DEFAULT_MEMORY_MB,
      memoryWarning: ""
    },
    setup: {
      detectedInstanceDir: "C:\\AHT\\A Hard Time Developer",
      recommendedInstanceDir: "C:\\AHT\\A Hard Time Developer",
      defaultInstanceDir: "C:\\AHT\\A Hard Time Developer",
      instanceExists: true,
      gameSettingsPresent: true,
      cacheModsDir: "C:\\AHT\\fallback-cache\\mods",
      cacheModsExists: true,
      localReleaseLatest: "D:\\AHT\\dist-r2\\latest.json",
      latestConfigured: true,
      canAutoConfigure: true
    },
    appVersion: "0.1.0",
    launcherUpdate: {
      enabled: true,
      latestUrl: "https://packs.example.com/launcher/latest.json",
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      required: true,
      updateRequired: false,
      artifact: null,
      error: ""
    },
    serverTransfer: {
      sourceDir: "",
      host: "",
      port: 22,
      username: "",
      remoteDir: "",
      excludeDirs: ["DregoraRL"],
      includeDirs: ["mods", "scripts", "config", "ForgeEssentials"],
      includeRootFiles: true
    },
    updateRequired: true,
    playConfigured: false,
    launchReady: false,
    launchBlockedReason: "Update required. Installed 2.8.0, latest 2.8.1."
  };
  if (!bootDeveloperMode) {
    delete mockStatus.config.developer;
    delete mockStatus.serverTransfer;
    mockStatus.config.instanceDir = "C:\\AHT\\A Hard Time";
    mockStatus.config.curseforge = { proxyBaseUrl: "" };
    mockStatus.config.sync = { enabled: true, sendLocalChanges: false, baseUrl: "", playerLabel: "" };
    mockStatus.config.minecraftLauncher = {
      enabled: true,
      rootDir: "",
      profileId: "a-hard-time",
      profileName: "A Hard Time",
      memoryMb: DEFAULT_MEMORY_MB,
      java8InstallOverride: null
    };
    mockStatus.minecraftProfile = {
      enabled: true,
      profileId: "a-hard-time",
      profileName: "A Hard Time",
      profileExists: false,
      versionId: "",
      loaderInstalled: false,
      minecraftVersion: "",
      loaderId: "",
      accountReuseAvailable: false
    };
    mockStatus.setup = {
      instanceExists: true,
      gameSettingsPresent: true,
      latestConfigured: true,
      canAutoConfigure: false,
      minecraftAccountReuseAvailable: false
    };
  }
  const mockUpdateLogs = [];
  window.aht = {
    getStatus: async () => mockStatus,
    copyErrorReport: async () => ({ ok: true, copied: true, chars: 0 }),
    saveSettings: async (settings = {}) => {
      mockStatus.config = {
        ...mockStatus.config,
        ...settings,
        minecraftLauncher: {
          ...mockStatus.config.minecraftLauncher,
          ...settings.minecraftLauncher
        }
      };
      const override = typeof mockStatus.config.minecraftLauncher.java8InstallOverride === "boolean"
        ? mockStatus.config.minecraftLauncher.java8InstallOverride
        : null;
      mockStatus.java8Runtime.installOverride = override;
      mockStatus.java8Runtime.installSelected = override === null
        ? mockStatus.java8Runtime.recommendedInstall
        : override;
      return { config: mockStatus.config };
    },
    setupRecommend: async () => mockStatus.setup,
    setupApply: async () => mockStatus,
    testFeed: async () => ({
      ok: true,
      message: "A Hard Time 2.8.1 is available.",
      latest: {
        name: "A Hard Time",
        version: "2.8.1",
        curseforgeFileCount: 268,
        hasCacheManifest: true,
        packSource: "https://packs.example.com/packs/a-hard-time-2.8.1.zip"
      }
    }),
    startUpdate: async () => ({ installed: { version: "2.8.1" } }),
    getUpdateState: async () => ({
      running: false,
      lines: ["Ready to install A Hard Time 2.8.1"],
      lastResult: null,
      error: null,
      progress: { phase: "Complete", completed: 4450, total: 4450, percent: 100 }
    }),
    startLauncherUpdate: async () => ({ ok: true, version: "0.1.1" }),
    getLauncherUpdateState: async () => ({
      running: false,
      lines: ["Launcher is current."],
      lastResult: null,
      error: null,
      progress: { phase: "Ready", completed: 0, total: 0, percent: 0 }
    }),
    accountRegister: async (username) => {
      mockStatus.identity.minecraftUsername = username;
      return { ok: true, username };
    },
    legalStatus: async () => ({
      required: false,
      accepted: true,
      reason: "accepted",
      termsVersion: "2026-07-14.1",
      privacyVersion: "2026-08-23.1",
      termsText: "A HARD TIME TERMS OF SERVICE",
      privacyText: "A HARD TIME PRIVACY POLICY"
    }),
    legalAccept: async () => ({ ok: true, acceptedAt: new Date().toISOString() }),
    appExit: async () => ({ ok: true }),
    openExternal: async (destination) => ({ ok: destination === "store", opened: destination === "store", destination, target: destination === "store" ? "https://ahardtime.net/shop" : "" }),
    socialList: async () => ({
      available: true,
      actionsAvailable: true,
      username: mockStatus.identity.minecraftUsername || "Preview",
      updatedAt: new Date().toISOString(),
      counts: { friends: 2, online: 1, requests: 1 },
      friends: [
        { username: "OnlineFriend", online: true, status: "Online", server: "Regular", onlineSince: new Date(Date.now() - 3720000).toISOString() },
        { username: "OfflineFriend", online: false, status: "Offline", lastSeenAt: new Date(Date.now() - 86400000).toISOString(), server: "Lobby" }
      ],
      requests: [{ username: "RequestFriend", online: false }]
    }),
    socialAction: async ({ action, target } = {}) => ({
      ok: true,
      queued: true,
      action,
      target,
      message: `${action || "Friend action"} queued for ${target || "player"}.`
    }),
    scanChanges: async () => ({
      counts: { changed: 2, missing: 0, added: 1 },
      changed: [{ path: "mods/example.jar" }],
      missing: [],
      added: [{ path: "mods/local-addon.jar" }]
    }),
    scanFiles: async () => ({
      valid: false,
      counts: { managed: 4450, checked: 4448, ok: 4446, changed: 2, missing: 2, corrupted: 4 },
      changed: [{ path: "mods/example.jar" }, { path: "mods/extra-example.jar" }],
      missing: [{ path: "mods/missing-one.jar" }, { path: "mods/missing-two.jar" }]
    }),
    syncChanges: async () => ({ ok: true }),
    play: async () => ({}),
    selectJson: async () => "D:\\AHT\\dist-r2\\latest.json",
    selectZip: async () => "D:\\Downloads\\A Hard Time-2.8.2.zip",
    selectFolder: async (defaultPath = "") => defaultPath || "D:\\AHT\\dist-r2",
    selectUpdateLogImage: async () => "D:\\AHT\\media\\update-banner.webp",
    selectUpdateLogVideo: async () => "D:\\AHT\\media\\update-video.mp4",
    openPath: async () => ({}),
    devBuildRelease: async () => ({
      report: {
        version: "2.8.2",
        curseforgeManifestFiles: 268,
        overrideSummary: { fileCount: 4182, embeddedModCount: 16 }
      }
    }),
    devValidateRelease: async () => ({
      ok: true,
      latest: { name: "A Hard Time", version: "2.8.2", channel: "stable", required: true },
      checks: [
        { level: "ok", label: "latest.json parsed", detail: "D:\\AHT\\dist-r2\\latest.json" },
        { level: "ok", label: "pack ZIP SHA256 matches", detail: "preview" },
        { level: "warning", label: "fallback cache is empty", detail: "Preview warning" }
      ],
      warnings: [{ label: "fallback cache is empty", detail: "Preview warning" }],
      errors: [],
      artifacts: { manifestFileCount: 268, overrideFileCount: 4182 }
    }),
    devCloudPreflight: async () => ({
      ok: true,
      latestUrl: "https://packs.example.com/latest.json",
      bucket: "ahtlauncher",
      checks: [
        { level: "ok", label: "Player Feed URL parsed", detail: "https://packs.example.com/latest.json" },
        { level: "ok", label: "Wrangler available", detail: "wrangler 4.x" },
        { level: "ok", label: "Cloudflare account authenticated", detail: "preview" }
      ],
      warnings: [],
      errors: []
    }),
    devCloudLogin: async () => ({ ok: true, output: "Logged in to Cloudflare." }),
    devCloudSetupBuckets: async () => ({
      ok: true,
      results: [
        { bucket: "ahtlauncher", ok: true },
        { bucket: "ahtlauncher-data", ok: true }
      ],
      checks: [
        { level: "ok", label: "R2 bucket ready: ahtlauncher", detail: "" },
        { level: "ok", label: "R2 bucket ready: ahtlauncher-data", detail: "" }
      ],
      warnings: [],
      errors: []
    }),
    devCloudSetupSecrets: async () => ({
      ok: true,
      results: [
        { name: "CURSEFORGE_API_KEY", ok: true },
        { name: "LAUNCHER_PROOF_SECRET", ok: true },
        { name: "ADMIN_USERNAME", ok: true },
        { name: "ADMIN_PASSWORD", ok: true },
        { name: "ADMIN_TOKEN_SECRET", ok: true }
      ],
      checks: [
        { level: "ok", label: "Secret set: CURSEFORGE_API_KEY", detail: "" },
        { level: "ok", label: "Secret set: LAUNCHER_PROOF_SECRET", detail: "" },
        { level: "ok", label: "Secret set: ADMIN_USERNAME", detail: "" },
        { level: "ok", label: "Secret set: ADMIN_PASSWORD", detail: "" },
        { level: "ok", label: "Secret set: ADMIN_TOKEN_SECRET", detail: "" }
      ],
      warnings: [],
      errors: []
    }),
    devCloudDeployWorker: async () => ({
      ok: true,
      output: "Deployed https://packs.example.com/",
      workerUrl: "https://packs.example.com/",
      latestUrl: "https://packs.example.com/latest.json"
    }),
    devWritePlayerDefaults: async () => ({
      ok: true,
      latestUrl: "https://packs.example.com/latest.json",
      written: [{ kind: "preview", path: "preview/app.defaults.json" }],
      failed: []
    }),
    devSyncR2: async () => ({
      uploaded: [{ path: "cache/mod-cache.json" }, { path: "packs/a-hard-time-dregora-2.8.2.zip" }, { path: "latest.json" }],
      verification: { publicLatestUrl: "https://packs.example.com/latest.json", latest: { name: "A Hard Time", version: "2.8.2" } }
    }),
    devFindLauncherBuilds: async () => ({
      version: "0.1.3",
      repo: "svre-mc/aht-launcher",
      ref: "main",
      workflow: "build-macos.yml",
      packageVersion: "0.1.3",
      version: "0.1.3",
      actionsUrl: "https://github.com/svre-mc/aht-launcher/actions/workflows/build-macos.yml",
      latestRun: { id: 123, status: "success", htmlUrl: "https://github.com/svre-mc/aht-launcher/actions/runs/123" }
    }),
    devCheckLauncherWorkflow: async () => ({
      ok: true,
      repo: "svre-mc/aht-launcher",
      ref: "main",
      workflow: "build-macos.yml",
      actionsUrl: "https://github.com/svre-mc/aht-launcher/actions/workflows/build-macos.yml",
      latestRun: { id: 123, status: "success", htmlUrl: "https://github.com/svre-mc/aht-launcher/actions/runs/123" }
    }),
    devDispatchLauncherWorkflow: async () => ({
      ok: true,
      repo: "svre-mc/aht-launcher",
      ref: "main",
      workflow: "build-macos.yml",
      version: "0.1.3",
      packageVersion: "0.1.3",
      actionsUrl: "https://github.com/svre-mc/aht-launcher/actions/workflows/build-macos.yml",
      releaseUrl: "https://github.com/svre-mc/aht-launcher/releases/tag/launcher-v0.1.3",
      run: { id: 124, status: "queued", htmlUrl: "https://github.com/svre-mc/aht-launcher/actions/runs/124" }
    }),
    devDeployLauncher: async () => ({ running: true, progress: { phase: "Preparing public deploy", percent: 0 }, lines: [] }),
    devLauncherDeployState: async () => ({
      running: false,
      progress: { phase: "Published and verified", percent: 100 },
      lines: ["Verified launcher/latest.json at 0.1.75."],
      lastResult: {
        version: "0.1.75",
        releaseUrl: "https://github.com/svre-mc/aht-launcher/releases/tag/launcher-v0.1.75",
        latestUrl: "https://packs.example.com/launcher/latest.json",
        developerArtifactsUploaded: false
      },
      error: null
    }),
    devSyncLauncherUpdate: async () => ({
      uploaded: [{ path: "launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.3.exe" }, { path: "launcher/latest.json" }],
      verification: { publicLatestUrl: "https://packs.example.com/launcher/latest.json", latest: { version: "0.1.3" } }
    }),
    devPlanServerTransfer: async () => ({
      sourceDir: "",
      fileCount: 128,
      totalBytes: 1024,
      excludedDirs: ["DregoraRL"],
      includeDirs: ["mods", "scripts", "config", "ForgeEssentials"],
      includeRootFiles: true
    }),
    devSaveServerTransfer: async (payload) => ({ ...payload, password: undefined }),
    devSyncServerFiles: async () => ({
      ok: true,
      uploaded: 128,
      fileCount: 128,
      totalBytes: 1024,
      excludedDirs: ["DregoraRL"],
      includeDirs: ["mods", "scripts", "config", "ForgeEssentials"],
      includeRootFiles: true
    }),
    devServerTransferState: async () => ({
      running: false,
      lines: ["Ready"],
      lastResult: null,
      error: null,
      progress: { phase: "Ready", percent: 0 }
    }),
    devGetSecrets: async () => ({
      saved: true,
      encrypted: true,
      warning: "",
      curseforgeApiKey: "",
      serverSshPassword: "",
      launcherProofSecret: "",
      socialServerSecret: "",
      githubToken: "",
      r2AccessKeyId: "",
      r2SecretAccessKey: ""
    }),
    devSaveSecrets: async () => ({
      ok: true,
      saved: true,
      encrypted: true,
      warning: ""
    }),
    devLogin: async () => ({ ok: true, expiresAt: new Date(Date.now() + 43200000).toISOString() }),
    devSummary: async () => ({ counts: { installs: 184, repairs: 19, changeReports: 42, uniqueIps: 51 } }),
    devUpdateLogs: async () => ({ logs: mockUpdateLogs }),
    devPublishUpdateLog: async (payload) => {
      const log = { ...payload, id: String(Date.now()), publishedAt: new Date().toISOString() };
      mockUpdateLogs.unshift(log);
      mockStatus.updateLogs = mockUpdateLogs.slice(0, 3);
      return { ok: true, log };
    },
    devEvents: async () => ({
      events: [
        {
          receivedAt: "2026-06-24T04:20:12Z",
          ip: "203.0.113.42",
          playerLabel: "auSavant",
          installId: "e2b7d4ab-84be-4e75-a73b-38b513dfd044",
          platform: "win32",
          event: { type: "install_completed", version: "2.8.1", manifestFileCount: 268, overrideFileCount: 4182 }
        },
        {
          receivedAt: "2026-06-24T04:13:55Z",
          ip: "198.51.100.14",
          playerLabel: "TestRig",
          installId: "4fb39d5a-2d17-49f4-b75c-251d9998d0a2",
          platform: "darwin",
          event: {
            type: "local_changes",
            changes: {
              counts: { changed: 2, missing: 0, added: 1 },
              changed: [{ path: "mods/lycanitesmobs-1.12.2.jar" }],
              added: [{ path: "mods/local-addon.jar" }],
              missing: []
            }
          }
        }
      ]
    }),
    devLauncherDownloads: async () => ({
      downloads: [
        {
          receivedAt: "2026-08-02T18:20:12Z",
          ipv4: "203.0.113.42",
          platform: "Windows"
        }
      ],
      cursor: "",
      hasMore: false
    }),
    devPlayerRecords: async () => ({
      players: [
        {
          receivedAt: "2026-07-17T18:20:12Z",
          ipv4: "203.0.113.42",
          minecraftUsername: "auSavant",
          minecraftUuid: "6f3bb6d1-7a4e-4f4f-9f8f-5a9a7f01dafe",
          platform: "Windows",
          launcherVersion: "0.1.82"
        }
      ],
      cursor: "",
      hasMore: false
    }),
    devLauncherUpdates: async () => ({
      updates: [
        {
          receivedAt: "2026-08-03T18:20:12Z",
          ipv4: "203.0.113.42",
          minecraftUsername: "auSavant",
          minecraftUuid: "6f3bb6d1-7a4e-4f4f-9f8f-5a9a7f01dafe",
          platform: "Windows",
          launcherVersion: "0.1.82"
        }
      ],
      cursor: "",
      hasMore: false
    })
  };
  if (!bootDeveloperMode) {
    for (const key of Object.keys(window.aht)) {
      if (key.startsWith("dev")) delete window.aht[key];
    }
  }
}

const els = {
  tabs: [...document.querySelectorAll(".tab")],
  gameTiles: [...document.querySelectorAll(".game-tile[data-tab]")],
  views: [...document.querySelectorAll(".view")],
  developerTab: $("#developerTab"),
  developerTileButton: $("#developerTileButton"),
  downloadsButton: $("#downloadsButton"),
  launcherVersionLabel: $("#launcherVersionLabel"),
  sidebarProgress: $("#sidebarProgress"),
  sidebarProgressLabel: $("#sidebarProgressLabel"),
  sidebarProgressCount: $("#sidebarProgressCount"),
  sidebarProgressBar: $("#sidebarProgressBar"),
  downloadsOverlay: $("#downloadsOverlay"),
  downloadsCloseButton: $("#downloadsCloseButton"),
  downloadsState: $("#downloadsState"),
  downloadsProgressText: $("#downloadsProgressText"),
  downloadsRowProgress: $("#downloadsRowProgress"),
  downloadsProgressBar: $("#downloadsProgressBar"),
  downloadsLog: $("#downloadsLog"),
  downloadsUpdateIconButton: $("#downloadsUpdateIconButton"),
  launcherUpdateOverlay: $("#launcherUpdateOverlay"),
  launcherUpdateTitle: $("#launcherUpdateTitle"),
  launcherUpdateSummary: $("#launcherUpdateSummary"),
  launcherUpdateProgressLabel: $("#launcherUpdateProgressLabel"),
  launcherUpdateProgressCount: $("#launcherUpdateProgressCount"),
  launcherUpdateProgressBar: $("#launcherUpdateProgressBar"),
  launcherUpdateLog: $("#launcherUpdateLog"),
  launcherUpdateNowButton: $("#launcherUpdateNowButton"),
  activityPanel: $("#activityPanel"),
  updateLogGrid: $("#updateLogGrid"),
  newsView: $("#news"),
  newsFeedGrid: $("#newsFeedGrid"),
  newsEmptyState: $("#newsEmptyState"),
  newsLatestLabel: $("#newsLatestLabel"),
  externalLinks: [...document.querySelectorAll("[data-external-destination]")],
  statusBadge: $("#statusBadge"),
  versionLine: $("#versionLine"),
  syncStatus: $("#syncStatus"),
  setupNotice: $("#setupNotice"),
  setupAutoButton: $("#setupAutoButton"),
  setupSettingsButton: $("#setupSettingsButton"),
  installedVersion: $("#installedVersion"),
  latestVersion: $("#latestVersion"),
  sideInstalledVersion: $("#sideInstalledVersion"),
  ptbSideInstalledVersion: $("#ptbSideInstalledVersion"),
  sidePackTitle: $("#sidePackTitle"),
  playerPackTitle: $("#playerPackTitle"),
  developerTileTitle: $("#developerTileTitle"),
  instanceDir: $("#instanceDir"),
  minecraftProfile: $("#minecraftProfile"),
  installId: $("#installId"),
  playerLabelView: $("#playerLabelView"),
  legalOverlay: $("#legalOverlay"),
  legalTitle: $("#legalTitle"),
  legalIntro: $("#legalIntro"),
  legalVersion: $("#legalVersion"),
  legalTermsTab: $("#legalTermsTab"),
  legalPrivacyTab: $("#legalPrivacyTab"),
  legalDocumentText: $("#legalDocumentText"),
  legalAcceptCheckbox: $("#legalAcceptCheckbox"),
  legalAcceptButton: $("#legalAcceptButton"),
  legalExitButton: $("#legalExitButton"),
  legalError: $("#legalError"),
  profileFriendsButton: $("#profileFriendsButton"),
  profileFriendsBadge: $("#profileFriendsBadge"),
  friendsOverlay: $("#friendsOverlay"),
  friendsCloseButton: $("#friendsCloseButton"),
  friendsRefreshButton: $("#friendsRefreshButton"),
  friendsSummary: $("#friendsSummary"),
  friendsCount: $("#friendsCount"),
  friendsOnlineCount: $("#friendsOnlineCount"),
  friendsStatus: $("#friendsStatus"),
  friendsList: $("#friendsList"),
  friendsRequestsList: $("#friendsRequestsList"),
  friendsRequestsBadge: $("#friendsRequestsBadge"),
  accountOverlay: $("#accountOverlay"),
  accountForm: $("#accountForm"),
  minecraftUsernameInput: $("#minecraftUsernameInput"),
  accountError: $("#accountError"),
  accountCreateButton: $("#accountCreateButton"),
  diffSummary: $("#diffSummary"),
  activityState: $("#activityState"),
  progressWrap: $("#progressWrap"),
  progressLabel: $("#progressLabel"),
  progressCount: $("#progressCount"),
  progressBar: $("#progressBar"),
  log: $("#log"),
  updateButton: $("#updateButton"),
  playButton: $("#playButton"),
  copyLatestLaunchReportButton: $("#copyLatestLaunchReportButton"),
  scanButton: $("#scanButton"),
  repairPromptOverlay: $("#repairPromptOverlay"),
  repairPromptSummary: $("#repairPromptSummary"),
  repairPromptList: $("#repairPromptList"),
  repairPromptCancelButton: $("#repairPromptCancelButton"),
  repairPromptRepairButton: $("#repairPromptRepairButton"),
  updateOptionsOverlay: $("#updateOptionsOverlay"),
  updateOptionsSummary: $("#updateOptionsSummary"),
  replaceGameSettingsInput: $("#replaceGameSettingsInput"),
  updateOptionsBackButton: $("#updateOptionsBackButton"),
  updateOptionsUpdateButton: $("#updateOptionsUpdateButton"),
  openInstanceFromPlayerButton: $("#openInstanceFromPlayerButton"),
  latestUrlInput: $("#latestUrlInput"),
  pickLatestButton: $("#pickLatestButton"),
  proxyUrlInput: $("#proxyUrlInput"),
  syncUrlInput: $("#syncUrlInput"),
  playerLabelInput: $("#playerLabelInput"),
  instanceInput: $("#instanceInput"),
  minecraftRootInput: $("#minecraftRootInput"),
  openInstancePathButton: $("#openInstancePathButton"),
  openMinecraftRootPathButton: $("#openMinecraftRootPathButton"),
  minecraftProfileNameInput: $("#minecraftProfileNameInput"),
  minecraftMemoryInput: $("#minecraftMemoryInput"),
  minecraftMemoryOutput: $("#minecraftMemoryOutput"),
  playCommandInput: $("#playCommandInput"),
  playArgsInput: $("#playArgsInput"),
  minecraftProfileEnabledInput: $("#minecraftProfileEnabledInput"),
  syncEnabledInput: $("#syncEnabledInput"),
  sendChangesInput: $("#sendChangesInput"),
  pickInstanceButton: $("#pickInstanceButton"),
  pickMinecraftRootButton: $("#pickMinecraftRootButton"),
  testFeedButton: $("#testFeedButton"),
  saveSettingsButton: $("#saveSettingsButton"),
  settingsFeedCard: $("#settingsFeedCard"),
  settingsFeedState: $("#settingsFeedState"),
  settingsFeedTitle: $("#settingsFeedTitle"),
  settingsFeedDetail: $("#settingsFeedDetail"),
  setupAssistantCard: $("#setupAssistantCard"),
  setupAssistantState: $("#setupAssistantState"),
  setupAssistantTitle: $("#setupAssistantTitle"),
  setupAssistantDetail: $("#setupAssistantDetail"),
  settingsAutoSetupButton: $("#settingsAutoSetupButton"),
  openInstanceButton: $("#openInstanceButton"),
  adminUrlInput: $("#adminUrlInput"),
  adminUserInput: $("#adminUserInput"),
  adminPasswordInput: $("#adminPasswordInput"),
  developerLoginScreen: $("#developerLoginScreen"),
  developerLoginForm: $("#developerLoginForm"),
  developerLoginStatus: $("#developerLoginStatus"),
  developerConsole: $("#developerConsole"),
  developerSessionStatus: $("#developerSessionStatus"),
  devTabs: [...document.querySelectorAll(".dev-tab[data-dev-target]")],
  devPanels: [...document.querySelectorAll("[data-dev-panel]")],
  saveAdminUrlButton: $("#saveAdminUrlButton"),
  loginButton: $("#loginButton"),
  loadDashboardButton: $("#loadDashboardButton"),
  packZipInput: $("#packZipInput"),
  playerFeedUrlInput: $("#playerFeedUrlInput"),
  curseforgeApiKeyInput: $("#curseforgeApiKeyInput"),
  launcherProofSecretInput: $("#launcherProofSecretInput"),
  socialServerSecretInput: $("#socialServerSecretInput"),
  outDirInput: $("#outDirInput"),
  cacheModsInput: $("#cacheModsInput"),
  clientModpackDirInput: $("#clientModpackDirInput"),
  clientZipVersionInput: $("#clientZipVersionInput"),
  pickClientModpackDirButton: $("#pickClientModpackDirButton"),
  buildClientZipButton: $("#buildClientZipButton"),
  clientZipStatus: $("#clientZipStatus"),
  ptbClientModpackDirInput: $("#ptbClientModpackDirInput"),
  ptbClientZipVersionInput: $("#ptbClientZipVersionInput"),
  ptbPackZipInput: $("#ptbPackZipInput"),
  pickPtbClientModpackDirButton: $("#pickPtbClientModpackDirButton"),
  buildPtbClientZipButton: $("#buildPtbClientZipButton"),
  ptbReleaseCheckCard: $("#ptbReleaseCheckCard"),
  ptbReleaseCheckState: $("#ptbReleaseCheckState"),
  ptbReleaseCheckTitle: $("#ptbReleaseCheckTitle"),
  ptbReleaseCheckDetail: $("#ptbReleaseCheckDetail"),
  ptbReleaseUploadProgress: $("#ptbReleaseUploadProgress"),
  ptbReleaseUploadProgressLabel: $("#ptbReleaseUploadProgressLabel"),
  ptbReleaseUploadProgressCount: $("#ptbReleaseUploadProgressCount"),
  ptbReleaseUploadProgressBar: $("#ptbReleaseUploadProgressBar"),
  baseUrlInput: $("#baseUrlInput"),
  bucketInput: $("#bucketInput"),
  r2AccountIdInput: $("#r2AccountIdInput"),
  r2AccessKeyIdInput: $("#r2AccessKeyIdInput"),
  r2SecretAccessKeyInput: $("#r2SecretAccessKeyInput"),
  cacheOnlyInput: $("#cacheOnlyInput"),
  pickZipButton: $("#pickZipButton"),
  pickOutButton: $("#pickOutButton"),
  pickCacheModsButton: $("#pickCacheModsButton"),
  generateProofSecretButton: $("#generateProofSecretButton"),
  generateSocialSecretButton: $("#generateSocialSecretButton"),
  setupCloudButton: $("#setupCloudButton"),
  writeDefaultsButton: $("#writeDefaultsButton"),
  publishReleaseButton: $("#publishReleaseButton"),
  releaseUploadProgress: $("#releaseUploadProgress"),
  releaseUploadProgressLabel: $("#releaseUploadProgressLabel"),
  releaseUploadProgressCount: $("#releaseUploadProgressCount"),
  releaseUploadProgressBar: $("#releaseUploadProgressBar"),
  scanLauncherBuildsButton: $("#scanLauncherBuildsButton"),
  publishLauncherUpdateButton: $("#publishLauncherUpdateButton"),
  launcherWindowsPathInput: $("#launcherWindowsPathInput"),
  launcherMacosPathInput: $("#launcherMacosPathInput"),
  githubRepoInput: $("#githubRepoInput"),
  githubBranchInput: $("#githubBranchInput"),
  githubWorkflowInput: $("#githubWorkflowInput"),
  githubTokenInput: $("#githubTokenInput"),
  launcherUpdateStatus: $("#launcherUpdateStatus"),
  launcherDeployProgress: $("#launcherDeployProgress"),
  launcherDeployProgressLabel: $("#launcherDeployProgressLabel"),
  launcherDeployProgressCount: $("#launcherDeployProgressCount"),
  launcherDeployProgressBar: $("#launcherDeployProgressBar"),
  testLauncherReinstallButton: $("#testLauncherReinstallButton"),
  launcherReinstallStatus: $("#launcherReinstallStatus"),
  serverSourceInput: $("#serverSourceInput"),
  pickServerSourceButton: $("#pickServerSourceButton"),
  serverHostInput: $("#serverHostInput"),
  serverPortInput: $("#serverPortInput"),
  serverUsernameInput: $("#serverUsernameInput"),
  serverPasswordInput: $("#serverPasswordInput"),
  serverRemoteDirInput: $("#serverRemoteDirInput"),
  planServerTransferButton: $("#planServerTransferButton"),
  uploadServerFilesButton: $("#uploadServerFilesButton"),
  serverTransferStatus: $("#serverTransferStatus"),
  serverTransferProgress: $("#serverTransferProgress"),
  serverTransferProgressLabel: $("#serverTransferProgressLabel"),
  serverTransferProgressCount: $("#serverTransferProgressCount"),
  serverTransferProgressBar: $("#serverTransferProgressBar"),
  serverTransferLog: $("#serverTransferLog"),
  loadUpdateLogsButton: $("#loadUpdateLogsButton"),
  publishUpdateLogButton: $("#publishUpdateLogButton"),
  updateLogVersionInput: $("#updateLogVersionInput"),
  updateLogTitleInput: $("#updateLogTitleInput"),
  updateLogSubtitleInput: $("#updateLogSubtitleInput"),
  updateLogImageInput: $("#updateLogImageInput"),
  pickUpdateLogImageButton: $("#pickUpdateLogImageButton"),
  updateLogVideoInput: $("#updateLogVideoInput"),
  pickUpdateLogVideoButton: $("#pickUpdateLogVideoButton"),
  updateLogYoutubeInput: $("#updateLogYoutubeInput"),
  updateLogBodyInput: $("#updateLogBodyInput"),
  updateLogStatus: $("#updateLogStatus"),
  developerUpdateLogsList: $("#developerUpdateLogsList"),
  updateLogOverlay: $("#updateLogOverlay"),
  updateLogHero: $("#updateLogHero"),
  updateLogModalMeta: $("#updateLogModalMeta"),
  updateLogModalTitle: $("#updateLogModalTitle"),
  updateLogModalSubtitle: $("#updateLogModalSubtitle"),
  updateLogArticleBody: $("#updateLogArticleBody"),
  updateLogCloseButton: $("#updateLogCloseButton"),
  updateLogWatchButton: $("#updateLogWatchButton"),
  updateLogVideoOverlay: $("#updateLogVideoOverlay"),
  updateLogVideoStage: $("#updateLogVideoStage"),
  updateLogVideoCloseButton: $("#updateLogVideoCloseButton"),
  releaseCheckCard: $("#releaseCheckCard"),
  releaseCheckState: $("#releaseCheckState"),
  releaseCheckTitle: $("#releaseCheckTitle"),
  releaseCheckDetail: $("#releaseCheckDetail"),
  devLog: $("#devLog"),
  playerDataTabs: [...document.querySelectorAll(".player-data-tab[data-player-data-view]")],
  playerDownloadsPanel: $("#playerDownloadsPanel"),
  playerRecordsPanel: $("#playerRecordsPanel"),
  playerLauncherUpdatesPanel: $("#playerLauncherUpdatesPanel"),
  playerAccessPanel: $("#playerAccessPanel"),
  playerDownloadsList: $("#playerDownloadsList"),
  playerRecordsList: $("#playerRecordsList"),
  playerLauncherUpdatesList: $("#playerLauncherUpdatesList"),
  playerAccessList: $("#playerAccessList"),
  accessDecisionDialog: $("#accessDecisionDialog"),
  accessDecisionForm: $("#accessDecisionForm"),
  accessDecisionClose: $("#accessDecisionClose"),
  accessDecisionTitle: $("#accessDecisionTitle"),
  accessDecisionIdentity: $("#accessDecisionIdentity"),
  accessDecisionAction: $("#accessDecisionAction"),
  accessDecisionScope: $("#accessDecisionScope"),
  accessDecisionReason: $("#accessDecisionReason"),
  accessDecisionStatus: $("#accessDecisionStatus"),
  accessDecisionSubmit: $("#accessDecisionSubmit"),
  toastStack: $("#toastStack")
};

let currentStatus = null;
let updatePoll = null;
let launcherUpdatePoll = null;
let launcherDeployPoll = null;
let serverTransferPoll = null;
let lastUpdateState = null;
let lastLauncherUpdateState = null;
let lastServerTransferState = null;
let lastIntegrityScan = null;
let scanProgressHideTimer = null;
let activeUpdateKind = "";
let activeTabName = "player";
let activeSidebarPack = "aht";
let playBusy = false;
const packStatusCache = new Map();
const releaseValidationByTarget = new Map();
let developerAuthenticated = false;
let playerDownloadRecords = [];
let canonicalPlayerRecords = [];
let launcherUpdateRecords = [];
let accessDecisionRecords = [];
let selectedAccessPlayer = null;
let activePlayerDataView = "downloads";
let playerDataLoaded = false;
let playerDataLoading = false;
let uploadPoll = null;
let releaseBusy = false;
let developerSecretSaveTimer = null;
let launcherUpdateAutoStarted = false;
let lastStatusRefreshAt = 0;
let updateCompleteHideTimer = null;
let friendsBusy = false;
let friendsLoading = false;
let friendsActionsAvailable = false;
let friendsRefreshTimer = null;
let friendsNotificationTimer = null;
let friendsPresenceTimer = null;
let friendsRequestId = 0;
let friendsSocialState = null;
const friendsActionRefreshTimers = new Set();
let currentLegalState = null;
let activeUpdateLog = null;
const DOWNLOAD_COMPLETE_VISIBLE_MS = 2200;
const DOWNLOAD_ERROR_VISIBLE_MS = 6200;
const TOAST_MAX_LIFETIME_MS = 4000;
const TOAST_EXIT_DURATION_MS = 180;
const TOAST_SCHEDULER_HEADROOM_MS = 2000;
const TOAST_MAX_VISIBLE_MS = TOAST_MAX_LIFETIME_MS - TOAST_EXIT_DURATION_MS - TOAST_SCHEDULER_HEADROOM_MS;
const TOAST_DEFAULT_VISIBLE_MS = 1800;

function setBadge(text, state = "") {
  els.statusBadge.textContent = text;
  els.statusBadge.className = `status-pill ${state}`.trim();
}

function setSyncLine(text) {
  els.syncStatus.textContent = "";
  const dot = document.createElement("span");
  dot.className = `online-dot${text === "Offline" ? " offline" : ""}`;
  const chevron = document.createElement("span");
  chevron.className = "profile-chevron";
  chevron.setAttribute("aria-hidden", "true");
  els.syncStatus.append(dot, document.createTextNode(text), chevron);
}

const POINTER_LIGHT_SELECTOR = [
  ".brand",
  ".nav",
  ".nav-item",
  ".game-tile:not(.coming-soon)",
  ".profile-card",
  ".sidebar-download",
  ".ghost-button",
  ".button:not(.modal-icon-button)",
  ".facts > div",
  ".feature-card",
  ".feature-copy-button"
].join(", ");

function installPointerLighting() {
  let active = new Set();
  const staticTargets = document.querySelectorAll(POINTER_LIGHT_SELECTOR);
  staticTargets.forEach((element) => element.classList.add("pointer-light-surface"));

  const clear = () => {
    for (const element of active) element.classList.remove("is-pointer-lit");
    active = new Set();
  };

  document.addEventListener("pointermove", (event) => {
    const next = new Set();
    let element = event.target instanceof Element ? event.target : null;
    while (element && element !== document.documentElement) {
      if (element.matches(POINTER_LIGHT_SELECTOR)) {
        element.classList.add("pointer-light-surface", "is-pointer-lit");
        const rect = element.getBoundingClientRect();
        element.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
        element.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
        next.add(element);
      }
      element = element.parentElement;
    }
    for (const previous of active) {
      if (!next.has(previous)) previous.classList.remove("is-pointer-lit");
    }
    active = next;
  }, { passive: true });
  document.addEventListener("pointerleave", clear);
  window.addEventListener("blur", clear);
  document.addEventListener("focusin", (event) => {
    const element = event.target instanceof Element ? event.target.closest(POINTER_LIGHT_SELECTOR) : null;
    if (!element) return;
    element.classList.add("pointer-light-surface", "is-pointer-lit");
    element.style.setProperty("--pointer-x", "50%");
    element.style.setProperty("--pointer-y", "50%");
  });
  document.addEventListener("focusout", (event) => {
    const element = event.target instanceof Element ? event.target.closest(POINTER_LIGHT_SELECTOR) : null;
    element?.classList.remove("is-pointer-lit");
  });
}

function syncSetupNotice() {
  els.setupNotice.hidden = true;
}

function currentLogText() {
  return els.log?.textContent || "";
}

function logIsEmpty() {
  return !currentLogText().trim();
}

function setLog(text) {
  setTextContentBounded(els.log, text || "", LOG_TEXT_LIMIT);
}

function appendLog(text) {
  if (!els.log) return;
  setTextContentBounded(els.log, `${els.log.textContent}${els.log.textContent ? "\n" : ""}${text}`, LOG_TEXT_LIMIT);
}

function setDevLog(value) {
  if (!els.devLog) return;
  setTextContentBounded(els.devLog, stringifyLogValue(value, DEV_LOG_TEXT_LIMIT), DEV_LOG_TEXT_LIMIT);
}

function applyDeveloperGate(status) {
  const developerMode = Boolean(status.developerMode);
  document.body.classList.toggle("dev-mode", developerMode);
  document.body.classList.toggle("dev-locked", developerMode && !developerAuthenticated);
  if (els.sidePackTitle) els.sidePackTitle.textContent = developerMode ? "AHT Modpack" : "AHT";
  if (els.developerTileTitle) els.developerTileTitle.textContent = "The Developer Mode";
  if (!developerMode) {
    return;
  }
  if (!developerAuthenticated && activeTabName !== "developer") {
    activateTab("developer");
  }
  els.developerLoginScreen.hidden = developerAuthenticated;
  els.developerConsole.hidden = !developerAuthenticated;
  els.developerSessionStatus.textContent = developerAuthenticated
    ? `Session active${status.developerSessionExpiresAt ? ` until ${new Date(status.developerSessionExpiresAt).toLocaleTimeString()}` : ""}`
    : "Locked";
  if (!developerAuthenticated) {
    els.developerLoginStatus.textContent = "Enter the developer credentials to continue.";
    window.setTimeout(() => els.adminPasswordInput.focus(), 0);
  }
}

function cleanErrorMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/^Error invoking remote method '[^']+': (?:Error|RangeError|SyntaxError): /, "")
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error: /, "");
}

async function copyErrorReportFromToast(payload = {}) {
  if (!window.aht?.copyErrorReport) return;
  try {
    const result = await window.aht.copyErrorReport(payload);
    const file = result.fileName ? ` Saved as ${result.fileName}.` : "";
    showToast("Launch report copied", `${result.chars || 0} characters copied.${file} Paste it into your support message.`, "success", { durationMs: 1800, disableDiagnostics: true });
  } catch {
    showToast("Copy failed", "Open the AHT instance logs\\launcher folder and send the newest AHT-Launch text file.", "warn", { durationMs: 1800, disableDiagnostics: true });
  }
}

function displayPackName(name) {
  const value = String(name || "").replace(/\s+Dregora\b/ig, "").trim();
  return value || String(name || "A Hard Time");
}

function updateLogSummary(value, limit = 150) {
  const text = String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Open the full release notes.";
  const cap = Math.max(60, Number(limit) || 150);
  if (text.length <= cap) return text;
  const clipped = text.slice(0, cap + 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > cap * 0.62 ? boundary : cap).trim()}...`;
}

function updateLogText(log) {
  return String(log?.text || log?.body || "").trim();
}

function updateLogImageUrl(log) {
  const value = String(log?.image?.url || log?.imageUrl || log?.bannerUrl || "").trim();
  return isRemoteUrl(value) ? value : "";
}

function isRemoteUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function youtubeEmbedUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    let id = "";
    if (host === "youtu.be") {
      id = url.pathname.replace(/^\/+/, "").split("/")[0] || "";
    } else if (host.endsWith("youtube.com")) {
      if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
      else id = url.searchParams.get("v") || "";
    }
    if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return "";
    return `https://www.youtube.com/embed/${id}?rel=0`;
  } catch {
    return "";
  }
}

function updateLogPlayable(log) {
  const media = log?.media && typeof log.media === "object" ? log.media : null;
  const youtube = String(log?.youtubeUrl || (media?.type === "youtube" ? media.url : "") || "").trim();
  const embed = youtubeEmbedUrl(youtube);
  if (embed) return { type: "youtube", url: embed, originalUrl: youtube, title: media?.title || log?.title || "Update video" };
  const videoUrl = String(log?.videoUrl || log?.video?.url || (media?.type === "video" ? media.url : "") || "").trim();
  if (isRemoteUrl(videoUrl)) return { type: "video", url: videoUrl, title: media?.title || log?.title || "Update video" };
  return null;
}

function updateLogMediaLabel(log) {
  const playable = updateLogPlayable(log);
  if (!playable) return "";
  return playable.type === "youtube" ? "YouTube" : "Video";
}

function updateLogMeta(log) {
  const version = String(log?.version || "").trim();
  if (version) return `Update ${version}`;
  return log?.publishedAt ? shortDateTime(log.publishedAt) : "Update Log";
}

function updateLogDetailMeta(log) {
  const parts = [updateLogMeta(log)];
  if (log?.version && log?.publishedAt) parts.push(shortDateTime(log.publishedAt));
  return parts.filter(Boolean).join("  /  ");
}

function closeUpdateLog() {
  if (!els.updateLogOverlay) return;
  els.updateLogOverlay.hidden = true;
  els.newsView?.classList.remove("article-open");
  els.updateLogHero.style.backgroundImage = "";
  els.updateLogArticleBody.innerHTML = "";
  if (els.updateLogWatchButton) els.updateLogWatchButton.hidden = true;
  activeUpdateLog = null;
  document.body.classList.remove("update-log-open");
}

function closeUpdateLogVideo() {
  if (!els.updateLogVideoOverlay) return;
  els.updateLogVideoOverlay.hidden = true;
  els.updateLogVideoStage.innerHTML = "";
}

function appendUpdateLogParagraph(parent, text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  parent.appendChild(paragraph);
}

function renderUpdateLogArticleText(parent, text) {
  parent.innerHTML = "";
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let list = null;
  const closeList = () => { list = null; };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const tag = heading[1].length === 1 ? "h2" : "h3";
      const el = document.createElement(tag);
      el.textContent = heading[2].trim();
      parent.appendChild(el);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        parent.appendChild(list);
      }
      const item = document.createElement("li");
      item.textContent = bullet[1].trim();
      list.appendChild(item);
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/i);
    if (image) {
      closeList();
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = image[2];
      img.alt = image[1] || "Update image";
      img.loading = "lazy";
      figure.appendChild(img);
      if (image[1]) {
        const caption = document.createElement("figcaption");
        caption.textContent = image[1];
        figure.appendChild(caption);
      }
      parent.appendChild(figure);
      continue;
    }
    closeList();
    appendUpdateLogParagraph(parent, line);
  }
  if (!parent.childElementCount) {
    appendUpdateLogParagraph(parent, "No update-log details were provided.");
  }
}

function openUpdateLog(log) {
  if (!els.updateLogOverlay) return;
  closeUpdateLogVideo();
  activateTab("news");
  activeUpdateLog = log;
  const imageUrl = updateLogImageUrl(log);
  els.updateLogModalMeta.textContent = updateLogDetailMeta(log);
  els.updateLogModalTitle.textContent = log?.title || "AHT Update Feed";
  els.updateLogModalSubtitle.textContent = String(log?.subtitle || "").trim();
  els.updateLogModalSubtitle.hidden = !els.updateLogModalSubtitle.textContent;
  els.updateLogHero.classList.toggle("has-image", Boolean(imageUrl));
  els.updateLogHero.style.backgroundImage = imageUrl ? `linear-gradient(180deg, rgba(5, 8, 9, 0.04), rgba(5, 8, 9, 0.22)), url("${imageUrl.replace(/"/g, "%22")}"), url("assets/aht-cover.png")` : "";
  renderUpdateLogArticleText(els.updateLogArticleBody, updateLogText(log));
  if (els.updateLogWatchButton) els.updateLogWatchButton.hidden = !updateLogPlayable(log);
  els.updateLogOverlay.hidden = false;
  els.newsView?.classList.add("article-open");
  els.updateLogOverlay.scrollTop = 0;
  document.body.classList.add("update-log-open");
  window.setTimeout(() => els.updateLogCloseButton?.focus(), 0);
}

function openUpdateLogVideo(log) {
  const playable = updateLogPlayable(log);
  if (!playable || !els.updateLogVideoOverlay) return;
  els.updateLogVideoStage.innerHTML = "";
  if (playable.type === "youtube") {
    const iframe = document.createElement("iframe");
    iframe.src = playable.url;
    iframe.title = playable.title;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    els.updateLogVideoStage.appendChild(iframe);
  } else {
    const video = document.createElement("video");
    video.src = playable.url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    els.updateLogVideoStage.appendChild(video);
  }
  els.updateLogVideoOverlay.hidden = false;
}

function buildUpdateLogCard(log, index, surface = "home") {
  const artClasses = ["aht-art", "patch-art", "sync-art"];
  const playable = updateLogPlayable(log);
  const imageUrl = updateLogImageUrl(log);
  const card = document.createElement("article");
  card.className = `feature-card ${index === 0 ? "large" : ""} ${playable ? "is-playable" : ""} ${surface === "news" ? "news-feed-card" : "home-news-card"}`.trim();

  const art = document.createElement("button");
  art.type = "button";
  art.className = `feature-art feature-art-button ${imageUrl ? "has-image" : (artClasses[index % artClasses.length] || "patch-art")}`;
  art.setAttribute("aria-label", `Read ${log?.title || "update log"}`);
  if (imageUrl) art.style.backgroundImage = `linear-gradient(180deg, rgba(10, 12, 12, 0.04), rgba(10, 12, 12, 0.36)), url("${imageUrl.replace(/"/g, "%22")}")`;
  art.addEventListener("click", () => openUpdateLog(log));
  if (playable) {
    const glyph = document.createElement("div");
    glyph.className = "play-glyph";
    const icon = document.createElement("span");
    icon.className = "button-icon icon-play";
    icon.setAttribute("aria-hidden", "true");
    glyph.appendChild(icon);
    art.appendChild(glyph);
  }

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "feature-copy feature-copy-button";
  copy.setAttribute("aria-label", `Read ${log?.title || "update log"}`);
  copy.addEventListener("click", () => openUpdateLog(log));
  const meta = document.createElement("span");
  meta.className = "feature-meta";
  const title = document.createElement("strong");
  const body = document.createElement("p");
  body.className = "feature-summary";
  const cta = document.createElement("span");
  cta.className = "feature-cta";
  meta.textContent = updateLogDetailMeta(log);
  title.textContent = log?.title || "AHT Update Feed";
  body.textContent = updateLogSummary(log?.text || log?.body || "", surface === "news" ? 220 : 120);
  cta.textContent = "Read article  ›";
  copy.append(meta, title, body, cta);
  card.append(art, copy);
  return card;
}

function renderUpdateLogs(logs = []) {
  const allItems = Array.isArray(logs) ? logs.slice(0, 12) : [];
  const homeItems = allItems.slice(0, 3);
  els.updateLogGrid.innerHTML = "";
  els.updateLogGrid.hidden = homeItems.length === 0;
  for (const [index, log] of homeItems.entries()) {
    els.updateLogGrid.appendChild(buildUpdateLogCard(log, index, "home"));
  }

  if (els.newsFeedGrid) {
    els.newsFeedGrid.innerHTML = "";
    els.newsFeedGrid.hidden = allItems.length === 0;
    for (const [index, log] of allItems.entries()) {
      els.newsFeedGrid.appendChild(buildUpdateLogCard(log, index, "news"));
    }
  }
  if (els.newsEmptyState) els.newsEmptyState.hidden = allItems.length > 0;
  if (els.newsLatestLabel) {
    els.newsLatestLabel.textContent = allItems.length ? updateLogMeta(allItems[0]) : "No published updates";
  }
}

function minecraftUsernameError(username) {
  const value = String(username || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) {
    return "Enter a valid Minecraft username.";
  }
  return "";
}

function accountUsername(status = currentStatus) {
  return status?.identity?.minecraftUsername || status?.config?.sync?.playerLabel || "";
}

function renderAccountGate(status) {
  if (!els.accountOverlay) return;
  const shouldGate = !status.developerMode && !status.identity?.minecraftUsername;
  els.accountOverlay.hidden = !shouldGate;
  if (shouldGate) {
    window.setTimeout(() => els.minecraftUsernameInput.focus(), 0);
  } else {
    els.accountError.textContent = "";
  }
}

async function submitAccount() {
  const username = els.minecraftUsernameInput.value.trim();
  const validation = minecraftUsernameError(username);
  if (validation) {
    els.accountError.textContent = validation;
    return;
  }
  setUnavailable(els.accountCreateButton, true);
  els.accountError.textContent = "";
  try {
    const result = await window.aht.accountRegister(username);
    els.accountOverlay.hidden = true;
    els.playerLabelView.textContent = result.username || username;
    showToast("Account created", "Launcher access is ready.", "success");
    await refresh();
  } catch (error) {
    const message = cleanErrorMessage(error);
    els.accountError.textContent = /not available/i.test(message)
      ? "That username is not available."
      : message;
  } finally {
    setUnavailable(els.accountCreateButton, false);
  }
}

function showLegalDocument(kind = "terms") {
  if (!currentLegalState || !els.legalDocumentText) return;
  const privacy = kind === "privacy";
  els.legalDocumentText.textContent = privacy ? currentLegalState.privacyText : currentLegalState.termsText;
  els.legalDocumentText.scrollTop = 0;
  for (const tab of [els.legalTermsTab, els.legalPrivacyTab]) {
    if (!tab) continue;
    const selected = tab.dataset.legalDocument === (privacy ? "privacy" : "terms");
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
}

async function loadLegalGate() {
  if (!els.legalOverlay || typeof window.aht?.legalStatus !== "function") return;
  try {
    currentLegalState = await window.aht.legalStatus();
    if (!currentLegalState?.required) {
      els.legalOverlay.hidden = true;
      return;
    }
    els.legalTitle.textContent = currentLegalState.reason === "updated" ? "Terms have changed" : "Review Terms & Privacy";
    els.legalIntro.textContent = currentLegalState.reason === "updated"
      ? "You must review and accept the current agreement before continuing."
      : "Review and accept the agreement before using A Hard Time Launcher.";
    els.legalVersion.textContent = `Terms ${currentLegalState.termsVersion} | Privacy ${currentLegalState.privacyVersion}`;
    els.legalAcceptCheckbox.checked = false;
    els.legalAcceptCheckbox.disabled = false;
    els.legalAcceptButton.disabled = true;
    setUnavailable(els.legalAcceptButton, true);
    els.legalError.textContent = "";
    showLegalDocument("terms");
    els.legalOverlay.hidden = false;
    window.setTimeout(() => els.legalDocumentText?.focus(), 0);
  } catch (error) {
    currentLegalState = null;
    els.legalTitle.textContent = "Terms unavailable";
    els.legalIntro.textContent = "The legal documents could not be loaded. Restart the launcher or reinstall it.";
    els.legalVersion.textContent = "";
    els.legalDocumentText.textContent = cleanErrorMessage(error);
    els.legalAcceptCheckbox.checked = false;
    els.legalAcceptCheckbox.disabled = true;
    els.legalAcceptButton.disabled = true;
    setUnavailable(els.legalAcceptButton, true);
    els.legalOverlay.hidden = false;
  }
}

async function acceptLegalTerms() {
  if (!currentLegalState || !els.legalAcceptCheckbox?.checked) return;
  els.legalAcceptButton.disabled = true;
  setUnavailable(els.legalAcceptButton, true);
  els.legalAcceptCheckbox.disabled = true;
  els.legalError.textContent = "";
  try {
    await window.aht.legalAccept({
      termsVersion: currentLegalState.termsVersion,
      privacyVersion: currentLegalState.privacyVersion,
      affirmed: true
    });
    els.legalOverlay.hidden = true;
    showToast("Terms accepted", "Your acceptance was saved on this device.", "success");
    if (currentStatus) renderAccountGate(currentStatus);
  } catch (error) {
    els.legalError.textContent = cleanErrorMessage(error);
    els.legalAcceptCheckbox.disabled = false;
    els.legalAcceptButton.disabled = !els.legalAcceptCheckbox.checked;
    setUnavailable(els.legalAcceptButton, !els.legalAcceptCheckbox.checked);
  }
}

function setFriendsStatus(message = "", state = "") {
  if (!els.friendsStatus) return;
  els.friendsStatus.textContent = message;
  els.friendsStatus.className = `friends-status ${state}`.trim();
}

function pendingFriendRequestCount(state = friendsSocialState) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const count = Number(state?.counts?.requests);
  return Math.max(0, requests.length, Number.isFinite(count) ? count : 0);
}

function renderFriendsNotification(state = friendsSocialState) {
  const count = pendingFriendRequestCount(state);
  const label = count > 99 ? "99+" : String(count);
  for (const badge of [els.profileFriendsBadge, els.friendsRequestsBadge]) {
    if (!badge) continue;
    badge.textContent = label;
    badge.hidden = count < 1;
    badge.setAttribute("aria-label", count === 1 ? "1 friend request" : `${count} friend requests`);
  }
  if (els.profileFriendsButton) {
    els.profileFriendsButton.setAttribute("aria-label", count > 0
      ? `Open friends, ${count} pending friend request${count === 1 ? "" : "s"}`
      : "Open friends");
  }
}

function setFriendsBusy(busy) {
  friendsBusy = Boolean(busy);
  for (const button of els.friendsOverlay?.querySelectorAll("[data-social-action]") || []) {
    setUnavailable(button, friendsBusy || button.dataset.actionsAvailable !== "true");
  }
}

function friendListEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "friends-empty";
  empty.textContent = message;
  return empty;
}

function socialActionButton(action, label, target, actionsAvailable) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button compact friend-row-action";
  button.textContent = label;
  button.dataset.socialAction = action;
  button.dataset.actionsAvailable = String(Boolean(actionsAvailable));
  setUnavailable(button, friendsBusy || !actionsAvailable);
  button.addEventListener("click", () => {
    if (!isUnavailable(button)) runFriendAction(action, target);
  });
  return button;
}

function relativePresenceTime(timestamp) {
  const parsed = Date.parse(String(timestamp || ""));
  if (!Number.isFinite(parsed)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ${hours % 24}h`;
  return `${Math.floor(days / 7)}w ${days % 7}d`;
}

function presenceDetail(person) {
  const server = String(person?.server || "").trim();
  if (person?.online) {
    const duration = relativePresenceTime(person.onlineSince);
    return `${server ? `${server} · ` : ""}Online${duration ? ` for ${duration}` : ""}`;
  }
  const since = relativePresenceTime(person?.lastSeenAt);
  return `Offline${since ? ` · last seen ${since} ago` : ""}${server ? ` · ${server}` : ""}`;
}

function friendRow(person) {
  const row = document.createElement("div");
  row.className = "friend-row";

  const name = document.createElement("strong");
  name.textContent = person.username;

  const presence = document.createElement("span");
  presence.className = `friend-state ${person.online ? "online" : "offline"}`;
  presence.textContent = presenceDetail(person);
  row.append(name, presence);
  return row;
}

function requestRow(person, actionsAvailable) {
  const row = document.createElement("div");
  row.className = "friend-row";
  const name = document.createElement("strong");
  name.textContent = person.username;
  const presence = document.createElement("span");
  presence.className = `friend-state ${person.online ? "online" : "offline"}`;
  presence.textContent = presenceDetail(person);
  const actions = document.createElement("span");
  actions.className = "friend-row-actions";
  actions.append(
    socialActionButton("accept_friend", "Accept", person.username, actionsAvailable),
    socialActionButton("decline_friend", "Decline", person.username, actionsAvailable)
  );
  row.append(name, presence, actions);
  return row;
}

function renderFriendsPanel(social) {
  const state = social || {};
  const friends = Array.isArray(state.friends) ? state.friends : [];
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const actionsAvailable = Boolean(state.available && state.actionsAvailable);
  friendsActionsAvailable = actionsAvailable;
  friendsSocialState = state;
  renderFriendsNotification(state);
  const counts = state.counts || {};

  els.friendsCount.textContent = String(Number.isFinite(Number(counts.friends)) ? Number(counts.friends) : friends.length);
  els.friendsOnlineCount.textContent = String(Number.isFinite(Number(counts.online)) ? Number(counts.online) : friends.filter((friend) => friend.online).length);
  if (els.friendsRequestsBadge) {
    const requestCount = pendingFriendRequestCount(state);
    els.friendsRequestsBadge.textContent = requestCount > 99 ? "99+" : String(requestCount);
    els.friendsRequestsBadge.hidden = requestCount < 1;
  }
  els.friendsSummary.textContent = state.available
    ? `${state.username || accountUsername()}${requests.length ? ` | ${requests.length} pending request${requests.length === 1 ? "" : "s"} in game` : ""}`
    : "Friend service unavailable";

  els.friendsList.replaceChildren();
  if (!friends.length) {
    els.friendsList.appendChild(friendListEmpty(state.available ? "No friends yet." : "Friends could not be loaded."));
  } else {
    for (const friend of friends) els.friendsList.appendChild(friendRow(friend));
  }

  els.friendsRequestsList?.replaceChildren();
  if (!requests.length) {
    els.friendsRequestsList?.appendChild(friendListEmpty(state.available ? "No pending requests." : "Requests could not be loaded."));
  } else {
    for (const request of requests) els.friendsRequestsList?.appendChild(requestRow(request, actionsAvailable));
  }

  if (state.message) setFriendsStatus(state.message, state.available ? "warn" : "bad");
  else setFriendsStatus(state.available ? "Friend list is current." : "Friend service is not connected yet.", state.available ? "ok" : "bad");
}

async function refreshFriendsPanel({ quiet = false } = {}) {
  if (friendsLoading || typeof window.aht?.socialList !== "function") return;
  friendsLoading = true;
  const requestId = ++friendsRequestId;
  setUnavailable(els.friendsRefreshButton, true);
  if (!quiet) setFriendsStatus("Loading friends...", "warn");
  try {
    const social = await window.aht.socialList();
    if (requestId !== friendsRequestId || els.friendsOverlay.hidden) return;
    renderFriendsPanel(social);
  } catch (error) {
    if (requestId !== friendsRequestId || els.friendsOverlay.hidden) return;
    renderFriendsPanel({
      available: false,
      actionsAvailable: false,
      username: accountUsername(),
      friends: [],
      requests: [],
      counts: { friends: 0, online: 0, requests: 0 },
      message: cleanErrorMessage(error)
    });
  } finally {
    friendsLoading = false;
    setUnavailable(els.friendsRefreshButton, false);
  }
}

async function refreshFriendsNotification() {
  if (typeof window.aht?.socialList !== "function" || !accountUsername(currentStatus)) {
    renderFriendsNotification(null);
    return;
  }
  try {
    const social = await window.aht.socialList();
    friendsSocialState = social;
    renderFriendsNotification(social);
    if (els.friendsOverlay && !els.friendsOverlay.hidden && !friendsLoading) renderFriendsPanel(social);
  } catch {
    // Keep the last known request count until the service is reachable again.
  }
}

function queueFriendsRefresh(delayMs) {
  const timer = window.setTimeout(() => {
    friendsActionRefreshTimers.delete(timer);
    if (els.friendsOverlay && !els.friendsOverlay.hidden) refreshFriendsPanel({ quiet: true });
  }, delayMs);
  friendsActionRefreshTimers.add(timer);
}

async function runFriendAction(action, targetOverride = "") {
  if (friendsBusy || !friendsActionsAvailable || typeof window.aht?.socialAction !== "function") return;
  if (!["accept_friend", "decline_friend"].includes(action)) return;
  const target = String(targetOverride || "").trim();
  const validation = minecraftUsernameError(target);
  if (validation) {
    setFriendsStatus(validation, "bad");
    return;
  }
  setFriendsBusy(true);
  setFriendsStatus("Sending action to the AHT server...", "warn");
  try {
    const result = await window.aht.socialAction({ action, target });
    if (result?.social) renderFriendsPanel(result.social);
    setFriendsStatus(result?.message || "Friend action queued.", "ok");
    queueFriendsRefresh(2500);
    queueFriendsRefresh(7500);
  } catch (error) {
    setFriendsStatus(cleanErrorMessage(error), "bad");
  } finally {
    setFriendsBusy(false);
  }
}

function openFriendsPanel() {
  if (!els.friendsOverlay) return;
  els.friendsOverlay.hidden = false;
  renderFriendsPanel(friendsSocialState || {
    available: false,
    actionsAvailable: false,
    username: accountUsername(),
    friends: [],
    requests: [],
    counts: { friends: 0, online: 0, requests: 0 },
    message: "Loading friends..."
  });
  refreshFriendsPanel();
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = window.setInterval(() => refreshFriendsPanel({ quiet: true }), 15000);
  clearInterval(friendsPresenceTimer);
  friendsPresenceTimer = window.setInterval(() => {
    if (friendsSocialState && !els.friendsOverlay.hidden && !friendsLoading) renderFriendsPanel(friendsSocialState);
  }, 30000);
  window.setTimeout(() => els.friendsCloseButton?.focus(), 0);
}

function closeFriendsPanel() {
  if (!els.friendsOverlay) return;
  els.friendsOverlay.hidden = true;
  friendsRequestId += 1;
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = null;
  clearInterval(friendsPresenceTimer);
  friendsPresenceTimer = null;
  for (const timer of friendsActionRefreshTimers) clearTimeout(timer);
  friendsActionRefreshTimers.clear();
  els.profileFriendsButton?.focus();
}

function compactPath(value) {
  if (!value) return "-";
  const original = String(value);
  const normalized = original.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 4) return original;
  return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function renderSetupAssistant(status) {
  const setup = status.setup || {};
  const latestUrl = status.config?.latestUrl || "";
  const instanceDir = status.config?.instanceDir || "";
  const hasFeed = Boolean(latestUrl);
  const hasInstance = Boolean(instanceDir);
  const instanceMissing = hasInstance && setup.instanceExists === false;
  const ready = hasFeed && hasInstance && !instanceMissing;
  const canAutoConfigure = Boolean(setup.canAutoConfigure);

  let state = "bad";
  let label = "Setup needed";
  let title = "Launcher setup needed";

  if (ready) {
    state = "ok";
    label = "Setup ready";
    title = "Launcher ready";
  } else if (canAutoConfigure) {
    state = "warn";
    label = "Setup available";
    title = status.developerMode ? "Auto setup can fill local paths" : "Setup can finish automatically";
  }

  const showDiagnostics = Boolean(status.developerMode);
  const feedLine = hasFeed
    ? (showDiagnostics ? `Feed: ${compactPath(latestUrl)}` : "Feed: connected")
    : showDiagnostics && setup.localReleaseLatest
      ? `Local feed: ${compactPath(setup.localReleaseLatest)}`
      : "Feed: missing";
  const instanceLine = showDiagnostics
    ? hasInstance
      ? instanceMissing && setup.detectedInstanceDir
        ? `Detected instance: ${compactPath(setup.detectedInstanceDir)}`
        : `Instance: ${compactPath(instanceDir)}${instanceMissing ? " (not found)" : ""}`
      : setup.detectedInstanceDir
        ? `Detected instance: ${compactPath(setup.detectedInstanceDir)}`
        : `Default instance: ${compactPath(setup.defaultInstanceDir)}`
    : hasInstance
      ? `Install folder: ${instanceMissing ? "missing" : "ready"}`
      : "Install folder: not selected";
  const detailParts = [feedLine, instanceLine];
  if (showDiagnostics) {
    detailParts.push(setup.cacheModsDir ? `Cache mods: ${compactPath(setup.cacheModsDir)}` : "Cache mods: not detected");
  }

  els.setupAssistantCard.className = `setup-assistant-card ${state}`.trim();
  els.setupAssistantState.textContent = label;
  els.setupAssistantTitle.textContent = title;
  els.setupAssistantDetail.textContent = detailParts.join(" | ");
  setUnavailable(els.setupAutoButton, !canAutoConfigure);
  setUnavailable(els.settingsAutoSetupButton, !canAutoConfigure);
  const autoTitle = canAutoConfigure
    ? (status.developerMode ? "Apply detected release and instance paths" : "Finish launcher setup")
    : (status.developerMode ? "No local release or instance paths were detected" : "Launcher setup is not available");
  els.setupAutoButton.title = autoTitle;
  els.settingsAutoSetupButton.title = autoTitle;
}

function setSettingsFeed(state, label, title, detail) {
  els.settingsFeedCard.className = `settings-feed-card ${state}`.trim();
  els.settingsFeedState.textContent = label;
  els.settingsFeedTitle.textContent = title;
  els.settingsFeedDetail.textContent = detail;
}

function packInstallState(status = currentStatus) {
  if (!status?.installed?.version) return { state: "bad", label: "Uninstalled" };
  if (status.updateRequired) return { state: "warn", label: "Outdated" };
  return { state: "ok", label: "Updated" };
}
function isFirstPublishPending(status = currentStatus) {
  const error = String(status?.latestError || "");
  return Boolean(
    error
    && !status?.latest
    && !status?.installed
    && /(?:404|Release object not found|latest\.json)/i.test(error)
  );
}

function playerSafeFeedProblem(status = currentStatus) {
  if (!status?.latestError) return "";
  if (status.developerMode) return status.latestError;
  if (isFirstPublishPending(status)) {
    return "No update has been published yet. The pack will install after the first update is available.";
  }
  return "The update service is not reachable right now. Try again later.";
}

function playerSafeBlockedReason(status = currentStatus) {
  if (status?.latestError && !(status?.developerClientBypass && status?.installed)) return playerSafeFeedProblem(status);
  return status?.launchBlockedReason || "";
}

function playerSafeErrorMessage(message = "", status = currentStatus) {
  const value = cleanErrorMessage(message);
  if (status?.developerMode) return value;
  if (/Release feed cannot be checked|latest\.json|GET https?:\/\//i.test(value)) {
    return playerSafeFeedProblem({ ...status, latestError: status?.latestError || value });
  }
  return value;
}

function launchBlockedBadge(status = currentStatus) {
  if (status?.launchReady) return { text: "Ready", state: "ok" };
  const reason = playerSafeBlockedReason(status);
  if (status?.updateBlockedReason || /Update package is not ready/i.test(reason)) return { text: "Update unavailable", state: "warn" };
  if (status?.integrity?.counts?.corrupted > 0 || /Repair required|corrupt|managed file issue|mod file issue/i.test(reason)) return { text: "Repair needed", state: "warn" };
  if (status?.updateRequired || /^Update required/i.test(reason)) return { text: "Update required", state: "warn" };
  if (!status?.installed || /Install the pack before playing/i.test(reason)) return { text: "Not Installed", state: "warn" };
  if (status?.latestError || /Release feed|update service|latest\.json|metadata/i.test(reason)) return { text: "Service unavailable", state: "warn" };
  return { text: "Setup needed", state: "warn" };
}

function setLaunchStatusBadge(status = currentStatus) {
  const badge = launchBlockedBadge(status);
  setBadge(badge.text, badge.state);
}

function releaseUi(target = "stable") {
  if (target === "ptb") {
    return {
      card: els.ptbReleaseCheckCard,
      state: els.ptbReleaseCheckState,
      title: els.ptbReleaseCheckTitle,
      detail: els.ptbReleaseCheckDetail,
      progress: els.ptbReleaseUploadProgress,
      progressLabel: els.ptbReleaseUploadProgressLabel,
      progressCount: els.ptbReleaseUploadProgressCount,
      progressBar: els.ptbReleaseUploadProgressBar
    };
  }
  return {
    card: els.releaseCheckCard,
    state: els.releaseCheckState,
    title: els.releaseCheckTitle,
    detail: els.releaseCheckDetail,
    progress: els.releaseUploadProgress,
    progressLabel: els.releaseUploadProgressLabel,
    progressCount: els.releaseUploadProgressCount,
    progressBar: els.releaseUploadProgressBar,
    publishButton: els.publishReleaseButton
  };
}

function setReleaseCheck(state, label, title, detail, target = "stable") {
  const ui = releaseUi(target);
  if (!ui.card) return;
  ui.card.className = `release-check-card ${state}`.trim();
  ui.state.textContent = label;
  ui.title.textContent = title;
  ui.detail.textContent = detail;
}

function setUpdateLogStatus(state, label, title, detail) {
  els.updateLogStatus.className = `release-check-card ${state}`.trim();
  const span = els.updateLogStatus.querySelector("span");
  const strong = els.updateLogStatus.querySelector("strong");
  const p = els.updateLogStatus.querySelector("p");
  span.textContent = label;
  strong.textContent = title;
  p.textContent = detail;
}

function setLauncherUpdateStatus(state, label, title, detail) {
  if (!els.launcherUpdateStatus) return;
  els.launcherUpdateStatus.className = `release-check-card ${state}`.trim();
  const span = els.launcherUpdateStatus.querySelector("span");
  const strong = els.launcherUpdateStatus.querySelector("strong");
  const p = els.launcherUpdateStatus.querySelector("p");
  if (span) span.textContent = label;
  if (strong) strong.textContent = title;
  if (p) p.textContent = detail;
}

function setServerTransferStatus(state, label, title, detail) {
  if (!els.serverTransferStatus) return;
  els.serverTransferStatus.className = `release-check-card ${state}`.trim();
  const span = els.serverTransferStatus.querySelector("span");
  const strong = els.serverTransferStatus.querySelector("strong");
  const p = els.serverTransferStatus.querySelector("p");
  if (span) span.textContent = label;
  if (strong) strong.textContent = title;
  if (p) p.textContent = detail;
}

function releaseKey(target = "stable") {
  return `${developerOutDir()}::${target}`;
}

function inputValue(input, fallback = "") {
  return input ? input.value.trim() : fallback;
}

function setInputValue(input, value, options = {}) {
  if (!input) return;
  if (!options.force && document.activeElement === input) return;
  const nextValue = value == null ? "" : String(value);
  if (input.value !== nextValue) input.value = nextValue;
}

function formatMemory(mb) {
  const value = Number(mb || DEFAULT_MEMORY_MB);
  const rounded = Math.max(DEFAULT_MEMORY_MB, Math.min(32768, Math.round(value / 512) * 512));
  return Number.isInteger(rounded / 1024) ? `${rounded / 1024} GB` : `${(rounded / 1024).toFixed(1)} GB`;
}

function setMemoryValue(mb) {
  if (!els.minecraftMemoryInput) return;
  const value = Number(mb || DEFAULT_MEMORY_MB);
  const rounded = Math.max(
    Number(els.minecraftMemoryInput.min || DEFAULT_MEMORY_MB),
    Math.min(Number(els.minecraftMemoryInput.max || 16384), Math.round(value / 512) * 512)
  );
  els.minecraftMemoryInput.value = String(rounded);
  if (els.minecraftMemoryOutput) {
    els.minecraftMemoryOutput.value = formatMemory(rounded);
    els.minecraftMemoryOutput.textContent = formatMemory(rounded);
  }
}

function setLauncherReinstallStatus(state, label, title, detail) {
  if (!els.launcherReinstallStatus) return;
  els.launcherReinstallStatus.className = `release-check-card ${state}`.trim();
  const span = els.launcherReinstallStatus.querySelector("span");
  const strong = els.launcherReinstallStatus.querySelector("strong");
  const p = els.launcherReinstallStatus.querySelector("p");
  if (span) span.textContent = label;
  if (strong) strong.textContent = title;
  if (p) p.textContent = detail;
}

function developerOutDir() {
  return currentStatus?.config?.developer?.defaultOutDir || "";
}

function normalizePlayerFeedUrl(value = "") {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!/\/latest\.json$/i.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/latest.json`;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function workerBaseFromFeedUrl(value = "") {
  const feed = normalizePlayerFeedUrl(value);
  if (!/^https?:\/\//i.test(feed)) return "";
  try {
    const normalized = new URL(feed);
    normalized.pathname = normalized.pathname.replace(/\/ptb\/latest\.json$/i, "/latest.json");
    return new URL(".", normalized).toString();
  } catch {
    return "";
  }
}

function artifactBaseFromFeedUrl(value = "") {
  const feed = normalizePlayerFeedUrl(value);
  if (!/^https?:\/\//i.test(feed)) return "";
  try {
    return new URL(".", new URL(feed)).toString();
  } catch {
    return "";
  }
}

function workerUrlFromFeedUrl(value = "", relPath = "") {
  const base = workerBaseFromFeedUrl(value);
  if (!base) return "";
  return new URL(relPath, base).toString();
}

function playerFeedUrl() {
  return normalizePlayerFeedUrl(inputValue(els.playerFeedUrlInput, currentStatus?.config?.latestUrl || ""));
}

function ptbPlayerFeedUrl() {
  const stableFeed = playerFeedUrl();
  if (!/^https?:\/\//i.test(stableFeed)) return "";
  try {
    const stableUrl = new URL(stableFeed);
    if (/\/ptb\/latest\.json$/i.test(stableUrl.pathname)) return stableUrl.toString();
    return new URL("ptb/latest.json", new URL(".", stableUrl)).toString();
  } catch {
    return "";
  }
}

function releaseFeedUrl(target = "stable") {
  return target === "ptb" ? ptbPlayerFeedUrl() : playerFeedUrl();
}

function developerBaseUrl() {
  return currentStatus?.config?.developer?.adminBaseUrl || currentStatus?.config?.sync?.baseUrl || "";
}

function selectedPackZip(target = "stable") {
  return inputValue(target === "ptb" ? els.ptbPackZipInput : els.packZipInput, "");
}

function releaseBucketName() {
  return els.bucketInput.value.trim() || "ahtlauncher";
}

function dataBucketName() {
  const release = releaseBucketName();
  return release === "ahtlauncher" ? "ahtlauncher-data" : `${release}-data`;
}

function missingFastR2UploadFields() {
  const missing = [];
  if (!inputValue(els.r2AccountIdInput, "")) missing.push("R2 Account ID");
  if (!inputValue(els.r2AccessKeyIdInput, "")) missing.push("R2 Access Key ID");
  if (!inputValue(els.r2SecretAccessKeyInput, "")) missing.push("R2 Secret Access Key");
  return missing;
}

function cacheOnlyMode() {
  return Boolean(els.cacheOnlyInput?.checked);
}

function localCurseForgeApiKey() {
  return inputValue(els.curseforgeApiKeyInput, "");
}

function localLauncherProofSecret() {
  return inputValue(els.launcherProofSecretInput, "");
}

function localSocialServerSecret() {
  return inputValue(els.socialServerSecretInput, "");
}

function generateLauncherProofSecret() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function saveDeveloperSecrets({ quiet = true } = {}) {
  if (!currentStatus?.developerMode && !document.body.classList.contains("dev-mode")) return null;
  if (typeof window.aht.devSaveSecrets !== "function") return null;
  const result = await window.aht.devSaveSecrets({
    curseforgeApiKey: localCurseForgeApiKey(),
    serverSshPassword: inputValue(els.serverPasswordInput, ""),
    launcherProofSecret: localLauncherProofSecret(),
    socialServerSecret: localSocialServerSecret(),
    githubToken: inputValue(els.githubTokenInput, ""),
    r2AccountId: inputValue(els.r2AccountIdInput, ""),
    r2AccessKeyId: inputValue(els.r2AccessKeyIdInput, ""),
    r2SecretAccessKey: inputValue(els.r2SecretAccessKeyInput, "")
  });
  if (!quiet && result?.warning) {
    showToast("Developer key saved", result.warning, "warn");
  }
  return result;
}

function queueDeveloperSecretSave() {
  clearTimeout(developerSecretSaveTimer);
  if ((!currentStatus?.developerMode && !document.body.classList.contains("dev-mode")) || typeof window.aht.devSaveSecrets !== "function") return;
  developerSecretSaveTimer = setTimeout(() => {
    saveDeveloperSecrets().catch((error) => {
      setDevLog(cleanErrorMessage(error));
    });
  }, 600);
}

function publishBlockReason(target = "stable") {
  if (!developerAuthenticated) return "Developer login is required before publishing releases.";
  if (!selectedPackZip(target)) return target === "ptb" ? "Choose or create an exact PTB client ZIP first." : "Choose an exact AHT client ZIP from Modpack ZIP first.";
  if (!/^https?:\/\//i.test(releaseFeedUrl(target))) {
    return setupCloudBlockReason();
  }
  return "";
}

function setupCloudBlockReason() {
  if (!developerAuthenticated) return "Developer login is required before cloud setup.";
  if (!localLauncherProofSecret()) {
    return "Enter the Launcher Proof Secret before cloud setup. The server must use the same value.";
  }
  if (localSocialServerSecret().length < 32) {
    return "Enter a Server Social Secret containing at least 32 characters before cloud setup.";
  }
  return "";
}

function cacheOnlyValidationBlockReason(validation) {
  if (!cacheOnlyMode()) return "";
  const coverage = validation?.artifacts?.cacheCoverage;
  if (!coverage) {
    return "Cache-only mode requires fallback cache coverage data before publishing.";
  }
  if (coverage.complete) return "";
  const total = Number(coverage.total || 0);
  const covered = Number(coverage.covered || 0);
  const missing = Array.isArray(coverage.missing) ? coverage.missing : [];
  const missingPreview = missing.slice(0, 5).join(", ");
  const suffix = missingPreview ? ` Missing: ${missingPreview}${missing.length > 5 ? ", ..." : ""}` : "";
  return `Cache-only mode requires every CurseForge manifest mod to be in the fallback cache. Covered ${covered}/${total}.${suffix}`;
}

function updateReleaseUploadState() {
  const reason = publishBlockReason("stable");
  const setupReason = setupCloudBlockReason();
  const defaultsReason = !developerAuthenticated
    ? "Developer login is required before writing player defaults."
    : !/^https?:\/\//i.test(playerFeedUrl())
      ? "Enter the public Player Feed URL first."
      : "";
  setUnavailable(els.publishReleaseButton, releaseBusy || Boolean(reason));
  const ptbCreateReason = developerAuthenticated ? "" : "Developer login is required before creating PTB releases.";
  setUnavailable(els.buildPtbClientZipButton, releaseBusy || Boolean(ptbCreateReason));
  setUnavailable(els.setupCloudButton, releaseBusy || Boolean(setupReason));
  setUnavailable(els.writeDefaultsButton, releaseBusy || Boolean(defaultsReason));
  if (els.setupCloudButton) {
    els.setupCloudButton.title = setupReason || "Create buckets, set Worker secrets, and deploy the Worker";
  }
  if (els.publishReleaseButton) {
    els.publishReleaseButton.title = reason || "Publish stable AHT to its R2 and GitHub release tracks";
  }
  if (els.buildPtbClientZipButton) {
    els.buildPtbClientZipButton.title = ptbCreateReason || "Create and upload a ZIP to the isolated PTB release track";
  }
  if (els.writeDefaultsButton) {
    els.writeDefaultsButton.title = defaultsReason || "Write app.defaults.json for fresh player installs";
  }
}

function invalidateReleaseValidation(label = "Ready", detail = "Pick an exact client ZIP, then publish it to its isolated R2 and GitHub release tracks.", target = "stable") {
  releaseValidationByTarget.delete(target);
  setReleaseUploadProgress(null, true, target);
  setReleaseCheck("warn", label, selectedPackZip(target) ? (target === "ptb" ? "Publish PTB" : "Publish update") : "Choose a ZIP", detail, target);
  updateReleaseUploadState();
}

function releaseSummary(result) {
  const checks = result?.checks?.length || 0;
  const warnings = result?.warnings?.length || 0;
  const errors = result?.errors?.length || 0;
  const noun = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
  return `${noun(checks, "check", "checks")}, ${noun(warnings, "warning", "warnings")}, ${noun(errors, "error", "errors")}.`;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function setProgressElements(wrap, labelEl, countEl, barEl, progress = null, hidden = false) {
  if (!wrap) return;
  if (hidden || !progress) {
    wrap.hidden = true;
    return;
  }
  const percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent || 0))));
  wrap.hidden = false;
  if (barEl) barEl.style.width = `${percent}%`;
  if (countEl) countEl.textContent = `${percent}%`;
  if (labelEl) {
    const activePath = progress.currentFile || progress.currentPath || "";
    const current = activePath ? `${activePath}${Number.isFinite(Number(progress.currentPercent)) ? ` ${Math.round(Number(progress.currentPercent))}%` : ""}` : (progress.phase || "Uploading");
    const speed = progress.speedBytesPerSecond ? ` at ${formatBytes(progress.speedBytesPerSecond)}/s` : "";
    labelEl.textContent = `${current}${speed}`;
  }
}

function setReleaseUploadProgress(progress = null, hidden = false, target = "stable") {
  const ui = releaseUi(target);
  setProgressElements(
    ui.progress,
    ui.progressLabel,
    ui.progressCount,
    ui.progressBar,
    progress,
    hidden
  );
}

function setServerTransferProgress(progress = null, hidden = false) {
  setProgressElements(
    els.serverTransferProgress,
    els.serverTransferProgressLabel,
    els.serverTransferProgressCount,
    els.serverTransferProgressBar,
    progress,
    hidden
  );
}

function setLauncherDeployProgress(progress = null, hidden = false) {
  setProgressElements(
    els.launcherDeployProgress,
    els.launcherDeployProgressLabel,
    els.launcherDeployProgressCount,
    els.launcherDeployProgressBar,
    progress,
    hidden
  );
}

function renderUploadState(state) {
  if (!state) return;
  const target = state.releaseTarget === "ptb" ? "ptb" : "stable";
  const total = state.total || 0;
  const completed = state.completed || 0;
  const progress = state.progress || null;
  const percent = progress?.percent ?? (total ? Math.round((completed / total) * 100) : 0);
  if (state.running) {
    setReleaseUploadProgress(progress || { percent, phase: state.current || "Uploading" }, false, target);
    const hasByteProgress = (progress?.unit === "bytes" || progress?.method === "direct-multipart") && progress?.total;
    const byteDetail = hasByteProgress
      ? `${formatBytes(progress.completed || 0)}/${formatBytes(progress.total)}${progress.speedBytesPerSecond ? ` at ${formatBytes(progress.speedBytesPerSecond)}/s` : ""}`
      : `${completed}/${total} files`;
    setReleaseCheck(
      "warn",
      "Uploading release",
      `${percent}% uploaded`,
      state.current ? `Current: ${state.current}. ${byteDetail}` : "Starting remote R2 upload.",
      target
    );
  } else if (state.error) {
    setReleaseUploadProgress(progress || { percent }, false, target);
    setReleaseCheck("bad", "Upload failed", `${completed}/${total} files uploaded`, state.error, target);
  } else if (state.lastResult) {
    setReleaseUploadProgress({ percent: 100, phase: "Upload complete" }, false, target);
    const verified = state.verification?.publicLatestUrl || state.lastResult?.verification?.publicLatestUrl || "";
    setReleaseCheck("ok", "Upload complete", `${completed}/${total} files uploaded`, verified ? `Player feed verified: ${verified}` : "Release artifacts are in remote R2.", target);
  } else {
    setReleaseUploadProgress(null, true, target);
  }
  if (Array.isArray(state.lines) && state.lines.length) {
    setTextContentBounded(els.devLog, state.lines.join("\n"), DEV_LOG_TEXT_LIMIT);
  }
}

function startUploadPolling() {
  clearInterval(uploadPoll);
  uploadPoll = setInterval(async () => {
    try {
      const state = await window.aht.devUploadState();
      renderUploadState(state);
      if (!state.running) {
        clearInterval(uploadPoll);
        uploadPoll = null;
      }
    } catch {}
  }, 1000);
}

async function buildReleaseFromSelectedZip(reason = "Building release", target = "stable") {
  const packZip = selectedPackZip(target);
  if (!packZip) {
    return null;
  }
  setReleaseCheck("warn", reason, "Preparing selected ZIP", packZip, target);
  const inspected = await window.aht.devInspectPackZip(packZip);
  if (inspected.versionMismatch) {
    throw new Error(`ZIP filename says ${inspected.versionHint}, but release metadata says ${inspected.version}. Fix the ZIP version before upload.`);
  }
  if (!inspected.fullClientZip) {
    throw new Error("Legacy CurseForge export ZIPs are blocked for normal player releases. Use the Modpack ZIP tab to create an exact AHT client ZIP, then publish that ZIP.");
  }
  const result = await window.aht.devBuildRelease({
    packZip,
    outDir: developerOutDir(),
    baseUrl: artifactBaseFromFeedUrl(releaseFeedUrl(target)) || developerBaseUrl(),
    releaseTarget: target,
    cacheModsDir: els.cacheModsInput.value.trim()
  });
  releaseValidationByTarget.delete(target);
  const cacheCount = result.report?.cacheSummary?.matchedManifestFiles ?? 0;
  const exactZip = inspected.fullClientZip || result.latest?.installMode === "full-client-zip";
  const delta = result.report?.deltaSummary;
  const exactDetail = delta?.available
    ? `${delta.changedFileCount} changed, ${delta.deletedFileCount} deleted since ${delta.fromVersion}. Delta ${formatBytes(delta.size)}; full fallback ${formatBytes(delta.fullZipSize)}.`
    : `${inspected.fileCount || result.latest?.clientZip?.fileCount || 0} exact client files. ${delta?.reason || "This release establishes the delta baseline."}`;
  setReleaseCheck(
    "warn",
    "Release built",
    `${inspected.name || result.report?.name || "Pack"} ${inspected.version || result.report?.version || ""}`.trim(),
    exactZip ? `${exactDetail} Running validation next.` : `${cacheCount} cache entries matched. Running validation next.`,
    target
  );
  setDevLog(result.report);
  return result;
}

function showToast(title, detail = "", type = "info", options = {}) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  body.appendChild(strong);
  if (detail) {
    const span = document.createElement("span");
    span.textContent = detail;
    body.appendChild(span);
  }
  const diagnosticEnabled = type === "error" && !options.disableDiagnostics;
  if (diagnosticEnabled) {
    toast.classList.add("has-copy-action");
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toast-copy-action";
    action.textContent = options.copyLabel || "Click here to copy";
    body.appendChild(action);
    const copy = (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyErrorReportFromToast({
        title,
        detail,
        message: detail,
        context: options.context || "renderer-toast",
        packKey: options.packKey || activeSidebarPack
      });
    };
    action.addEventListener("click", copy);
  }
  toast.appendChild(body);
  els.toastStack.appendChild(toast);
  const requestedDurationMs = Number(options.durationMs);
  const desiredVisibleMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
    ? requestedDurationMs
    : type === "error" ? TOAST_MAX_VISIBLE_MS : TOAST_DEFAULT_VISIBLE_MS;
  const visibleDurationMs = Math.min(desiredVisibleMs, TOAST_MAX_VISIBLE_MS);
  const remove = () => {
    toast.classList.add("is-hiding");
    window.setTimeout(() => toast.remove(), TOAST_EXIT_DURATION_MS);
  };
  window.setTimeout(remove, visibleDurationMs);
}

function setProgress(visible, percent = 0, label = "Preparing") {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (els.progressWrap) els.progressWrap.hidden = !visible;
  if (els.progressBar) els.progressBar.style.width = `${clamped}%`;
  if (els.progressCount) els.progressCount.textContent = `${clamped}%`;
  if (els.progressLabel) els.progressLabel.textContent = label;
  setSidebarProgress(visible, clamped, label);
}

function compactSidebarProgressLabel(label = "Preparing") {
  const text = String(label || "Preparing").trim() || "Preparing";
  return text
    .replace(/\s+\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)\/.*$/i, "")
    .replace(/\s+at\s+\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)?\/s.*$/i, "")
    .trim() || text;
}

function setSidebarProgress(visible, percent = 0, label = "Preparing") {
  if (!els.sidebarProgress) return;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const fullLabel = String(label || "Preparing").trim() || "Preparing";
  els.sidebarProgress.hidden = !visible;
  els.sidebarProgress.title = fullLabel;
  els.sidebarProgress.setAttribute("aria-label", `${fullLabel} ${clamped}%`.trim());
  if (els.sidebarProgressBar) els.sidebarProgressBar.style.width = `${clamped}%`;
  if (els.sidebarProgressCount) els.sidebarProgressCount.textContent = `${clamped}%`;
  if (els.sidebarProgressLabel) els.sidebarProgressLabel.textContent = compactSidebarProgressLabel(fullLabel);
}

function setMiniProgress(bar, percent = 0) {
  if (!bar) return;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  bar.style.width = `${clamped}%`;
}

function restoreStatusBadge(status = currentStatus) {
  if (!status) return;
  const developerBypass = Boolean(status.developerClientBypass || status.developerMode);
  if (!developerBypass && status.updateBlockedReason) {
    setBadge("Update unavailable", "warn");
  } else if (!developerBypass && (status.integrity?.counts?.corrupted > 0 || status.launchBlockedReason?.startsWith("Repair required"))) {
    setBadge("Repair needed", "warn");
  } else if (status.latestError && !(developerBypass && status.installed)) {
    setBadge(isFirstPublishPending(status) ? "Not Installed" : (status.developerMode ? "Feed unavailable" : "Service unavailable"), isFirstPublishPending(status) ? "warn" : (status.developerMode ? "bad" : "warn"));
  } else if (status.updateRequired) {
    setBadge("Update required", "warn");
  } else if (status.latest || (developerBypass && status.installed)) {
    setLaunchStatusBadge(status);
  } else {
    setBadge("Setup required", "warn");
  }
}

function isTerminalUpdateState(state) {
  return Boolean(state && !state.running && (state.lastResult || state.error));
}

function isSuccessfulUpdateState(state) {
  return Boolean(state && !state.running && !state.error && state.lastResult);
}

function ensureTerminalUpdateTimestamp(state) {
  if (isTerminalUpdateState(state) && !state.completedAt && !state.clientCompletedAt) {
    state.clientCompletedAt = Date.now();
  }
  return state;
}

function terminalUpdateAgeMs(state) {
  const value = state?.completedAt ? Date.parse(state.completedAt) : state?.clientCompletedAt;
  return Number.isFinite(value) ? Math.max(0, Date.now() - value) : 0;
}

function shouldShowUpdateProgress(state) {
  if (!state) return false;
  if (state.running) return true;
  if (state.error) return terminalUpdateAgeMs(ensureTerminalUpdateTimestamp(state)) < DOWNLOAD_ERROR_VISIBLE_MS;
  return isSuccessfulUpdateState(state) && terminalUpdateAgeMs(state) < DOWNLOAD_COMPLETE_VISIBLE_MS;
}

function updateProgressPhase(state) {
  if (state?.running) return state.progress?.phase || "Installing pack";
  if (state?.error) return state.progress?.phase || "Needs attention";
  if (isSuccessfulUpdateState(state)) return "Complete";
  return state?.progress?.phase || "";
}

function isByteProgress(progress = {}) {
  return progress.unit === "bytes" || Number(progress.totalBytes || 0) > 0;
}

function byteProgressDetail(progress = {}) {
  const completed = Number(progress.completedBytes ?? progress.completed ?? 0);
  const total = Number(progress.totalBytes ?? progress.total ?? 0);
  if (!total) return "";
  const speed = progress.speedBytesPerSecond ? ` at ${formatBytes(progress.speedBytesPerSecond)}/s` : "";
  return `${formatBytes(completed)}/${formatBytes(total)}${speed}`;
}

function updateProgressDetail(progress = {}) {
  if (isByteProgress(progress)) {
    return byteProgressDetail(progress);
  }
  if (progress.total) {
    return `${progress.completed}/${progress.total}`;
  }
  return "";
}

function updateProgressLabel(state) {
  const phase = updateProgressPhase(state);
  const detail = state?.running ? updateProgressDetail(state.progress || {}) : "";
  return `${phase}${detail ? ` ${detail}` : ""}`.trim();
}

function clearCompletedUpdateState() {
  window.clearTimeout(updateCompleteHideTimer);
  updateCompleteHideTimer = null;
  if (!isSuccessfulUpdateState(lastUpdateState) || updatePoll) return;
  lastUpdateState = null;
  setProgress(false);
  renderDownloads(null);
  restoreStatusBadge();
}

function scheduleCompletedUpdateClear(delay = DOWNLOAD_COMPLETE_VISIBLE_MS) {
  window.clearTimeout(updateCompleteHideTimer);
  if (!isTerminalUpdateState(lastUpdateState) || updatePoll) return;
  const visibleMs = lastUpdateState.error ? DOWNLOAD_ERROR_VISIBLE_MS : DOWNLOAD_COMPLETE_VISIBLE_MS;
  const completedAt = lastUpdateState.completedAt || lastUpdateState.clientCompletedAt || "";
  const remaining = Math.max(0, Math.min(delay, visibleMs - terminalUpdateAgeMs(lastUpdateState)));
  if (remaining === 0) {
    if (isSuccessfulUpdateState(lastUpdateState)) clearCompletedUpdateState();
    else {
      setProgress(false);
      renderDownloads(lastUpdateState);
      restoreStatusBadge();
    }
    return;
  }
  updateCompleteHideTimer = window.setTimeout(() => {
    const sameCompletion = lastUpdateState && (lastUpdateState.completedAt || lastUpdateState.clientCompletedAt || "") === completedAt;
    if (!sameCompletion) return;
    if (isSuccessfulUpdateState(lastUpdateState)) clearCompletedUpdateState();
    else {
      setProgress(false);
      renderDownloads(lastUpdateState);
      restoreStatusBadge();
    }
  }, remaining);
}

function clearScanProgressSoon(delay = 1400) {
  window.clearTimeout(scanProgressHideTimer);
  scanProgressHideTimer = window.setTimeout(() => {
    scanProgressHideTimer = null;
    if (updatePoll || lastUpdateState?.running) return;
    setProgress(false);
  }, delay);
}

function setUnavailable(button, unavailable) {
  if (!button) return;
  button.classList.toggle("is-disabled", unavailable);
  button.setAttribute("aria-disabled", unavailable ? "true" : "false");
  button.tabIndex = unavailable ? -1 : 0;
}

function isUnavailable(button) {
  if (!button) return true;
  return button.classList.contains("is-disabled");
}

function downloadStateLabel(status, state) {
  if (state?.running) return state.progress?.phase || "Installing";
  if (state?.error) return "Needs attention";
  if (isSuccessfulUpdateState(state) && shouldShowUpdateProgress(state)) return "Complete";
  if (!status?.config?.latestUrl) return "Setup required";
  if (status?.latestError && !(status?.developerClientBypass && status?.installed)) return isFirstPublishPending(status) ? "Not installed" : (status.developerMode ? "Feed unavailable" : "Service unavailable");
  if (status?.developerClientBypass && status?.installed) return "Developer client";
  if (status?.updateRequired) return "Game update required";
  if (status?.latest) return "No update required";
  return "No downloads queued";
}

function downloadLogText(state) {
  const lines = [...(state?.lines || [])];
  if (state?.error) lines.push(`ERROR: ${state.error}`);
  if (isSuccessfulUpdateState(state) && shouldShowUpdateProgress(state) && state.lastResult?.installed?.version) {
    lines.push(`Installed ${state.lastResult.installed.version}`);
  }
  if (lines.length) return lines.join("\n");
  return "No downloads yet.";
}

function renderDownloads(state = lastUpdateState) {
  const status = currentStatus;
  const progressVisible = shouldShowUpdateProgress(state);
  const percent = progressVisible ? estimateProgress(state) : 0;
  const detail = progressVisible ? updateProgressDetail(state?.progress || {}) : "";
  const progressText = detail
    ? `${Math.round(percent)}% (${detail})`
    : `${Math.round(percent)}%`;
  els.downloadsState.textContent = downloadStateLabel(status, state);
  els.downloadsProgressText.textContent = progressText;
  if (els.downloadsRowProgress) {
    els.downloadsRowProgress.hidden = !progressVisible;
  }
  setMiniProgress(els.downloadsProgressBar, percent);
  const logText = downloadLogText(state);
  setTextContentBounded(els.downloadsLog, logText, LOG_TEXT_LIMIT);
  els.downloadsLog.hidden = logText === "No downloads yet.";
  setUnavailable(els.downloadsUpdateIconButton, !status?.latest || !status?.updateRequired || Boolean(state?.running));
}

function openDownloads() {
  renderDownloads();
  els.downloadsOverlay.hidden = false;
  els.downloadsCloseButton.focus();
}

function closeDownloads() {
  els.downloadsOverlay.hidden = true;
  els.downloadsButton.focus();
}

function launcherUpdatePercent(state) {
  if (state?.progress && Number.isFinite(state.progress.percent)) return state.progress.percent;
  if (state?.lastResult) return 100;
  if (state?.error) return 100;
  return state?.running ? 25 : 0;
}

function setLauncherUpdateButton(restartReady = false, instantRestartReady = false) {
  if (!els.launcherUpdateNowButton) return;
  const icon = document.createElement("span");
  icon.className = `button-icon ${restartReady ? "icon-sync" : "icon-download"}`;
  icon.setAttribute("aria-hidden", "true");
  const label = restartReady
    ? instantRestartReady ? "Restart Launcher" : "Install and Restart"
    : "Update Launcher";
  els.launcherUpdateNowButton.replaceChildren(icon, document.createTextNode(label));
}

function renderLauncherUpdateOverlay(status = currentStatus, state = lastLauncherUpdateState) {
  if (!els.launcherUpdateOverlay) return;
  const update = status?.launcherUpdate || {};
  const developerReinstall = Boolean(
    update.developerReinstall
    || state?.purpose === "developer-reinstall"
    || state?.developerReinstall
    || state?.lastResult?.purpose === "developer-reinstall"
    || state?.lastResult?.developerReinstall
  );
  const required = Boolean(update.updateRequired || developerReinstall);
  els.launcherUpdateOverlay.hidden = !required;
  if (!required) return;
  const restartReady = Boolean(state?.lastResult?.restartRequired && !state?.error);
  const instantRestartReady = Boolean(restartReady && state?.lastResult?.instantRestartReady);
  const current = update.currentVersion || status?.appVersion || "-";
  const latest = update.latestVersion || "-";
  els.launcherUpdateTitle.textContent = restartReady
    ? instantRestartReady ? developerReinstall ? "Reinstall finished" : "Update finished" : "Ready to Install"
    : developerReinstall ? "Preparing launcher reinstall" : "Launcher update required";
  els.launcherUpdateSummary.textContent = restartReady
    ? instantRestartReady
      ? developerReinstall
        ? `AHT Launcher ${latest} is fully copied, extracted, and verified for a same-version reinstall. Click Restart Launcher to swap to the prepared copy immediately.`
        : `AHT Launcher ${latest} is fully downloaded, extracted, and verified. Click Restart Launcher to close this version and open the prepared update immediately.`
      : `AHT Launcher ${latest} uses the legacy installer. Click Install and Restart to apply it and reopen when finished.`
    : developerReinstall
      ? `AHT Launcher ${latest} is preparing a developer-only same-version reinstall. Installed launcher version: ${current}.`
      : `AHT Launcher ${latest} is required. Installed launcher version: ${current}.`;
  const percent = launcherUpdatePercent(state);
  const phase = state?.progress?.phase || (state?.error ? "Update failed" : restartReady ? instantRestartReady ? "Update finished - ready to restart" : "Ready to install" : state?.lastResult ? "Update ready" : "Preparing");
  els.launcherUpdateProgressLabel.textContent = phase;
  els.launcherUpdateProgressCount.textContent = `${Math.round(percent)}%`;
  setMiniProgress(els.launcherUpdateProgressBar, percent);
  const lines = [...(state?.lines || [])];
  if (state?.error) lines.push(`ERROR: ${state.error}`);
  if (!lines.length) lines.push("Waiting to start launcher update.");
  setTextContentBounded(els.launcherUpdateLog, lines.join("\n"), LOG_TEXT_LIMIT);
  setLauncherUpdateButton(restartReady, instantRestartReady);
  setUnavailable(els.launcherUpdateNowButton, Boolean(state?.running));
  if (developerReinstall && developerAuthenticated && !state && !launcherUpdatePoll) {
    launcherUpdatePoll = setInterval(pollLauncherUpdate, 800);
    window.setTimeout(() => pollLauncherUpdate(), 0);
  }
  if (!developerReinstall && !launcherUpdateAutoStarted && !state?.running && !state?.lastResult) {
    launcherUpdateAutoStarted = true;
    window.setTimeout(() => startLauncherSelfUpdate(), 500);
  }
}

async function pollLauncherUpdate() {
  let state;
  try {
    state = await window.aht.getLauncherUpdateState();
  } catch (error) {
    state = { running: false, error: cleanErrorMessage(error), lines: [], progress: { phase: "Update failed", percent: 100 } };
  }
  lastLauncherUpdateState = state;
  renderLauncherUpdateOverlay(currentStatus, state);
  if (!state.running) {
    clearInterval(launcherUpdatePoll);
    launcherUpdatePoll = null;
  }
}

async function startLauncherSelfUpdate() {
  if (lastLauncherUpdateState?.lastResult?.restartRequired) {
    await restartLauncherSelfUpdate();
    return;
  }
  if (launcherUpdatePoll || lastLauncherUpdateState?.running) return;
  lastLauncherUpdateState = {
    running: true,
    lines: ["Starting launcher update."],
    progress: { phase: "Preparing launcher update", percent: 8 },
    error: null,
    lastResult: null
  };
  renderLauncherUpdateOverlay(currentStatus, lastLauncherUpdateState);
  window.aht.startLauncherUpdate()
    .then(async () => {
      const state = await window.aht.getLauncherUpdateState().catch(() => lastLauncherUpdateState);
      lastLauncherUpdateState = state;
      renderLauncherUpdateOverlay(currentStatus, state);
      if (launcherUpdatePoll) {
        clearInterval(launcherUpdatePoll);
        launcherUpdatePoll = null;
      }
    })
    .catch((error) => {
      lastLauncherUpdateState = {
        running: false,
        lines: [],
        error: cleanErrorMessage(error),
        progress: { phase: "Update failed", percent: 100 },
        lastResult: null
      };
      renderLauncherUpdateOverlay(currentStatus, lastLauncherUpdateState);
      if (launcherUpdatePoll) {
        clearInterval(launcherUpdatePoll);
        launcherUpdatePoll = null;
      }
    });
  launcherUpdatePoll = setInterval(pollLauncherUpdate, 800);
  await pollLauncherUpdate();
}

async function restartLauncherSelfUpdate() {
  if (lastLauncherUpdateState?.running) return;
  if (!lastLauncherUpdateState?.lastResult?.restartRequired) return;
  if (launcherUpdatePoll) {
    clearInterval(launcherUpdatePoll);
    launcherUpdatePoll = null;
  }
  lastLauncherUpdateState = {
    ...lastLauncherUpdateState,
    running: true,
    lines: [...(lastLauncherUpdateState.lines || []), "Installing launcher update."],
    progress: { phase: lastLauncherUpdateState?.lastResult?.instantRestartReady ? "Restarting launcher" : "Starting install helper", percent: 100 },
    error: null
  };
  renderLauncherUpdateOverlay(currentStatus, lastLauncherUpdateState);
  window.aht.restartLauncherUpdate()
    .then(async () => {
      const state = await window.aht.getLauncherUpdateState().catch(() => lastLauncherUpdateState);
      lastLauncherUpdateState = state;
      renderLauncherUpdateOverlay(currentStatus, state);
      if (launcherUpdatePoll) {
        clearInterval(launcherUpdatePoll);
        launcherUpdatePoll = null;
      }
    })
    .catch((error) => {
      lastLauncherUpdateState = {
        ...lastLauncherUpdateState,
        running: false,
        error: cleanErrorMessage(error),
        progress: { phase: "Restart failed", percent: 100 }
      };
      renderLauncherUpdateOverlay(currentStatus, lastLauncherUpdateState);
      if (launcherUpdatePoll) {
        clearInterval(launcherUpdatePoll);
        launcherUpdatePoll = null;
      }
    });
  launcherUpdatePoll = setInterval(pollLauncherUpdate, 500);
  await pollLauncherUpdate();
}

function estimateProgress(state) {
  if (state.progress && Number.isFinite(state.progress.percent)) return state.progress.percent;
  if (!state.running && state.lastResult) return 100;
  if (!state.running && state.error) return 100;
  const lines = state.lines || [];
  const downloadLines = lines.filter((line) => line.startsWith("Downloading ")).length;
  const okLines = lines.filter((line) => line.startsWith("OK ")).length;
  const completed = downloadLines + okLines;
  if (completed === 0) return state.running ? 8 : 0;
  return Math.min(96, 10 + completed);
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}...${value.slice(-4)}` : "-";
}

function shortDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setPlayBusy(busy) {
  playBusy = Boolean(busy);
  if (!els.playButton) return;
  els.playButton.setAttribute("aria-busy", playBusy ? "true" : "false");
  els.playButton.innerHTML = `<span class="button-icon icon-play" aria-hidden="true"></span>${playBusy ? "Preparing..." : "Play"}`;
  if (playBusy) {
    setUnavailable(els.playButton, true);
    els.playButton.title = "Preparing the exact Minecraft Launcher profile";
  }
}

function normalizePlayerPlatform(value = "") {
  const platform = String(value || "").trim().toLowerCase();
  if (platform.includes("win")) return "Windows";
  if (platform.includes("mac") || platform.includes("darwin") || platform.includes("osx")) return "Mac";
  return "—";
}

function displayMinecraftUuid(value = "") {
  const compact = String(value || "").trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return "—";
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function playerDataRecord(item = {}) {
  const networkStatus = String(item.network?.status || "unknown").trim().toLowerCase();
  const networkLabel = networkStatus === "likely"
    ? "Likely VPN"
    : (networkStatus === "not_detected" ? "No VPN signal" : "Unknown");
  const networkDetail = [
    item.network?.asn ? `AS${item.network.asn}` : "",
    String(item.network?.organization || "").trim()
  ].filter(Boolean).join(" ");
  return {
    receivedAt: String(item.receivedAt || item.createdAt || item.updatedAt || ""),
    username: String(item.minecraftUsername || item.username || "").trim() || "—",
    ip: String(item.ip || item.ipv4 || "").trim() || "—",
    minecraftUuid: displayMinecraftUuid(item.minecraftUuid),
    platform: normalizePlayerPlatform(item.platform || item.platformLabel || item.platformKey),
    launcherVersion: String(item.launcherVersion || item.appVersion || "").trim() || "—",
    fileName: String(item.fileName || "").trim() || "—",
    deviceId: String(item.deviceId || "").trim(),
    networkLabel,
    networkDetail,
    networkStatus,
    accessAllowed: item.access?.allowed !== false,
    activeScopes: Array.isArray(item.access?.activeScopes) ? item.access.activeScopes : []
  };
}

function shortDeviceId(value = "") {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > 20 ? `${text.slice(0, 11)}…${text.slice(-7)}` : text;
}

function appendPlayerDataCell(row, value, title = "", className = "") {
  const cell = document.createElement("span");
  cell.textContent = value;
  if (title) cell.title = title;
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

function openAccessDecisionDialog(record) {
  if (!record || !els.accessDecisionDialog) return;
  selectedAccessPlayer = record;
  els.accessDecisionTitle.textContent = `Manage ${record.username}`;
  els.accessDecisionIdentity.textContent = [
    record.minecraftUuid !== "—" ? `UUID ${record.minecraftUuid}` : "No verified UUID",
    record.deviceId ? `device ${shortDeviceId(record.deviceId)}` : "no device credential",
    record.ip !== "—" ? `IP ${record.ip}` : "no connection IP",
    record.networkLabel
  ].join(" · ");
  els.accessDecisionAction.value = record.accessAllowed ? "deny" : "allow";
  els.accessDecisionScope.value = record.activeScopes[0] || "account";
  els.accessDecisionReason.value = "";
  els.accessDecisionStatus.textContent = "";
  els.accessDecisionDialog.showModal();
}

function accessDecisionValue(record, scope) {
  if (scope === "account") return record.username === "—" ? "" : record.username;
  if (scope === "minecraft_uuid") return record.minecraftUuid === "—" ? "" : record.minecraftUuid;
  if (scope === "device") return record.deviceId;
  if (scope === "ip") return record.ip === "—" ? "" : record.ip;
  return "";
}

function renderPlayerRows(list, records = []) {
  if (!list) return;
  list.innerHTML = "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No players found.";
    list.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "event";
    appendPlayerDataCell(row, shortDateTime(record.receivedAt));
    appendPlayerDataCell(row, record.username);
    appendPlayerDataCell(row, record.ip);
    appendPlayerDataCell(row, record.networkLabel, record.networkDetail);
    appendPlayerDataCell(row, shortDeviceId(record.deviceId), record.deviceId);
    appendPlayerDataCell(row, record.minecraftUuid, record.minecraftUuid);
    appendPlayerDataCell(
      row,
      record.accessAllowed ? "Allowed" : `Restricted (${record.activeScopes.join(", ") || "policy"})`,
      "",
      record.accessAllowed ? "player-access-allowed" : "player-access-denied"
    );
    const actionCell = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-access-button";
    button.textContent = "Manage";
    button.addEventListener("click", () => openAccessDecisionDialog(record));
    actionCell.appendChild(button);
    row.appendChild(actionCell);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}

function accessDecisionRecord(item = {}) {
  const decision = item?.decision && typeof item.decision === "object" ? item.decision : item;
  return {
    updatedAt: String(item.receivedAt || decision.updatedAt || decision.createdAt || ""),
    scope: String(decision.scope || "").trim() || "—",
    value: String(decision.value || "").trim() || "—",
    active: decision.active === true && decision.effect === "deny",
    reason: String(decision.reason || "").trim() || "—",
    actor: String(item.actor || decision.actor || "").trim() || "—"
  };
}

function renderAccessDecisionRows(list, records = []) {
  if (!list) return;
  list.innerHTML = "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No access decisions found.";
    list.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "event";
    appendPlayerDataCell(row, shortDateTime(record.updatedAt));
    appendPlayerDataCell(row, record.scope.replaceAll("_", " "));
    appendPlayerDataCell(row, record.value, record.value);
    appendPlayerDataCell(row, record.active ? "Restricted" : "Restored", "", record.active ? "player-access-denied" : "player-access-allowed");
    appendPlayerDataCell(row, record.reason, record.reason);
    appendPlayerDataCell(row, record.actor);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}

function renderPlayerDataRows(list, records = [], kind = "players", emptyText = "No records found.") {
  if (kind === "players") {
    renderPlayerRows(list, records);
    return;
  }
  if (!list) return;
  list.innerHTML = "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "event";
    const values = [shortDateTime(record.receivedAt), record.username, record.ip, record.minecraftUuid, record.platform];
    if (kind === "updates") values.push(record.launcherVersion);
    for (const value of values) {
      const cell = document.createElement("span");
      cell.textContent = value;
      row.appendChild(cell);
    }
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}

function playerDataFailureSummary(results = []) {
  const labels = ["Downloads", "Players", "Launcher updates", "Access control"];
  return results
    .map((result, index) => {
      if (result.status !== "rejected") return "";
      const message = cleanErrorMessage(result.reason).replace(/\s+/g, " ").trim();
      return `${labels[index]}: ${(message || "unavailable").slice(0, 160)}`;
    })
    .filter(Boolean)
    .join("; ");
}

function activatePlayerDataView(view = "downloads") {
  activePlayerDataView = ["downloads", "players", "updates", "access"].includes(view) ? view : "downloads";
  els.playerDataTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.playerDataView === activePlayerDataView));
  if (els.playerDownloadsPanel) els.playerDownloadsPanel.hidden = activePlayerDataView !== "downloads";
  if (els.playerRecordsPanel) els.playerRecordsPanel.hidden = activePlayerDataView !== "players";
  if (els.playerLauncherUpdatesPanel) els.playerLauncherUpdatesPanel.hidden = activePlayerDataView !== "updates";
  if (els.playerAccessPanel) els.playerAccessPanel.hidden = activePlayerDataView !== "access";
}

async function loadAllPlayerDataPages(fetchPage, property) {
  const records = [];
  const seenCursors = new Set();
  let cursor = "";
  do {
    const page = await fetchPage({ limit: 250, cursor });
    if (Array.isArray(page?.[property])) records.push(...page[property]);
    const nextCursor = page?.hasMore ? String(page.cursor || "") : "";
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error("Player data pagination returned a repeated cursor.");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  } while (true);
  return records;
}

async function loadPlayerDownloadHistory() {
  if (playerDataLoading) return;
  playerDataLoading = true;
  setUnavailable(els.loadDashboardButton, true);
  const originalMarkup = els.loadDashboardButton.innerHTML;
  try {
    els.loadDashboardButton.textContent = "Loading";
    const [downloadsResult, playersResult, updatesResult, accessResult] = await Promise.allSettled([
      loadAllPlayerDataPages((payload) => window.aht.devLauncherDownloads(payload), "downloads"),
      loadAllPlayerDataPages((payload) => window.aht.devPlayerRecords(payload), "players"),
      loadAllPlayerDataPages((payload) => window.aht.devLauncherUpdates(payload), "updates"),
      window.aht.devAccessDecisions({ active: false, history: true })
    ]);
    const historyResults = [downloadsResult, playersResult, updatesResult, accessResult];
    const failureSummary = playerDataFailureSummary(historyResults);
    if (historyResults.every((result) => result.status === "rejected")) throw new Error(failureSummary);
    playerDownloadRecords = (downloadsResult.status === "fulfilled" ? downloadsResult.value : [])
      .map(playerDataRecord)
      .sort((left, right) => String(right.receivedAt || "").localeCompare(String(left.receivedAt || "")));
    canonicalPlayerRecords = (playersResult.status === "fulfilled" ? playersResult.value : [])
      .map(playerDataRecord)
      .sort((left, right) => String(right.receivedAt || "").localeCompare(String(left.receivedAt || "")));
    launcherUpdateRecords = (updatesResult.status === "fulfilled" ? updatesResult.value : [])
      .map(playerDataRecord)
      .sort((left, right) => String(right.receivedAt || "").localeCompare(String(left.receivedAt || "")));
    const accessItems = accessResult.status === "fulfilled" && Array.isArray(accessResult.value?.audit)
      ? accessResult.value.audit
      : (accessResult.status === "fulfilled" && Array.isArray(accessResult.value?.decisions) ? accessResult.value.decisions : []);
    accessDecisionRecords = accessItems
      .map(accessDecisionRecord)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    renderPlayerDataRows(els.playerDownloadsList, playerDownloadRecords, "downloads", "No installer downloads found.");
    renderPlayerDataRows(els.playerRecordsList, canonicalPlayerRecords, "players", "No players found.");
    renderPlayerDataRows(els.playerLauncherUpdatesList, launcherUpdateRecords, "updates", "No launcher updates found.");
    renderAccessDecisionRows(els.playerAccessList, accessDecisionRecords);
    playerDataLoaded = true;
    activatePlayerDataView(activePlayerDataView);
    if (historyResults.some((result) => result.status === "rejected")) {
      setDevLog(failureSummary);
      showToast("Player data partially loaded", failureSummary, "warn");
    } else {
      showToast("Player data loaded", `${playerDownloadRecords.length} downloads, ${canonicalPlayerRecords.length} players, ${launcherUpdateRecords.length} launcher updates, ${accessDecisionRecords.length} access decisions.`, "success");
    }
  } catch (error) {
    const message = cleanErrorMessage(error);
    setDevLog(message);
    showToast("Player data failed", message, "error");
  } finally {
    playerDataLoading = false;
    els.loadDashboardButton.innerHTML = originalMarkup;
    setUnavailable(els.loadDashboardButton, false);
  }
}

async function submitAccessDecision(event) {
  event?.preventDefault?.();
  if (!selectedAccessPlayer || !els.accessDecisionDialog) return;
  const action = els.accessDecisionAction.value;
  const scope = els.accessDecisionScope.value;
  const value = accessDecisionValue(selectedAccessPlayer, scope);
  const reason = els.accessDecisionReason.value.trim();
  if (!value) {
    els.accessDecisionStatus.textContent = `This player does not have a ${scope.replaceAll("_", " ")} value to control.`;
    return;
  }
  if (action === "deny" && reason.length < 3) {
    els.accessDecisionStatus.textContent = "Enter an audit reason of at least 3 characters.";
    return;
  }
  setUnavailable(els.accessDecisionSubmit, true);
  els.accessDecisionStatus.textContent = action === "deny" ? "Applying restriction…" : "Restoring access…";
  try {
    await window.aht.devSetAccessDecision({ action, scope, value, reason });
    els.accessDecisionDialog.close();
    selectedAccessPlayer = null;
    playerDataLoaded = false;
    await loadPlayerDownloadHistory();
    activatePlayerDataView(action === "deny" ? "players" : "access");
    showToast(action === "deny" ? "Access restricted" : "Access restored", `${scope.replaceAll("_", " ")} decision applied.`, "success");
  } catch (error) {
    const message = cleanErrorMessage(error);
    els.accessDecisionStatus.textContent = message;
    showToast("Access decision failed", message, "error");
  } finally {
    setUnavailable(els.accessDecisionSubmit, false);
  }
}

function renderDeveloperUpdateLogs(logs = []) {
  const items = Array.isArray(logs) ? logs : [];
  els.developerUpdateLogsList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No update logs have been pushed yet.";
    els.developerUpdateLogsList.appendChild(empty);
    return;
  }
  for (const log of items) {
    const item = document.createElement("div");
    item.className = "developer-update-log-item";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "developer-update-log-main";
    main.addEventListener("click", () => openUpdateLog(log));
    const meta = document.createElement("span");
    const title = document.createElement("strong");
    const body = document.createElement("p");
    meta.textContent = `${updateLogMeta(log)} | ${shortDateTime(log.publishedAt)}`;
    title.textContent = log.title || "Untitled update";
    body.textContent = updateLogSummary(log.text || log.body || "");
    main.append(meta, title, body);

    const footer = document.createElement("div");
    footer.className = "developer-update-log-footer";
    const badges = document.createElement("div");
    badges.className = "update-log-badges";
    const addBadge = (label) => {
      const badge = document.createElement("span");
      badge.textContent = label;
      badges.appendChild(badge);
    };
    if (updateLogImageUrl(log)) addBadge("Banner");
    const mediaLabel = updateLogMediaLabel(log);
    if (mediaLabel) addBadge(mediaLabel);
    if (!badges.childElementCount) addBadge("Text only");

    const actions = document.createElement("div");
    actions.className = "developer-update-log-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "button compact";
    preview.textContent = "Preview";
    preview.addEventListener("click", () => openUpdateLog(log));
    actions.appendChild(preview);
    if (updateLogPlayable(log)) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "button compact";
      play.textContent = "Play";
      play.addEventListener("click", () => openUpdateLogVideo(log));
      actions.appendChild(play);
    }
    footer.append(badges, actions);
    item.append(main, footer);
    els.developerUpdateLogsList.appendChild(item);
  }
}

async function loadDeveloperUpdateLogs() {
  setUnavailable(els.loadUpdateLogsButton, true);
  setUpdateLogStatus("warn", "Loading logs", "Reading Worker data", "Fetching update logs from the configured Worker.");
  try {
    const result = await window.aht.devUpdateLogs(20);
    renderDeveloperUpdateLogs(result.logs || []);
    setUpdateLogStatus("ok", "Logs loaded", `${result.logs?.length || 0} logs`, "Latest pushed logs are listed below.");
    return result;
  } catch (error) {
    const message = cleanErrorMessage(error);
    setUpdateLogStatus("bad", "Load failed", "Could not load update logs", message);
    showToast("Update logs failed", message, "error");
    return null;
  } finally {
    setUnavailable(els.loadUpdateLogsButton, false);
  }
}

function updateLogInputReference(value, localKey, urlKey) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  return isRemoteUrl(raw) ? { [urlKey]: raw } : { [localKey]: raw };
}

async function publishDeveloperUpdateLog() {
  const videoInput = els.updateLogVideoInput.value.trim();
  const youtubeInput = els.updateLogYoutubeInput.value.trim();
  if (videoInput && youtubeInput) {
    setUpdateLogStatus("bad", "Choose one video", "Video file or YouTube link", "Use either a video file/public video URL or a YouTube link, not both.");
    return;
  }
  if (youtubeInput && !youtubeEmbedUrl(youtubeInput)) {
    setUpdateLogStatus("bad", "Invalid YouTube link", "Use a normal YouTube video, Shorts, or youtu.be link", "The launcher only shows a play button for valid YouTube video links.");
    return;
  }
  const payload = {
    version: els.updateLogVersionInput.value.trim(),
    title: els.updateLogTitleInput.value.trim(),
    subtitle: els.updateLogSubtitleInput.value.trim(),
    text: els.updateLogBodyInput.value.trim(),
    ...updateLogInputReference(els.updateLogImageInput.value, "imageLocalPath", "imageUrl"),
    ...updateLogInputReference(videoInput, "videoLocalPath", "videoUrl"),
    youtubeUrl: youtubeInput
  };
  if (!payload.title || !payload.text) {
    setUpdateLogStatus("bad", "Log incomplete", "Title and text required", "Add a title and update-log text before pushing.");
    return;
  }
  setUnavailable(els.publishUpdateLogButton, true);
  setUpdateLogStatus("warn", "Publishing log", payload.title, (payload.videoLocalPath || payload.imageLocalPath) ? "Uploading media to R2, then pushing the update log to the Worker." : "Pushing update log metadata to the Worker.");
  try {
    const result = await window.aht.devPublishUpdateLog(payload);
    els.updateLogTitleInput.value = "";
    els.updateLogSubtitleInput.value = "";
    els.updateLogImageInput.value = "";
    els.updateLogVideoInput.value = "";
    els.updateLogYoutubeInput.value = "";
    els.updateLogBodyInput.value = "";
    setUpdateLogStatus("ok", "Log pushed", result.log?.title || payload.title, "Players will see it on the launcher home screen.");
    await loadDeveloperUpdateLogs();
    showToast("Update log pushed", result.log?.title || payload.title, "success");
  } catch (error) {
    const message = cleanErrorMessage(error);
    setUpdateLogStatus("bad", "Publish failed", "Update log was not pushed", message);
    showToast("Update log failed", message, "error");
  } finally {
    setUnavailable(els.publishUpdateLogButton, false);
  }
}

async function scanLauncherBuilds() {
  setUnavailable(els.scanLauncherBuildsButton, true);
  setLauncherUpdateStatus("warn", "Checking GitHub", "Looking at workflow", "Checking the configured GitHub Actions release workflow.");
  try {
    await saveDeveloperSecrets();
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    const result = await window.aht.devCheckLauncherWorkflow({
      githubRepo: inputValue(els.githubRepoInput, "svre-mc/aht-launcher"),
      githubBranch: inputValue(els.githubBranchInput, "main"),
      githubWorkflow: inputValue(els.githubWorkflowInput, "build-macos.yml"),
      githubToken: inputValue(els.githubTokenInput, "")
    });
    const run = result.latestRun;
    const packageVersion = result.packageVersion || result.version || "";
    const title = packageVersion ? `GitHub package ${packageVersion}` : run ? `Latest run ${run.status || "unknown"}` : "Workflow found";
    const detail = run?.htmlUrl
      ? `Branch ${result.ref || "main"} uses ${result.workflow}. Latest run: ${run.htmlUrl}`
      : `Branch ${result.ref || "main"} uses ${result.workflow}. Actions page: ${result.actionsUrl}`;
    setLauncherUpdateStatus("ok", "GitHub ready", title, detail);
    setDevLog(result);
  } catch (error) {
    const message = cleanErrorMessage(error);
    setLauncherUpdateStatus("bad", "GitHub check failed", "Could not read workflow", message);
    setDevLog(message);
  } finally {
    setUnavailable(els.scanLauncherBuildsButton, false);
  }
}

async function prepareLocalLauncherReinstall() {
  if (!els.testLauncherReinstallButton || isUnavailable(els.testLauncherReinstallButton)) return;
  setUnavailable(els.testLauncherReinstallButton, true);
  setLauncherReinstallStatus(
    "warn",
    "Opening regular launcher",
    "Preparing a one-time local update test",
    "The exact current-version Windows ZIP is copied and hash-bound before the installed regular AHT Launcher opens."
  );
  try {
    const result = await window.aht.devPrepareLauncherReinstall();
    setLauncherReinstallStatus(
      "ok",
      "Regular launcher opened",
      `AHT Launcher ${result.version} update prompt is ready`,
      "Continue in the regular launcher. It will run the normal copy, verification, staging, Restart Launcher, swap, relaunch, and acknowledgement flow; Developer Mode will close."
    );
    setDevLog(result);
    showToast("Regular launcher ready", `Continue the local update test in AHT Launcher ${result.version}.`, "success");
  } catch (error) {
    const message = cleanErrorMessage(error);
    setLauncherReinstallStatus("bad", "Local update test failed", "Regular launcher was not opened", message);
    setDevLog(message);
    showToast("Local update test failed", message, "error");
  } finally {
    setUnavailable(els.testLauncherReinstallButton, false);
  }
}

function renderLauncherDeployState(state) {
  if (!state) return;
  setLauncherDeployProgress(state.progress, false);
  if (Array.isArray(state.lines) && state.lines.length) setDevLog(state.lines.join("\n"));
  if (state.running) {
    setLauncherUpdateStatus("warn", "Deploying public launcher", state.progress?.phase || "GitHub Actions running", "Windows and macOS player builds are publishing to GitHub Releases and R2. The developer launcher is never uploaded.");
    return;
  }
  if (state.error) {
    setLauncherUpdateStatus("bad", "Deploy failed", "Public launcher was not fully published", state.error);
    return;
  }
  if (state.lastResult) {
    const result = state.lastResult;
    setLauncherUpdateStatus("ok", "Published and verified", `AHT Launcher ${result.version}`, `GitHub Release and ${result.latestUrl} are live. Developer artifacts uploaded: no.`);
    setDevLog(result);
  }
}

async function pollLauncherDeploy() {
  const state = await window.aht.devLauncherDeployState();
  renderLauncherDeployState(state);
  if (!state.running) {
    if (launcherDeployPoll) clearInterval(launcherDeployPoll);
    launcherDeployPoll = null;
    setUnavailable(els.publishLauncherUpdateButton, false);
    if (state.error) showToast("Launcher deploy failed", state.error, "error");
    else if (state.lastResult) showToast("Launcher published", `AHT Launcher ${state.lastResult.version} is live.`, "success");
  }
  return state;
}

async function publishLauncherUpdate() {
  if (isUnavailable(els.publishLauncherUpdateButton) || launcherDeployPoll) return;
  setUnavailable(els.publishLauncherUpdateButton, true);
  try {
    await saveDeveloperSecrets();
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    const payload = {
      githubToken: inputValue(els.githubTokenInput, ""),
      publishToR2: true
    };
    setLauncherUpdateStatus("warn", "Preparing deploy", "Reading latest GitHub launcher version", "Only public Windows and macOS player-launcher artifacts will be released.");
    setLauncherDeployProgress({ phase: "Preparing public deploy", percent: 0 });
    const state = await window.aht.devDeployLauncher(payload);
    renderLauncherDeployState(state);
    launcherDeployPoll = setInterval(() => {
      pollLauncherDeploy().catch((error) => {
        if (launcherDeployPoll) clearInterval(launcherDeployPoll);
        launcherDeployPoll = null;
        setUnavailable(els.publishLauncherUpdateButton, false);
        showToast("Launcher deploy status failed", cleanErrorMessage(error), "error");
      });
    }, 2_000);
    await pollLauncherDeploy();
  } catch (error) {
    const message = cleanErrorMessage(error);
    setLauncherUpdateStatus("bad", "Deploy failed", "Launcher deploy did not start", message);
    setDevLog(message);
    setLauncherDeployProgress({ phase: "Deploy failed", percent: 100 });
    setUnavailable(els.publishLauncherUpdateButton, false);
    showToast("Launcher deploy failed", message, "error");
  }
}

function serverTransferPayload() {
  return {
    sourceDir: inputValue(els.serverSourceInput, ""),
    host: inputValue(els.serverHostInput, ""),
    port: Number(inputValue(els.serverPortInput, 22)),
    username: inputValue(els.serverUsernameInput, ""),
    password: inputValue(els.serverPasswordInput, ""),
    remoteDir: inputValue(els.serverRemoteDirInput, ""),
    excludeDirs: ["DregoraRL"],
    includeDirs: ["mods", "scripts", "config", "ForgeEssentials"],
    includeRootFiles: true
  };
}

function serverTransferSettingsPayload() {
  const { password: _password, ...settings } = serverTransferPayload();
  return settings;
}

async function saveServerTransferSettings() {
  const saved = await window.aht.devSaveServerTransfer(serverTransferSettingsPayload());
  if (currentStatus?.config) {
    currentStatus.config.serverTransfer = { ...(currentStatus.config.serverTransfer || {}), ...saved };
  }
  return saved;
}

async function planServerTransfer() {
  setUnavailable(els.planServerTransferButton, true);
  setServerTransferStatus("warn", "Planning", "Scanning local server folder", "Root files plus mods, scripts, config, and ForgeEssentials will be included.");
  try {
    await saveDeveloperSecrets();
    const result = await window.aht.devPlanServerTransfer(serverTransferPayload());
    const excluded = result.excludedDirs?.length ? ` Excluded: ${result.excludedDirs.join(", ")}.` : "";
    setServerTransferStatus("ok", "Plan ready", `${result.fileCount || 0} files`, `${Math.round((result.totalBytes || 0) / 1024 / 1024)} MB will upload to ${result.remoteDir || "the remote server folder"}. Scope: root files, mods, scripts, config, ForgeEssentials.${excluded}`);
    setTextContentBounded(els.serverTransferLog, stringifyLogValue(result, DEV_LOG_TEXT_LIMIT), DEV_LOG_TEXT_LIMIT);
    return result;
  } catch (error) {
    const message = cleanErrorMessage(error);
    setServerTransferStatus("bad", "Plan failed", "Could not scan server folder", message);
    setTextContentBounded(els.serverTransferLog, message, LOG_TEXT_LIMIT);
    throw error;
  } finally {
    setUnavailable(els.planServerTransferButton, false);
  }
}

function renderServerTransferState(state = lastServerTransferState) {
  if (!state) return;
  const progress = state.progress || {};
  const percent = Number.isFinite(progress.percent) ? progress.percent : state.lastResult ? 100 : state.running ? 5 : 0;
  const label = state.error ? "Upload failed" : state.running ? "Uploading" : state.lastResult ? "Upload complete" : "Ready";
  const title = state.lastResult
    ? `${state.lastResult.uploaded} uploaded, ${state.lastResult.skipped || 0} skipped`
    : progress.currentPath || progress.phase || "Server upload";
  const byteDetail = progress.totalBytes
    ? ` ${formatBytes(progress.completedBytes || 0)}/${formatBytes(progress.totalBytes)}.`
    : "";
  const progressForBar = progress.totalBytes
    ? {
      ...progress,
      completed: progress.completedBytes || 0,
      total: progress.totalBytes,
      unit: "bytes",
      currentFile: progress.currentPath || progress.currentFile || "",
      percent
    }
    : { ...progress, percent };
  const shouldShowProgress = state.running || state.lastResult || state.error || Number(progress.percent || 0) > 0;
  setServerTransferProgress(progressForBar, !shouldShowProgress);
  const detail = state.error || `Progress ${Math.round(percent)}%.${byteDetail} Scope: root files, mods, scripts, config, ForgeEssentials.`;
  setServerTransferStatus(state.error ? "bad" : state.running ? "warn" : state.lastResult ? "ok" : "warn", label, title, detail);
  const lines = [...(state.lines || [])];
  if (state.error) lines.push(`ERROR: ${state.error}`);
  setTextContentBounded(els.serverTransferLog, lines.join("\n") || "No server upload has run yet.", DEV_LOG_TEXT_LIMIT);
}

async function pollServerTransfer() {
  const state = await window.aht.devServerTransferState();
  lastServerTransferState = state;
  renderServerTransferState(state);
  if (!state.running) {
    clearInterval(serverTransferPoll);
    serverTransferPoll = null;
    setUnavailable(els.uploadServerFilesButton, false);
    setUnavailable(els.planServerTransferButton, false);
  }
}

async function uploadServerFiles() {
  if (serverTransferPoll || lastServerTransferState?.running) return;
  setUnavailable(els.uploadServerFilesButton, true);
  setUnavailable(els.planServerTransferButton, true);
  try {
    await saveDeveloperSecrets();
    setServerTransferStatus("warn", "Starting upload", "Connecting to server", "This is local SFTP only. No Cloudflare is used.");
    setServerTransferProgress({ phase: "Connecting", percent: 0 });
    setTextContentBounded(els.serverTransferLog, "Starting server file upload...\nScope: root files, mods, scripts, config, ForgeEssentials.\nDregoraRL is excluded.", LOG_TEXT_LIMIT);
    window.aht.devSyncServerFiles(serverTransferPayload()).catch((error) => {
      lastServerTransferState = {
        running: false,
        lines: [],
        error: cleanErrorMessage(error),
        progress: { phase: "Upload failed", percent: 100 },
        lastResult: null
      };
      renderServerTransferState(lastServerTransferState);
      setUnavailable(els.uploadServerFilesButton, false);
      setUnavailable(els.planServerTransferButton, false);
    });
    serverTransferPoll = setInterval(pollServerTransfer, 1000);
    await pollServerTransfer();
  } catch (error) {
    setUnavailable(els.uploadServerFilesButton, false);
    setUnavailable(els.planServerTransferButton, false);
    throw error;
  }
}

function activateDeveloperSection(targetId) {
  els.devTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.devTarget === targetId));
  els.devPanels.forEach((panel) => {
    panel.hidden = panel.id !== targetId;
  });
  if (targetId === "playerDataTools" && developerAuthenticated && !playerDataLoaded) {
    void loadPlayerDownloadHistory();
  }
}

function serializeSettings() {
  const existingDeveloper = currentStatus?.config?.developer || {};
  const existingSync = currentStatus?.config?.sync || {};
  const existingCurseForge = currentStatus?.config?.curseforge || {};
  const username = currentStatus?.identity?.minecraftUsername || els.playerLabelInput.value.trim();
  const feedUrl = playerFeedUrl();
  const workerBase = workerBaseFromFeedUrl(feedUrl);
  const proxyBase = workerUrlFromFeedUrl(feedUrl, "cf/");
  const next = {
    latestUrl: feedUrl || els.latestUrlInput.value.trim(),
    instanceDir: els.instanceInput.value.trim(),
    curseforge: {
      proxyBaseUrl: cacheOnlyMode() ? "" : (els.proxyUrlInput.value.trim() || proxyBase || existingCurseForge.proxyBaseUrl || "")
    },
    sync: {
      enabled: els.syncEnabledInput.checked,
      sendLocalChanges: els.sendChangesInput.checked,
      baseUrl: els.syncUrlInput.value.trim() || workerBase || existingSync.baseUrl || "",
      playerLabel: username
    },
    launcherUpdate: {
      enabled: true,
      latestUrl: workerBase ? new URL("launcher/latest.json", workerBase).toString() : (currentStatus?.config?.launcherUpdate?.latestUrl || "")
    },
    launcherProof: {
      enabled: true,
      required: true,
      baseUrl: workerBase || currentStatus?.config?.launcherProof?.baseUrl || currentStatus?.config?.sync?.baseUrl || "",
      keyId: "aht-launcher-proof-v1"
    },
    minecraftLauncher: {
      enabled: els.minecraftProfileEnabledInput.checked,
      rootDir: els.minecraftRootInput.value.trim(),
      profileName: els.minecraftProfileNameInput.value.trim(),
      memoryMb: Number(els.minecraftMemoryInput.value || DEFAULT_MEMORY_MB)
    },
    playCommand: {
      command: els.playCommandInput.value.trim(),
      args: els.playArgsInput.value.trim() ? els.playArgsInput.value.trim().split(/\s+/) : [],
      cwd: els.instanceInput.value.trim()
    }
  };
  if (currentStatus?.developerMode) {
    next.developer = {
      adminBaseUrl: inputValue(els.adminUrlInput, "") || workerBase || existingDeveloper.adminBaseUrl || "",
      defaultOutDir: inputValue(els.outDirInput, existingDeveloper.defaultOutDir || ""),
      defaultCacheModsDir: els.cacheModsInput?.value.trim() || "",
      clientModpackDir: els.clientModpackDirInput?.value.trim() || "",
      ptbClientModpackDir: inputValue(els.ptbClientModpackDirInput, existingDeveloper.ptbClientModpackDir || existingDeveloper.clientModpackDir || ""),
      r2Bucket: inputValue(els.bucketInput, existingDeveloper.r2Bucket || "ahtlauncher"),
      r2AccountId: inputValue(els.r2AccountIdInput, existingDeveloper.r2AccountId || ""),
      cacheOnlyMode: cacheOnlyMode(),
      githubRepo: inputValue(els.githubRepoInput, existingDeveloper.githubRepo || "svre-mc/aht-launcher"),
      githubBranch: inputValue(els.githubBranchInput, existingDeveloper.githubBranch || "main"),
      githubWorkflow: inputValue(els.githubWorkflowInput, existingDeveloper.githubWorkflow || "build-macos.yml")
    };
    next.serverTransfer = {
      sourceDir: inputValue(els.serverSourceInput, currentStatus?.config?.serverTransfer?.sourceDir || ""),
      host: inputValue(els.serverHostInput, currentStatus?.config?.serverTransfer?.host || ""),
      port: Number(inputValue(els.serverPortInput, currentStatus?.config?.serverTransfer?.port || 22)),
      username: inputValue(els.serverUsernameInput, currentStatus?.config?.serverTransfer?.username || ""),
      remoteDir: inputValue(els.serverRemoteDirInput, currentStatus?.config?.serverTransfer?.remoteDir || ""),
      excludeDirs: ["DregoraRL"],
      includeDirs: ["mods", "scripts", "config", "ForgeEssentials"],
      includeRootFiles: true
    };
  }
  return next;
}
function fillSettings(status) {
  const config = status.config;
  const username = status.identity?.minecraftUsername || config.sync?.playerLabel || "";
  setInputValue(els.latestUrlInput, config.latestUrl || "");
  setInputValue(els.playerFeedUrlInput, config.latestUrl || "");
  setInputValue(els.proxyUrlInput, config.curseforge?.proxyBaseUrl || "");
  setInputValue(els.syncUrlInput, config.sync?.baseUrl || "");
  setInputValue(els.playerLabelInput, username);
  setInputValue(els.instanceInput, config.instanceDir || "");
  setInputValue(els.minecraftRootInput, config.minecraftLauncher?.rootDir || status.minecraftProfile?.rootDir || "");
  setInputValue(els.minecraftProfileNameInput, config.minecraftLauncher?.profileName || status.minecraftProfile?.profileName || "");
  setMemoryValue(config.minecraftLauncher?.memoryMb || DEFAULT_MEMORY_MB);
  setInputValue(els.playCommandInput, config.playCommand?.command || "");
  setInputValue(els.playArgsInput, Array.isArray(config.playCommand?.args) ? config.playCommand.args.join(" ") : "");
  els.minecraftProfileEnabledInput.checked = config.minecraftLauncher?.enabled !== false;
  els.syncEnabledInput.checked = config.sync?.enabled !== false;
  els.sendChangesInput.checked = config.sync?.sendLocalChanges !== false;
  setInputValue(els.adminUrlInput, config.developer?.adminBaseUrl || config.sync?.baseUrl || "");
  setInputValue(els.outDirInput, config.developer?.defaultOutDir || "");
  setInputValue(els.cacheModsInput, config.developer?.defaultCacheModsDir || "");
  setInputValue(els.clientModpackDirInput, config.developer?.clientModpackDir || config.developer?.defaultCacheModsDir?.replace(/[\\/]mods$/i, "") || "");
  setInputValue(els.ptbClientModpackDirInput, config.developer?.ptbClientModpackDir || config.developer?.clientModpackDir || config.developer?.defaultCacheModsDir?.replace(/[\\/]mods$/i, "") || "");
  if (els.clientZipVersionInput && !els.clientZipVersionInput.value) setInputValue(els.clientZipVersionInput, status.latest?.version || status.installed?.version || "");
  if (els.ptbClientZipVersionInput && !els.ptbClientZipVersionInput.value) setInputValue(els.ptbClientZipVersionInput, status.latest?.version || status.installed?.version || "");
  setInputValue(els.bucketInput, config.developer?.r2Bucket || "ahtlauncher");
  const savedR2AccountId = config.developer?.r2AccountId || status.developerSecrets?.r2AccountId || "";
  if (els.r2AccountIdInput && document.activeElement !== els.r2AccountIdInput && (savedR2AccountId || !els.r2AccountIdInput.value)) {
    setInputValue(els.r2AccountIdInput, savedR2AccountId);
  }
  setInputValue(els.githubRepoInput, config.developer?.githubRepo || "svre-mc/aht-launcher");
  setInputValue(els.githubBranchInput, config.developer?.githubBranch || "main");
  setInputValue(els.githubWorkflowInput, config.developer?.githubWorkflow || "build-macos.yml");
  if (els.cacheOnlyInput) els.cacheOnlyInput.checked = Boolean(config.developer?.cacheOnlyMode);
  setInputValue(els.serverSourceInput, config.serverTransfer?.sourceDir || "");
  setInputValue(els.serverHostInput, config.serverTransfer?.host || "");
  setInputValue(els.serverPortInput, config.serverTransfer?.port || 22);
  setInputValue(els.serverUsernameInput, config.serverTransfer?.username || "");
  setInputValue(els.serverRemoteDirInput, config.serverTransfer?.remoteDir || "");
  if (
    els.curseforgeApiKeyInput
    && status.developerSecrets?.curseforgeApiKey
    && document.activeElement !== els.curseforgeApiKeyInput
  ) {
    setInputValue(els.curseforgeApiKeyInput, status.developerSecrets.curseforgeApiKey);
  }
  if (
    els.serverPasswordInput
    && status.developerSecrets?.serverSshPassword
    && document.activeElement !== els.serverPasswordInput
  ) {
    setInputValue(els.serverPasswordInput, status.developerSecrets.serverSshPassword);
  }
  if (
    els.launcherProofSecretInput
    && status.developerSecrets?.launcherProofSecret
    && document.activeElement !== els.launcherProofSecretInput
  ) {
    setInputValue(els.launcherProofSecretInput, status.developerSecrets.launcherProofSecret);
  }
  if (
    els.socialServerSecretInput
    && status.developerSecrets?.socialServerSecret
    && document.activeElement !== els.socialServerSecretInput
  ) {
    setInputValue(els.socialServerSecretInput, status.developerSecrets.socialServerSecret);
  }
  if (
    els.githubTokenInput
    && status.developerSecrets?.githubToken
    && document.activeElement !== els.githubTokenInput
  ) {
    setInputValue(els.githubTokenInput, status.developerSecrets.githubToken);
  }
  if (
    els.r2AccessKeyIdInput
    && status.developerSecrets?.r2AccessKeyId
    && document.activeElement !== els.r2AccessKeyIdInput
  ) {
    setInputValue(els.r2AccessKeyIdInput, status.developerSecrets.r2AccessKeyId);
  }
  if (
    els.r2SecretAccessKeyInput
    && status.developerSecrets?.r2SecretAccessKey
    && document.activeElement !== els.r2SecretAccessKeyInput
  ) {
    setInputValue(els.r2SecretAccessKeyInput, status.developerSecrets.r2SecretAccessKey);
  }
  updateReleaseUploadState();
}

function renderStatus(status) {
  currentStatus = status;
  const statusPack = status.activePack || activeSidebarPack || "aht";
  activeSidebarPack = statusPack;
  packStatusCache.set(statusPack, status);
  developerAuthenticated = Boolean(status.developerAuthenticated);
  applyDeveloperGate(status);
  const latestVersion = status.latest?.version || "-";
  const launcherVersion = status.appVersion ? `Launcher v${status.appVersion}` : "Launcher v-";
  const developerBypass = Boolean(status.developerClientBypass || status.developerMode);
  const installedVersion = status.installed?.version || null;
  const configured = Boolean(status.config.latestUrl);
  const installedLabel = installedVersion ? `v.${installedVersion}` : "Not Installed";
  els.versionLine.textContent = installedLabel;
  if (els.launcherVersionLabel) els.launcherVersionLabel.textContent = launcherVersion;
  els.installedVersion.textContent = installedVersion || "Not Installed";
  els.latestVersion.textContent = latestVersion;
  if (statusPack === "ptb") {
    if (els.ptbSideInstalledVersion) els.ptbSideInstalledVersion.textContent = installedLabel;
  } else {
    els.sideInstalledVersion.textContent = installedLabel;
  }
  if (els.playerPackTitle) els.playerPackTitle.textContent = status.releaseName || (statusPack === "ptb" ? "A Hard Time PTB" : "A Hard Time");
  if (els.instanceDir) els.instanceDir.textContent = status.config.instanceDir || "-";
  if (status.minecraftProfile?.versionId) {
    const profileState = status.minecraftProfile.loaderInstalled ? "ready" : "loader missing";
    const accountState = status.minecraftProfile.accountReuseAvailable ? "account saved" : "sign-in needed";
    if (els.minecraftProfile) els.minecraftProfile.textContent = `${status.minecraftProfile.profileName || status.minecraftProfile.profileId} (${status.minecraftProfile.versionId}, ${profileState}, ${accountState})`;
  } else {
    if (els.minecraftProfile) els.minecraftProfile.textContent = status.minecraftProfile?.enabled === false ? "Disabled" : "Waiting for pack metadata";
  }
  if (els.installId) els.installId.textContent = shortId(status.identity.installId);
  els.playerLabelView.textContent = accountUsername(status) || "Player";
  if (els.profileFriendsButton) els.profileFriendsButton.hidden = !accountUsername(status);
  renderFriendsNotification(friendsSocialState);
  if (!friendsNotificationTimer) {
    refreshFriendsNotification();
    friendsNotificationTimer = window.setInterval(refreshFriendsNotification, 15000);
  }
  setSyncLine(status.config.sync?.enabled === false ? "Offline" : "Online");
  els.developerTab.hidden = !status.developerMode;
  els.developerTileButton.hidden = !status.developerMode;
  syncSetupNotice();
  renderSetupAssistant(status);
  renderUpdateLogs(status.updateLogs || []);
  renderLauncherUpdateOverlay(status, lastLauncherUpdateState);

  if (!configured) {
    setSettingsFeed(
      "warn",
      status.developerMode ? "Release feed missing" : "Setup incomplete",
      status.developerMode ? "Configure latest.json" : "Update service unavailable",
      status.developerMode ? "Enter the hosted latest.json URL or a local latest.json path before updating." : "Try again later or reinstall the launcher."
    );
  } else if (status.latestError) {
    setSettingsFeed(
      isFirstPublishPending(status) ? "warn" : (status.developerMode ? "bad" : "warn"),
      isFirstPublishPending(status) ? "No update published" : (status.developerMode ? "Feed check failed" : "Service unavailable"),
      isFirstPublishPending(status) ? "Waiting for first update" : (status.developerMode ? "latest.json is not reachable" : "Try again later"),
      playerSafeFeedProblem(status)
    );
  } else if (status.latest) {
    const fullClientZip = status.latest.installMode === "full-client-zip" || status.latest.zipFormat === "aht-full-client-zip";
    const installState = packInstallState(status);
    if (!status.developerMode && status.updateBlockedReason) {
      setSettingsFeed(installState.state, "Latest Release", `${displayPackName(status.latest.name || "Pack")} ${latestVersion}`, installState.label);
    } else {
      const modCount = status.latest.curseforge?.fileCount;
      const technicalDetail = `${fullClientZip ? "Exact AHT client ZIP" : (Number.isFinite(modCount) ? `${modCount} CurseForge files` : "CurseForge manifest ready")}; ${fullClientZip ? "no CurseForge fallback needed" : (status.latest.cacheManifest ? "fallback cache listed" : "no fallback cache listed")}.`;
      setSettingsFeed(installState.state, "Latest Release", `${displayPackName(status.latest.name || "Pack")} ${latestVersion}`, status.developerMode ? `${installState.label}; ${technicalDetail}` : installState.label);
    }
  } else {
    setSettingsFeed("warn", "Feed pending", "Waiting for latest.json", "Save settings or test the feed.");
  }

  if (status.latestError && !(developerBypass && status.installed)) {
    setBadge(isFirstPublishPending(status) ? "Not Installed" : (status.developerMode ? "Feed unavailable" : "Service unavailable"), isFirstPublishPending(status) ? "warn" : (status.developerMode ? "bad" : "warn"));
    setLog(playerSafeFeedProblem(status));
  } else if (developerBypass && status.installed) {
    setLaunchStatusBadge(status);
    els.diffSummary.textContent = "Bypassed";
    if (logIsEmpty()) setLog(status.launchReady ? "Developer client bypass active. Local mods and configs are allowed." : (playerSafeBlockedReason(status) || "Developer client bypass active."));
  } else if (status.updateBlockedReason) {
    setBadge("Update unavailable", "warn");
    els.diffSummary.textContent = "-";
    if (logIsEmpty()) setLog(status.updateBlockedReason);
  } else if (status.updateRequired) {
    setBadge("Update required", "warn");
    if (logIsEmpty()) setLog("A newer pack version is available.");
  } else if (!developerBypass && (status.integrity?.counts?.corrupted > 0 || status.launchBlockedReason?.startsWith("Repair required"))) {
    setBadge("Repair needed", "warn");
    els.diffSummary.textContent = `${status.integrity?.counts?.corrupted || "Files"} corrupted`;
    if (logIsEmpty()) setLog(playerSafeBlockedReason(status) || "Repair corrupted files before playing.");
  } else if (status.latest) {
    if (status.launchReady) {
      setBadge("Ready", "ok");
      if (logIsEmpty()) setLog("Pack is current.");
    } else {
      setLaunchStatusBadge(status);
      if (logIsEmpty()) setLog(playerSafeBlockedReason(status) || "Setup must finish before playing.");
    }
  } else {
    setBadge("Setup required", "warn");
    if (logIsEmpty()) setLog("Release feed required before updates can begin.");
  }

  const updateRunning = Boolean(lastUpdateState?.running);
  const launcherUpdateRequired = Boolean(status.launcherUpdate?.updateRequired);
  setUnavailable(els.updateButton, launcherUpdateRequired || Boolean(status.updateBlockedReason) || !status.latest || !status.updateRequired || updateRunning);
  setUnavailable(els.playButton, playBusy || updateRunning);
  setUnavailable(els.scanButton, launcherUpdateRequired || !status.installed || updateRunning);
  els.updateButton.title = status.updateBlockedReason || (status.updateRequired ? "Update pack" : "No update available.");
  els.playButton.title = playBusy
    ? "Preparing the exact Minecraft Launcher profile"
    : (status.launchReady ? "Launch Minecraft" : (playerSafeBlockedReason(status) || "Finish setup before playing."));
  if (shouldShowUpdateProgress(lastUpdateState)) {
    setProgress(true, estimateProgress(lastUpdateState), updateProgressLabel(lastUpdateState));
  } else {
    setProgress(false);
  }
  fillSettings(status);
  renderAccountGate(status);
  renderDownloads();
}

async function refresh(packKey = activeSidebarPack) {
  renderStatus(await window.aht.getStatus(packKey));
  lastStatusRefreshAt = Date.now();
}

async function refreshQuietly() {
  if (updatePoll || launcherUpdatePoll) return;
  try {
    await refresh();
  } catch (error) {
    console.warn("Status refresh failed", error);
  }
}

function activateTab(name) {
  activeTabName = name;
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  els.gameTiles.forEach((tile) => {
    const sameTab = tile.dataset.tab === "player"
      ? ["player", "news", "settings"].includes(name)
      : tile.dataset.tab === name;
    const samePack = !tile.dataset.pack || tile.dataset.pack === activeSidebarPack;
    tile.classList.toggle("active", sameTab && samePack);
  });
  els.views.forEach((view) => view.classList.toggle("active", view.id === name));
  syncSetupNotice();
}

async function openExternalDestination(button) {
  const destination = String(button?.dataset?.externalDestination || "").trim();
  if (!destination || !window.aht?.openExternal || button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await window.aht.openExternal(destination);
    if (!result?.ok || !result?.opened) {
      throw new Error(result?.error || "The link could not be opened.");
    }
  } catch (error) {
    showToast("Store could not be opened", cleanErrorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function focusActivityPanel(message) {
  activateTab("player");
  if (message && logIsEmpty()) setLog(message);
  if (!els.activityPanel) return;
  els.activityPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  els.activityPanel.classList.remove("is-focused");
  window.requestAnimationFrame(() => {
    els.activityPanel.classList.add("is-focused");
    window.setTimeout(() => els.activityPanel.classList.remove("is-focused"), 1400);
  });
}

async function pollUpdate() {
  let state;
  try {
    state = ensureTerminalUpdateTimestamp(await window.aht.getUpdateState());
  } catch (error) {
    const message = cleanErrorMessage(error);
    appendLog(`ERROR: ${message}`);
    showToast("Update status failed", message, "error");
    clearInterval(updatePoll);
    updatePoll = null;
    activeUpdateKind = "";
    await refresh();
    return;
  }
  lastUpdateState = state;
  const lines = [...state.lines];
  if (els.activityState) els.activityState.textContent = state.running ? "Running" : "Idle";
  setProgress(shouldShowUpdateProgress(state), estimateProgress(state), updateProgressLabel(state));
  if (state.error) lines.push(`ERROR: ${state.error}`);
  if (isSuccessfulUpdateState(state) && state.lastResult?.installed?.version) lines.push(`Installed ${state.lastResult.installed.version}`);
  setLog(lines.join("\n"));
  renderDownloads(state);
  if (!state.running) {
    clearInterval(updatePoll);
    updatePoll = null;
    const completedKind = activeUpdateKind;
    if (state.error) {
      showToast(completedKind === "repair" ? "Repair failed" : "Update failed", state.error, "error");
    } else if (state.lastResult?.installed?.version) {
      if (completedKind === "repair") {
        lastIntegrityScan = null;
        closeRepairPrompt();
        els.diffSummary.textContent = "Clean";
      }
      showToast(completedKind === "repair" ? "Repair complete" : "Update complete", `Installed ${state.lastResult.installed.version}.`, "success");
    }
    activeUpdateKind = "";
    await refresh();
    if (completedKind === "repair" && !state.error && !(currentStatus?.integrity?.counts?.corrupted > 0)) {
      lastIntegrityScan = null;
      closeRepairPrompt();
      els.diffSummary.textContent = "Clean";
      restoreStatusBadge();
    }
    if (isTerminalUpdateState(lastUpdateState)) scheduleCompletedUpdateClear();
  }
}

async function startUpdate(forceRepair, options = {}) {
  if (updatePoll || lastUpdateState?.running) {
    showToast("Install already running", "The launcher is already installing files. Leave it open until it finishes.", "info");
    return;
  }
  window.clearTimeout(updateCompleteHideTimer);
  updateCompleteHideTimer = null;
  activeUpdateKind = forceRepair ? "repair" : "update";
  if (forceRepair) {
    lastIntegrityScan = null;
    els.diffSummary.textContent = "Repairing";
  }
  lastUpdateState = {
    running: true,
    kind: activeUpdateKind,
    lines: [],
    lastResult: null,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    progress: { phase: forceRepair ? "Preparing repair" : "Preparing update", completed: 0, total: 0, percent: 3 }
  };
  setBadge(forceRepair ? "Repairing" : "Updating", "warn");
  if (els.activityState) els.activityState.textContent = forceRepair ? "Repairing" : "Updating";
  setProgress(true, 3, forceRepair ? "Preparing repair" : "Preparing update");
  setUnavailable(els.updateButton, true);
  setUnavailable(els.playButton, true);
  setUnavailable(els.scanButton, true);
  setLog("");
  renderDownloads(lastUpdateState);
  showToast(forceRepair ? "Repair started" : "Update started", "Progress is shown in the sidebar.", "info");
  window.aht.startUpdate({ forceRepair, replaceGameSettings: Boolean(options.replaceGameSettings), packKey: activeSidebarPack }).catch((error) => {
    const message = cleanErrorMessage(error);
    lastUpdateState = ensureTerminalUpdateTimestamp({
      ...(lastUpdateState || {}),
      running: false,
      error: message,
      progress: { ...(lastUpdateState?.progress || {}), phase: forceRepair ? "Repair failed" : "Update failed", percent: 100 }
    });
    appendLog(`ERROR: ${message}`);
    renderDownloads(lastUpdateState);
    showToast(forceRepair ? "Repair failed" : "Update failed", message, "error");
    clearInterval(updatePoll);
    updatePoll = null;
    activeUpdateKind = "";
    scheduleCompletedUpdateClear(DOWNLOAD_ERROR_VISIBLE_MS);
    refresh().catch(() => {});
  });
  updatePoll = setInterval(pollUpdate, 500);
  await pollUpdate();
}

function closeUpdateOptions() {
  if (els.updateOptionsOverlay) els.updateOptionsOverlay.hidden = true;
}

function openUpdateOptions() {
  if (!currentStatus?.setup?.gameSettingsPresent) {
    startUpdate(false);
    return;
  }
  if (!els.updateOptionsOverlay) {
    startUpdate(false);
    return;
  }
  const latest = currentStatus?.latest;
  const installed = currentStatus?.installed;
  const versionText = latest?.version ? `Version ${latest.version}` : "current release";
  const installedText = installed?.version ? `Installed ${installed.version}. ` : "";
  els.updateOptionsSummary.textContent = `${installedText}The launcher will download ${versionText}.`;
  if (els.replaceGameSettingsInput) els.replaceGameSettingsInput.checked = false;
  els.updateOptionsOverlay.hidden = false;
  els.updateOptionsUpdateButton?.focus();
}

function integrityIssueSummary(scan) {
  const counts = scan?.counts || {};
  if (!counts.managed) return "No installed file manifest was found.";
  if (!counts.corrupted) return `${counts.checked || 0} files validated.`;
  const parts = [];
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts.added) parts.push(`${counts.added} extra`);
  return `${counts.corrupted} corrupted files found (${parts.join(", ")}).`;
}

function formatIntegrityScan(scan) {
  const lines = [
    `Validated ${scan?.counts?.checked || 0}/${scan?.counts?.managed || 0} managed files.`,
    integrityIssueSummary(scan)
  ];
  const changed = scan?.changed || [];
  const missing = scan?.missing || [];
  const added = scan?.added || [];
  if (changed.length) {
    lines.push("", "Changed:");
    for (const item of changed.slice(0, 20)) lines.push(`  ${item.path}`);
  }
  if (missing.length) {
    lines.push("", "Missing:");
    for (const item of missing.slice(0, 20)) lines.push(`  ${item.path}`);
  }
  if (added.length) {
    lines.push("", "Extra mods:");
    for (const item of added.slice(0, 20)) lines.push(`  ${item.path}`);
  }
  if (scan?.truncated) lines.push("", "More files were found than are shown here.");
  return lines.join("\n");
}

function showRepairPrompt(scan) {
  if (!els.repairPromptOverlay) return;
  const changed = scan?.changed || [];
  const missing = scan?.missing || [];
  const added = scan?.added || [];
  els.repairPromptSummary.textContent = `${integrityIssueSummary(scan)} Do you want to repair them now?`;
  els.repairPromptList.innerHTML = "";
  const items = [
    ...missing.map((item) => ({ type: "Missing", path: item.path })),
    ...changed.map((item) => ({ type: "Changed", path: item.path })),
    ...added.map((item) => ({ type: "Extra", path: item.path }))
  ];
  for (const item of items.slice(0, 12)) {
    const row = document.createElement("div");
    const type = document.createElement("span");
    type.textContent = `${item.type}: `;
    row.append(type, document.createTextNode(item.path));
    els.repairPromptList.appendChild(row);
  }
  if (items.length > 12) {
    const row = document.createElement("div");
    row.textContent = `${items.length - 12} more files will be repaired.`;
    els.repairPromptList.appendChild(row);
  }
  els.repairPromptOverlay.hidden = false;
  els.repairPromptRepairButton.focus();
}

function closeRepairPrompt() {
  if (els.repairPromptOverlay) els.repairPromptOverlay.hidden = true;
}

async function scanFilesForRepair() {
  if (updatePoll || lastUpdateState?.running) {
    showToast("Install already running", "Wait for the current install to finish before scanning.", "info");
    return;
  }
  window.clearTimeout(scanProgressHideTimer);
  setUnavailable(els.scanButton, true);
  setUnavailable(els.updateButton, true);
  setUnavailable(els.playButton, true);
  setBadge("Scanning", "warn");
  setProgress(true, 8, "Scanning files");
  setLog("");
  let scanCompleted = false;
  try {
    const scan = await window.aht.scanFiles(activeSidebarPack);
    scanCompleted = true;
    lastIntegrityScan = scan;
    setLog(formatIntegrityScan(scan));
    const corrupted = scan?.counts?.corrupted || 0;
    if (!scan?.counts?.managed) {
      els.diffSummary.textContent = "Not installed";
      setProgress(true, 100, "Scan unavailable");
      restoreStatusBadge();
      clearScanProgressSoon();
      showToast("Scan unavailable", "Install the pack before scanning files.", "warn");
    } else if (corrupted) {
      els.diffSummary.textContent = `${corrupted} corrupted`;
      setProgress(true, 100, "Repair needed");
      setBadge("Repair needed", "warn");
      clearScanProgressSoon();
      showRepairPrompt(scan);
    } else {
      els.diffSummary.textContent = "Clean";
      setProgress(true, 100, "Scan complete");
      restoreStatusBadge();
      clearScanProgressSoon();
      showToast("Scan complete", integrityIssueSummary(scan), "success");
    }
  } catch (error) {
    const message = cleanErrorMessage(error);
    setProgress(true, 100, "Scan failed");
    setBadge("Scan failed", "bad");
    clearScanProgressSoon(2200);
    setLog(message);
    showToast("Scan failed", message, "error");
  } finally {
    setUnavailable(els.scanButton, false);
    if (currentStatus) {
      const updateRunning = Boolean(lastUpdateState?.running);
      setUnavailable(els.updateButton, Boolean(currentStatus.updateBlockedReason) || !currentStatus.latest || !currentStatus.updateRequired || updateRunning);
      setUnavailable(els.playButton, playBusy || updateRunning);
    }
    if (scanCompleted) {
      const scanLog = currentLogText();
      await refresh();
      if (scanLog) setLog(scanLog);
    }
  }
}

async function openFolderPath(target = "", label = "Folder") {
  const resolvedTarget = String(target || "").trim();
  if (!resolvedTarget) {
    showToast(`${label} unavailable`, "Choose a folder first.", "warn");
    return false;
  }
  try {
    const result = await window.aht.openPath(resolvedTarget);
    const error = typeof result === "string" ? result : String(result?.error || "");
    if (error || result?.ok === false) {
      throw new Error(error || `${label} could not be opened.`);
    }
    return true;
  } catch (error) {
    showToast(`${label} could not be opened`, cleanErrorMessage(error), "error");
    return false;
  }
}

async function openCurrentInstance() {
  return openFolderPath(currentStatus?.config?.instanceDir || "", "Modpack folder");
}

async function applyRecommendedSetup() {
  if (isUnavailable(els.setupAutoButton) && isUnavailable(els.settingsAutoSetupButton)) return;
  setUnavailable(els.setupAutoButton, true);
  setUnavailable(els.settingsAutoSetupButton, true);
  try {
    const status = await window.aht.setupApply();
    renderStatus(status);
    const detail = status.config.latestUrl
      ? "Release feed and instance path were applied."
      : "Instance path was applied. Add a latest.json feed to continue.";
    showToast("Auto setup applied", detail, status.config.latestUrl ? "success" : "warn");
  } catch (error) {
    const message = cleanErrorMessage(error);
    showToast("Auto setup failed", message, "error");
  } finally {
    if (currentStatus) renderSetupAssistant(currentStatus);
  }
}

els.tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
els.externalLinks.forEach((button) => button.addEventListener("click", () => openExternalDestination(button)));
els.gameTiles.forEach((tile) => tile.addEventListener("click", async () => {
  const nextPack = tile.dataset.pack || activeSidebarPack;
  if (nextPack !== activeSidebarPack && (updatePoll || lastUpdateState?.running)) {
    showToast("Update in progress", "Finish the current pack operation before switching packs.", "info");
    return;
  }
  activeSidebarPack = nextPack;
  activateTab(tile.dataset.tab);
  setBadge("Checking", "warn");
  try {
    await refresh(nextPack);
  } catch (error) {
    showToast("Pack status failed", cleanErrorMessage(error), "error");
  }
}));
els.setupSettingsButton.addEventListener("click", () => activateTab("settings"));
els.setupAutoButton.addEventListener("click", applyRecommendedSetup);
els.settingsAutoSetupButton.addEventListener("click", applyRecommendedSetup);
els.downloadsButton.addEventListener("click", openDownloads);
els.downloadsCloseButton.addEventListener("click", closeDownloads);
if (els.profileFriendsButton) els.profileFriendsButton.addEventListener("click", openFriendsPanel);
for (const tab of [els.legalTermsTab, els.legalPrivacyTab]) {
  if (tab) tab.addEventListener("click", () => showLegalDocument(tab.dataset.legalDocument));
}
if (els.legalAcceptCheckbox) {
  els.legalAcceptCheckbox.addEventListener("change", () => {
    els.legalAcceptButton.disabled = !els.legalAcceptCheckbox.checked;
    setUnavailable(els.legalAcceptButton, !els.legalAcceptCheckbox.checked);
    if (els.legalError.textContent) els.legalError.textContent = "";
  });
}
if (els.legalAcceptButton) els.legalAcceptButton.addEventListener("click", acceptLegalTerms);
if (els.legalExitButton) els.legalExitButton.addEventListener("click", () => window.aht.appExit());
if (els.friendsCloseButton) els.friendsCloseButton.addEventListener("click", closeFriendsPanel);
if (els.friendsRefreshButton) els.friendsRefreshButton.addEventListener("click", () => refreshFriendsPanel());
if (els.friendsOverlay) {
  els.friendsOverlay.addEventListener("click", (event) => {
    if (event.target === els.friendsOverlay) closeFriendsPanel();
  });
}
if (els.launcherUpdateNowButton) {
  els.launcherUpdateNowButton.addEventListener("click", () => {
    if (lastLauncherUpdateState?.lastResult?.restartRequired) {
      restartLauncherSelfUpdate();
      return;
    }
    startLauncherSelfUpdate();
  });
}
els.downloadsOverlay.addEventListener("click", (event) => {
  if (event.target === els.downloadsOverlay) closeDownloads();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.downloadsOverlay.hidden) closeDownloads();
  if (event.key === "Escape" && els.friendsOverlay && !els.friendsOverlay.hidden) closeFriendsPanel();
  if (event.key === "Escape" && els.repairPromptOverlay && !els.repairPromptOverlay.hidden) closeRepairPrompt();
  if (event.key === "Escape" && els.updateOptionsOverlay && !els.updateOptionsOverlay.hidden) closeUpdateOptions();
});
els.updateButton.addEventListener("click", () => {
  if (!isUnavailable(els.updateButton)) openUpdateOptions();
});
if (els.downloadsUpdateIconButton) {
  els.downloadsUpdateIconButton.addEventListener("click", () => {
    if (!isUnavailable(els.downloadsUpdateIconButton)) openUpdateOptions();
  });
}
els.playButton.addEventListener("click", async () => {
  if (playBusy || isUnavailable(els.playButton)) return;
  const requestedPackKey = activeSidebarPack;
  const requestedPackName = requestedPackKey === "ptb" ? "A Hard Time PTB" : "A Hard Time";
  if (els.copyLatestLaunchReportButton) els.copyLatestLaunchReportButton.hidden = true;
  setPlayBusy(true);
  setLog(`Preparing ${requestedPackName} and Minecraft Launcher...`);
  showToast("Preparing Minecraft Launcher", `Selecting the exact ${requestedPackName} installation.`, "info");
  try {
    const result = await window.aht.play(requestedPackKey);
    const profileName = result?.minecraftProfile?.profileName || requestedPackName;
    showToast(
      "Minecraft Launcher opened",
      `${profileName} is prepared for launch. Click Play inside Minecraft Launcher.`,
      "success"
    );
    if (els.copyLatestLaunchReportButton) {
      els.copyLatestLaunchReportButton.hidden = false;
      els.copyLatestLaunchReportButton.dataset.packKey = requestedPackKey;
    }
  } catch (error) {
    const message = playerSafeErrorMessage(error);
    setLog(message);
    if (els.copyLatestLaunchReportButton) {
      // Keep the report action available after a failed handoff as well as
      // after a successful one. The saved report is the useful artifact
      // support needs for either outcome.
      els.copyLatestLaunchReportButton.hidden = false;
      els.copyLatestLaunchReportButton.dataset.packKey = requestedPackKey;
    }
    showToast("Launch failed", message, "error", {
      context: "play:start",
      packKey: requestedPackKey,
      copyLabel: "Click here to copy"
    });
    void refresh().then(() => setLog(message)).catch(() => {});
  } finally {
    setPlayBusy(false);
    if (currentStatus) {
      renderStatus(currentStatus);
    } else {
      setUnavailable(els.playButton, Boolean(lastUpdateState?.running));
      els.playButton.title = "Run the launch checks and create a support report if anything fails.";
    }
  }
});
if (els.copyLatestLaunchReportButton) {
  els.copyLatestLaunchReportButton.addEventListener("click", async () => {
    if (isUnavailable(els.copyLatestLaunchReportButton)) return;
    setUnavailable(els.copyLatestLaunchReportButton, true);
    try {
      await copyErrorReportFromToast({
        title: "Launch diagnostics",
        context: "play:start",
        packKey: els.copyLatestLaunchReportButton.dataset.packKey || activeSidebarPack
      });
    } finally {
      setUnavailable(els.copyLatestLaunchReportButton, false);
    }
  });
}
if (els.openInstanceFromPlayerButton) {
  els.openInstanceFromPlayerButton.addEventListener("click", () => openCurrentInstance());
}
els.accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAccount();
});
els.minecraftUsernameInput.addEventListener("input", () => {
  if (els.accountError.textContent) {
    els.accountError.textContent = "";
  }
});
els.scanButton.addEventListener("click", scanFilesForRepair);
if (els.repairPromptCancelButton) {
  els.repairPromptCancelButton.addEventListener("click", closeRepairPrompt);
}
if (els.repairPromptOverlay) {
  els.repairPromptOverlay.addEventListener("click", (event) => {
    if (event.target === els.repairPromptOverlay) closeRepairPrompt();
  });
}
if (els.repairPromptRepairButton) {
  els.repairPromptRepairButton.addEventListener("click", () => {
    closeRepairPrompt();
    startUpdate(true);
  });
}
if (els.updateOptionsBackButton) {
  els.updateOptionsBackButton.addEventListener("click", closeUpdateOptions);
}
if (els.updateOptionsOverlay) {
  els.updateOptionsOverlay.addEventListener("click", (event) => {
    if (event.target === els.updateOptionsOverlay) closeUpdateOptions();
  });
}
if (els.updateOptionsUpdateButton) {
  els.updateOptionsUpdateButton.addEventListener("click", () => {
    const replaceGameSettings = Boolean(els.replaceGameSettingsInput?.checked);
    closeUpdateOptions();
    startUpdate(false, { replaceGameSettings });
  });
}
if (els.pickInstanceButton) {
  els.pickInstanceButton.addEventListener("click", async () => {
    const folder = await window.aht.selectFolder(els.instanceInput.value.trim() || currentStatus?.config?.instanceDir || "");
    if (folder) els.instanceInput.value = folder;
  });
}
if (els.openInstancePathButton) {
  els.openInstancePathButton.addEventListener("click", () => openFolderPath(
    els.instanceInput.value.trim() || currentStatus?.config?.instanceDir || "",
    "Modpack folder"
  ));
}
if (els.openMinecraftRootPathButton) {
  els.openMinecraftRootPathButton.addEventListener("click", () => openFolderPath(
    els.minecraftRootInput.value.trim() || currentStatus?.config?.minecraftLauncher?.rootDir || "",
    "Minecraft Launcher folder"
  ));
}
els.pickMinecraftRootButton.addEventListener("click", async () => {
  const folder = await window.aht.selectFolder(els.minecraftRootInput.value.trim() || currentStatus?.config?.minecraftLauncher?.rootDir || "");
  if (folder) els.minecraftRootInput.value = folder;
});
if (els.minecraftMemoryInput) {
  els.minecraftMemoryInput.addEventListener("input", () => setMemoryValue(els.minecraftMemoryInput.value));
}
els.pickLatestButton.addEventListener("click", async () => {
  const file = await window.aht.selectJson();
  if (file) {
    els.latestUrlInput.value = file;
    setSettingsFeed("warn", "Feed selected", "Test or save latest.json", "The selected local release feed has not been tested yet.");
  }
});
els.testFeedButton.addEventListener("click", async () => {
  if (isUnavailable(els.testFeedButton)) return;
  setUnavailable(els.testFeedButton, true);
  setSettingsFeed("warn", "Checking feed", "Contacting latest.json", "Validating the current Settings values.");
  try {
    const result = await window.aht.testFeed(serializeSettings(), activeSidebarPack);
    const fullClientZip = Boolean(result.latest?.fullClientZip || result.latest?.installMode === "full-client-zip");
    const modCount = result.latest?.curseforgeFileCount;
    const detail = currentStatus?.developerMode
      ? `${fullClientZip ? "Exact AHT client ZIP" : (Number.isFinite(modCount) ? `${modCount} CurseForge files` : "CurseForge manifest ready")}; ${fullClientZip ? "no CurseForge fallback needed" : (result.latest?.hasCacheManifest ? "fallback cache available" : "fallback cache not listed")}.`
      : packInstallState(currentStatus).label;
    setSettingsFeed(
      packInstallState(currentStatus).state,
      "Latest Release",
      `${displayPackName(result.latest?.name || "Pack")} ${result.latest?.version || ""}`.trim(),
      detail
    );
    showToast("Release feed connected", result.message || "latest.json validated.", "success");
  } catch (error) {
    const message = cleanErrorMessage(error);
    setSettingsFeed("bad", "Feed test failed", "latest.json could not be validated", message);
    showToast("Feed test failed", message, "error");
  } finally {
    setUnavailable(els.testFeedButton, false);
  }
});
els.saveSettingsButton.addEventListener("click", async () => {
  try {
    await saveDeveloperSecrets({ quiet: false });
    const result = await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    await refresh();
    if (result?.profileUpdated) {
      showToast("Settings saved", "Minecraft Launcher profile was updated.", "success");
    } else if (result?.profileError) {
      showToast("Settings saved; launcher setup failed", result.profileError, "error");
    } else {
      showToast("Settings saved", result?.profileSkipped || "Launcher configuration was updated.", "success");
    }
  } catch (error) {
    showToast("Save failed", cleanErrorMessage(error), "error");
  }
});
if (els.openInstanceButton) {
  els.openInstanceButton.addEventListener("click", () => openCurrentInstance());
}
if (els.saveAdminUrlButton) {
  els.saveAdminUrlButton.addEventListener("click", async () => {
    try {
      await saveDeveloperSecrets();
      await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
      setDevLog("Saved");
      showToast("Admin URL saved", "Developer configuration was updated.", "success");
    } catch (error) {
      const message = cleanErrorMessage(error);
      setDevLog(message);
      showToast("Save failed", message, "error");
    }
  });
}
async function loginDeveloper() {
  setUnavailable(els.loginButton, true);
  els.developerLoginStatus.textContent = "Checking credentials...";
  try {
    const result = await window.aht.devLogin({
      username: els.adminUserInput.value.trim(),
      password: els.adminPasswordInput.value
    });
    els.adminPasswordInput.value = "";
    developerAuthenticated = true;
    document.body.classList.remove("dev-locked");
    els.developerTab.hidden = false;
    els.developerTileButton.hidden = false;
    els.developerLoginScreen.hidden = true;
    els.developerConsole.hidden = false;
    els.developerSessionStatus.textContent = result.expiresAt
      ? `Session active until ${new Date(result.expiresAt).toLocaleTimeString()}`
      : "Session active";
    activateTab("developer");
    updateReleaseUploadState();
    setDevLog(result);
    const remoteDetail = result.remoteAuthenticated
      ? "Worker admin data is connected."
      : result.remotePending
        ? "Worker admin data is still connecting in the background."
        : result.remoteError
          ? `Worker data not connected: ${result.remoteError}`
          : "";
    showToast("Developer login successful", remoteDetail || (result.expiresAt ? `Expires ${new Date(result.expiresAt).toLocaleString()}` : ""), "success");
    refresh().catch((error) => {
      const message = cleanErrorMessage(error);
      setDevLog(message);
      showToast("Status refresh failed", message, "error");
    });
  } catch (error) {
    const message = cleanErrorMessage(error);
    developerAuthenticated = false;
    document.body.classList.add("dev-locked");
    els.developerLoginScreen.hidden = false;
    els.developerConsole.hidden = true;
    els.developerLoginStatus.textContent = message;
    els.adminPasswordInput.value = "";
    setDevLog(message);
    showToast("Developer login failed", message, "error");
  } finally {
    setUnavailable(els.loginButton, false);
  }
}

els.developerLoginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loginDeveloper();
});
els.devTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateDeveloperSection(tab.dataset.devTarget));
});
els.loadUpdateLogsButton.addEventListener("click", () => loadDeveloperUpdateLogs());
els.publishUpdateLogButton.addEventListener("click", () => publishDeveloperUpdateLog());
els.pickUpdateLogImageButton.addEventListener("click", async () => {
  const file = await window.aht.selectUpdateLogImage();
  if (file) els.updateLogImageInput.value = file;
});
els.pickUpdateLogVideoButton.addEventListener("click", async () => {
  const file = await window.aht.selectUpdateLogVideo();
  if (file) els.updateLogVideoInput.value = file;
});
els.updateLogCloseButton.addEventListener("click", () => closeUpdateLog());
if (els.updateLogWatchButton) {
  els.updateLogWatchButton.addEventListener("click", () => openUpdateLogVideo(activeUpdateLog));
}
els.updateLogVideoCloseButton.addEventListener("click", () => closeUpdateLogVideo());
els.updateLogVideoOverlay.addEventListener("click", (event) => {
  if (event.target === els.updateLogVideoOverlay) closeUpdateLogVideo();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!els.updateLogVideoOverlay.hidden) closeUpdateLogVideo();
    else if (!els.updateLogOverlay.hidden) closeUpdateLog();
  }
});
els.scanLauncherBuildsButton.addEventListener("click", () => scanLauncherBuilds());
els.publishLauncherUpdateButton.addEventListener("click", () => publishLauncherUpdate());
if (els.testLauncherReinstallButton) {
  els.testLauncherReinstallButton.addEventListener("click", () => prepareLocalLauncherReinstall());
}
els.planServerTransferButton.addEventListener("click", () => planServerTransfer().catch(() => {}));
els.uploadServerFilesButton.addEventListener("click", () => uploadServerFiles().catch(() => {}));
if (els.loadDashboardButton) {
  els.loadDashboardButton.addEventListener("click", () => loadPlayerDownloadHistory());
}
els.playerDataTabs.forEach((tab) => {
  tab.addEventListener("click", () => activatePlayerDataView(tab.dataset.playerDataView));
});
if (els.accessDecisionClose) {
  els.accessDecisionClose.addEventListener("click", () => {
    els.accessDecisionDialog?.close();
    selectedAccessPlayer = null;
  });
}
if (els.accessDecisionForm) {
  els.accessDecisionForm.addEventListener("submit", submitAccessDecision);
}
els.pickZipButton.addEventListener("click", async () => {
  const file = await window.aht.selectZip();
  if (file) {
    els.packZipInput.value = file;
    invalidateReleaseValidation();
  }
});
if (els.pickOutButton) {
  els.pickOutButton.addEventListener("click", async () => {
    const folder = await window.aht.selectFolder(els.outDirInput.value.trim());
    if (folder) {
      els.outDirInput.value = folder;
      invalidateReleaseValidation();
    }
  });
}
els.pickCacheModsButton.addEventListener("click", async () => {
  const folder = await window.aht.selectFolder(els.cacheModsInput.value.trim() || currentStatus?.config?.developer?.cacheModsDir || "");
  if (folder) {
    els.cacheModsInput.value = folder;
    invalidateReleaseValidation();
  }
});
if (els.pickClientModpackDirButton) {
  els.pickClientModpackDirButton.addEventListener("click", async () => {
    const folder = await window.aht.selectFolder(els.clientModpackDirInput.value.trim() || currentStatus?.config?.developer?.clientModpackDir || "");
    if (folder) {
      els.clientModpackDirInput.value = folder;
      await window.aht.saveSettings(serializeSettings(), activeSidebarPack).catch(() => {});
    }
  });
}
if (els.pickPtbClientModpackDirButton) {
  els.pickPtbClientModpackDirButton.addEventListener("click", async () => {
    const folder = await window.aht.selectFolder(inputValue(els.ptbClientModpackDirInput, currentStatus?.config?.developer?.ptbClientModpackDir || ""));
    if (folder) {
      setInputValue(els.ptbClientModpackDirInput, folder, { force: true });
      await window.aht.saveSettings(serializeSettings(), activeSidebarPack).catch(() => {});
      invalidateReleaseValidation("PTB source selected", "Create ZIP will package and upload this folder to the isolated PTB track.", "ptb");
    }
  });
}
function setClientZipStatus(state, title, detail = "") {
  if (!els.clientZipStatus) return;
  els.clientZipStatus.className = `release-check-card ${state}`.trim();
  const label = els.clientZipStatus.querySelector("span");
  const strong = els.clientZipStatus.querySelector("strong");
  const paragraph = els.clientZipStatus.querySelector("p");
  if (label) label.textContent = "Exact client package";
  if (strong) strong.textContent = title;
  if (paragraph) paragraph.textContent = detail;
}

async function buildClientZipFromSelectedFolder() {
  const sourceDir = els.clientModpackDirInput?.value.trim() || "";
  const version = els.clientZipVersionInput?.value.trim() || currentStatus?.latest?.version || currentStatus?.installed?.version || "";
  if (!sourceDir) {
    setClientZipStatus("bad", "Folder required", "Choose the client modpack folder first.");
    showToast("Client folder required", "Choose the modpack instance folder before creating a ZIP.", "warn");
    return;
  }
  if (!version) {
    setClientZipStatus("bad", "Version required", "Enter the pack version before creating a ZIP.");
    showToast("Version required", "Enter the modpack version for latest.json.", "warn");
    return;
  }
  setUnavailable(els.buildClientZipButton, true);
  setClientZipStatus("warn", "Creating ZIP", sourceDir);
  try {
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    const result = await window.aht.devBuildClientZip({
      sourceDir,
      version,
      outDir: developerOutDir(),
      name: "A Hard Time",
      packId: currentStatus?.config?.packId || currentStatus?.latest?.packId || currentStatus?.installed?.packId || "a-hard-time-dregora",
      minecraft: currentStatus?.latest?.minecraft || currentStatus?.installed?.minecraft || null
    });
    els.packZipInput.value = result.zipPath;
    invalidateReleaseValidation("AHT client ZIP ready", "Release Builder is now pointed at the exact client ZIP.");
    setClientZipStatus("ok", "ZIP created", `${result.fileCount} files, ${formatBytes(result.totalBytes)}. Release Builder now uses this ZIP.`);
    setDevLog(result);
    showToast("Modpack ZIP created", result.zipPath, "success");
  } catch (error) {
    const message = cleanErrorMessage(error);
    setClientZipStatus("bad", "ZIP failed", message);
    setDevLog(message);
    showToast("ZIP failed", message, "error");
  } finally {
    setUnavailable(els.buildClientZipButton, false);
  }
}

if (els.buildClientZipButton) {
  els.buildClientZipButton.addEventListener("click", () => buildClientZipFromSelectedFolder());
}
async function buildPtbClientZipFromSelectedFolder() {
  const sourceDir = inputValue(els.ptbClientModpackDirInput, currentStatus?.config?.developer?.ptbClientModpackDir || "");
  const version = inputValue(els.ptbClientZipVersionInput, "");
  if (!sourceDir) {
    setReleaseCheck("bad", "PTB folder required", "Choose the PTB client modpack folder", "The default CurseForge instance can be changed before creating the ZIP.", "ptb");
    return;
  }
  if (!version) {
    setReleaseCheck("bad", "PTB version required", "Enter the PTB pack version", "The version is used by the PTB player feed and GitHub release.", "ptb");
    return;
  }
  setUnavailable(els.buildPtbClientZipButton, true);
  setReleaseCheck("warn", "Creating PTB ZIP", "Reading the configured client", sourceDir, "ptb");
  try {
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    const result = await window.aht.devBuildClientZip({
      sourceDir,
      version,
      outDir: developerOutDir(),
      releaseTarget: "ptb",
      minecraft: currentStatus?.latest?.minecraft || currentStatus?.installed?.minecraft || null
    });
    setInputValue(els.ptbPackZipInput, result.zipPath, { force: true });
    invalidateReleaseValidation("PTB ZIP created", `${result.fileCount} files, ${formatBytes(result.totalBytes)}. Starting the isolated PTB upload now.`, "ptb");
    setReleaseCheck("warn", "Uploading PTB", `${result.version} package created`, "Validating and uploading the PTB ZIP. Stable AHT remains unchanged.", "ptb");
    setDevLog(result);
    await publishSelectedRelease("ptb");
  } catch (error) {
    const message = cleanErrorMessage(error);
    setReleaseCheck("bad", "PTB ZIP failed", "Could not create PTB package", message, "ptb");
    setDevLog(message);
    showToast("PTB ZIP failed", message, "error");
  } finally {
    setUnavailable(els.buildPtbClientZipButton, false);
  }
}
if (els.buildPtbClientZipButton) {
  els.buildPtbClientZipButton.addEventListener("click", buildPtbClientZipFromSelectedFolder);
}
els.pickServerSourceButton.addEventListener("click", async () => {
  const folder = await window.aht.selectFolder(els.serverSourceInput.value.trim() || currentStatus?.config?.serverTransfer?.sourceDir || "");
  if (folder) {
    els.serverSourceInput.value = folder;
    try {
      await saveServerTransferSettings();
      setServerTransferStatus("warn", "Folder saved", "Scanning selected server folder", folder);
      await planServerTransfer();
    } catch (error) {
      const message = cleanErrorMessage(error);
      setServerTransferStatus("bad", "Folder failed", "Could not use selected server folder", message);
      showToast("Server folder failed", message, "error");
    }
  }
});
for (const input of [els.serverSourceInput, els.serverHostInput, els.serverPortInput, els.serverUsernameInput, els.serverRemoteDirInput]) {
  input.addEventListener("change", () => {
    saveServerTransferSettings().catch((error) => {
      showToast("Server settings not saved", cleanErrorMessage(error), "error");
    });
  });
}
function setReleaseBusy(value) {
  releaseBusy = value;
  updateReleaseUploadState();
}

function requireOk(result, label) {
  if (result?.ok) return result;
  const summary = result?.errors?.map((error) => error.label).join(", ") || result?.output || `${label} failed`;
  throw new Error(summary);
}

async function writePlayerDefaultsForCurrentFeed(options = {}) {
  if (!/^https?:\/\//i.test(playerFeedUrl())) return null;
  const result = await window.aht.devWritePlayerDefaults({
    publicLatestUrl: playerFeedUrl(),
    bucket: releaseBucketName(),
    cacheOnlyMode: options.cacheOnlyMode ?? cacheOnlyMode()
  });
  const locations = (result.written || []).map((item) => item.path).join("\n");
  if (locations) {
    setDevLog(`${els.devLog.textContent ? `${els.devLog.textContent}\n\n` : ""}Player defaults written:\n${locations}`);
  }
  return result;
}

async function writeDefaultsFromDeveloperFeed() {
  if (isUnavailable(els.writeDefaultsButton)) return null;
  setReleaseBusy(true);
  try {
    await saveDeveloperSecrets();
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    setReleaseCheck("warn", "Writing defaults", "Player feed selected", "Saving app.defaults.json for fresh installs.");
    const result = await writePlayerDefaultsForCurrentFeed();
    const count = result?.written?.length || 0;
    const locations = (result?.written || []).map((item) => item.path).join("\n");
    setDevLog({ playerDefaults: result });
    setReleaseCheck("ok", "Defaults written", result?.latestUrl || playerFeedUrl(), `${count} location${count === 1 ? "" : "s"} updated.`);
    showToast("Player defaults written", locations || "app.defaults.json updated.", "success");
    return result;
  } catch (error) {
    const message = cleanErrorMessage(error);
    setDevLog(message);
    setReleaseCheck("bad", "Defaults failed", "app.defaults.json was not written", message);
    showToast("Defaults failed", message, "error");
    throw error;
  } finally {
    setReleaseBusy(false);
  }
}

async function setupCloudForDeveloper({ keepBusy = false } = {}) {
  if (isUnavailable(els.setupCloudButton) && !keepBusy) return null;
  const setupReason = setupCloudBlockReason();
  if (setupReason) {
    setReleaseCheck("bad", "Cloud setup locked", "Missing setup data", setupReason);
    showToast("Cloud setup locked", setupReason, "warn");
    return null;
  }
  const setupCacheOnlyMode = cacheOnlyMode();
  if (!keepBusy) setReleaseBusy(true);
  try {
    await saveDeveloperSecrets();
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    setReleaseCheck("warn", "Cloud setup", "Checking Cloudflare account", "A browser login opens only if Wrangler is not already signed in.");
    const login = await window.aht.devCloudLogin({
      releaseBucket: releaseBucketName(),
      dataBucket: dataBucketName()
    });
    requireOk(login, "Cloudflare login");

    setReleaseCheck("warn", "Cloud setup", "Preparing R2 buckets", `${releaseBucketName()} and ${dataBucketName()}.`);
    const buckets = await window.aht.devCloudSetupBuckets({
      releaseBucket: releaseBucketName(),
      dataBucket: dataBucketName()
    });
    requireOk(buckets, "R2 bucket setup");

    setReleaseCheck("warn", "Cloud setup", "Saving Worker secrets", localCurseForgeApiKey() ? "Writing CurseForge, developer login, launcher proof, and server social secrets." : "Writing developer login, launcher proof, and server social secrets; CurseForge proxy is disabled unless a key is added later.");
    const secrets = await window.aht.devCloudSetupSecrets({
      curseforgeApiKey: localCurseForgeApiKey(),
      launcherProofSecret: localLauncherProofSecret(),
      socialServerSecret: localSocialServerSecret(),
      adminUsername: inputValue(els.adminUserInput, "admin"),
      adminPassword: inputValue(els.adminPasswordInput, ""),
      releaseBucket: releaseBucketName(),
      dataBucket: dataBucketName(),
      cacheOnlyMode: setupCacheOnlyMode
    });
    requireOk(secrets, "Worker secrets");

    setReleaseCheck("warn", "Cloud setup", "Deploying Worker", "Publishing the Worker that serves the player feed.");
    const deploy = await window.aht.devCloudDeployWorker({
      releaseBucket: releaseBucketName(),
      dataBucket: dataBucketName()
    });
    if (deploy.latestUrl) {
      setInputValue(els.playerFeedUrlInput, deploy.latestUrl);
      await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
      await writePlayerDefaultsForCurrentFeed({ cacheOnlyMode: setupCacheOnlyMode }).catch(() => null);
    }
    setDevLog({ cloudAccount: login.summary || login.output || '', login, buckets, secrets, deploy });
    setReleaseCheck("ok", "Cloud ready", deploy.latestUrl || deploy.workerUrl || "Cloudflare Worker ready", "The player feed URL is saved for this launcher.");
    showToast("Cloud setup complete", deploy.latestUrl || "Cloudflare Worker ready.", "success");
    return deploy;
  } catch (error) {
    const message = cleanErrorMessage(error);
    setDevLog(message);
    setReleaseCheck("bad", "Cloud setup failed", "Cloudflare is not ready", message);
    showToast("Cloud setup failed", message, "error");
    throw error;
  } finally {
    if (!keepBusy) setReleaseBusy(false);
  }
}

async function validateSelectedRelease(target = "stable") {
  await buildReleaseFromSelectedZip(target === "ptb" ? "Building PTB release" : "Building selected ZIP", target);
  const validation = await window.aht.devValidateRelease({
    outDir: developerOutDir(),
    publicLatestUrl: releaseFeedUrl(target),
    releaseTarget: target
  });
  const latestTitle = validation.latest
    ? `${displayPackName(validation.latest.name || "Pack")} ${validation.latest.version || ""}`.trim()
    : "No release metadata";
  if (!validation.ok) {
    const summary = validation.errors?.map((error) => error.label).join(", ") || "release validation failed";
    releaseValidationByTarget.delete(target);
    setDevLog(validation);
    setReleaseCheck("bad", "Release blocked", latestTitle, summary, target);
    throw new Error(`Release blocked: ${summary}`);
  }
  const cacheOnlyReason = cacheOnlyValidationBlockReason(validation);
  if (cacheOnlyReason) {
    releaseValidationByTarget.delete(target);
    setDevLog(validation);
    setReleaseCheck("bad", "Cache-only blocked", latestTitle, cacheOnlyReason, target);
    throw new Error(`Release blocked: ${cacheOnlyReason}`);
  }
  releaseValidationByTarget.set(target, { ok: true, outDir: releaseKey(target), result: validation });
  setDevLog(validation);
  setReleaseCheck((validation.warnings?.length || 0) ? "warn" : "ok", "Release ready", latestTitle, releaseSummary(validation), target);
  return validation;
}

async function publishSelectedRelease(target = "stable") {
  const reason = publishBlockReason(target);
  if (reason) {
    setReleaseCheck("bad", target === "ptb" ? "PTB upload blocked" : "Publish locked", "Release was not uploaded", reason, target);
    showToast(target === "ptb" ? "PTB publish locked" : "Publish locked", reason, "warn");
    return { ok: false, blocked: true, error: reason };
  }
  setReleaseBusy(true);
  let r2Result = null;
  try {
    await saveDeveloperSecrets();
    await window.aht.saveSettings(serializeSettings(), activeSidebarPack);
    if (!/^https?:\/\//i.test(releaseFeedUrl(target))) {
      await setupCloudForDeveloper({ keepBusy: true });
    }
    if (!/^https?:\/\//i.test(releaseFeedUrl(target))) {
      throw new Error("Cloud setup did not return a Player Feed URL.");
    }
    await validateSelectedRelease(target);
    const missingFastR2 = missingFastR2UploadFields();
    setReleaseCheck("warn", target === "ptb" ? "Uploading PTB" : "Uploading release", "Preflight passed", missingFastR2.length ? `Fast R2 upload needs ${missingFastR2.join(", ")}. Large releases will not use slow Wrangler fallback.` : "Fast direct R2 upload enabled with byte progress.", target);
    setReleaseUploadProgress({ percent: 0, phase: "Starting R2 upload" }, false, target);
    startUploadPolling();
    r2Result = await window.aht.devSyncR2({
      outDir: developerOutDir(),
      bucket: releaseBucketName(),
      publicLatestUrl: releaseFeedUrl(target),
      releaseTarget: target,
      r2AccountId: inputValue(els.r2AccountIdInput, ""),
      r2AccessKeyId: inputValue(els.r2AccessKeyIdInput, ""),
      r2SecretAccessKey: inputValue(els.r2SecretAccessKeyInput, "")
    });
    setReleaseCheck("warn", "Publishing GitHub mirror", target === "ptb" ? "Using modpack-ptb tag" : "Using modpack-stable tag", "R2 is verified. Uploading the exact ZIP and channel manifest to the separate GitHub release.", target);
    const github = await window.aht.devPublishModpackGithub({
      outDir: developerOutDir(),
      releaseTarget: target,
      githubRepo: inputValue(els.githubRepoInput, "svre-mc/aht-launcher"),
      githubBranch: inputValue(els.githubBranchInput, "main"),
      githubToken: inputValue(els.githubTokenInput, "")
    });
    const defaults = target === "stable"
      ? await writePlayerDefaultsForCurrentFeed().catch((error) => ({ error: cleanErrorMessage(error) }))
      : null;
    setDevLog({ r2: r2Result, github, playerDefaults: defaults });
    if (r2Result.validation?.ok) {
      releaseValidationByTarget.set(target, { ok: true, outDir: releaseKey(target), result: r2Result.validation });
      const feed = r2Result.verification?.publicLatestUrl ? ` Verified ${r2Result.verification.publicLatestUrl}.` : "";
      const defaultsLine = defaults?.written?.length ? ` Player defaults updated in ${defaults.written.length} location${defaults.written.length === 1 ? "" : "s"}.` : "";
      setReleaseCheck("ok", target === "ptb" ? "PTB published" : "Upload complete", r2Result.validation.latest ? `${displayPackName(r2Result.validation.latest.name)} ${r2Result.validation.latest.version}`.trim() : "Release uploaded", `${r2Result.uploaded?.length || 0} R2 objects uploaded.${feed} GitHub ${github.tagName} published.${defaultsLine}`, target);
    }
    showToast(target === "ptb" ? "PTB published" : "Update published", `${r2Result.uploaded?.length || 0} R2 objects and GitHub ${github.tagName} are ready.`, "success");
    return { ok: true, r2: r2Result, github, defaults };
  } catch (error) {
    const message = cleanErrorMessage(error);
    const uploadState = await window.aht.devUploadState().catch(() => null);
    if (uploadState) renderUploadState(uploadState);
    if (message.startsWith("Release blocked:")) {
      releaseValidationByTarget.delete(target);
    }
    setDevLog(message);
    const partial = Boolean(r2Result);
    setReleaseCheck("bad", partial ? "GitHub mirror failed" : (message.includes("Cache-only mode requires") ? "Cache-only blocked" : (message.startsWith("Release blocked:") ? "Upload blocked" : "Publish failed")), partial ? "R2 published; GitHub incomplete" : "Update was not published", message, target);
    showToast(partial ? "Publication incomplete" : "Publish failed", message, "error");
    return { ok: false, partial, error: message };
  } finally {
    setReleaseBusy(false);
  }
}

els.setupCloudButton.addEventListener("click", () => {
  setupCloudForDeveloper().catch(() => {});
});
els.writeDefaultsButton.addEventListener("click", () => {
  writeDefaultsFromDeveloperFeed().catch(() => {});
});
els.publishReleaseButton.addEventListener("click", () => {
  publishSelectedRelease("stable");
});
[els.packZipInput, els.clientModpackDirInput, els.clientZipVersionInput].filter(Boolean).forEach((input) => {
  input.addEventListener("input", () => invalidateReleaseValidation());
  input.addEventListener("change", () => invalidateReleaseValidation());
});
[els.ptbPackZipInput, els.ptbClientModpackDirInput, els.ptbClientZipVersionInput].filter(Boolean).forEach((input) => {
  input.addEventListener("input", () => invalidateReleaseValidation("PTB ready", "PTB uses its own R2 prefix and GitHub release tags.", "ptb"));
  input.addEventListener("change", () => invalidateReleaseValidation("PTB ready", "PTB uses its own R2 prefix and GitHub release tags.", "ptb"));
});
[els.playerFeedUrlInput, els.curseforgeApiKeyInput, els.launcherProofSecretInput, els.socialServerSecretInput, els.cacheOnlyInput, els.outDirInput, els.cacheModsInput, els.baseUrlInput, els.r2AccountIdInput, els.r2AccessKeyIdInput, els.r2SecretAccessKeyInput].filter(Boolean).forEach((input) => {
  const invalidateBoth = () => {
    invalidateReleaseValidation();
    invalidateReleaseValidation("PTB ready", "PTB uses its own R2 prefix and GitHub release tags.", "ptb");
  };
  input.addEventListener("input", invalidateBoth);
  input.addEventListener("change", invalidateBoth);
});
if (els.curseforgeApiKeyInput) {
  els.curseforgeApiKeyInput.addEventListener("input", queueDeveloperSecretSave);
  els.curseforgeApiKeyInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.serverPasswordInput) {
  els.serverPasswordInput.addEventListener("input", queueDeveloperSecretSave);
  els.serverPasswordInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.launcherProofSecretInput) {
  els.launcherProofSecretInput.addEventListener("input", queueDeveloperSecretSave);
  els.launcherProofSecretInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.socialServerSecretInput) {
  els.socialServerSecretInput.addEventListener("input", queueDeveloperSecretSave);
  els.socialServerSecretInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.githubTokenInput) {
  els.githubTokenInput.addEventListener("input", queueDeveloperSecretSave);
  els.githubTokenInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.r2AccountIdInput) {
  els.r2AccountIdInput.addEventListener("input", queueDeveloperSecretSave);
  els.r2AccountIdInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.r2AccessKeyIdInput) {
  els.r2AccessKeyIdInput.addEventListener("input", queueDeveloperSecretSave);
  els.r2AccessKeyIdInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.r2SecretAccessKeyInput) {
  els.r2SecretAccessKeyInput.addEventListener("input", queueDeveloperSecretSave);
  els.r2SecretAccessKeyInput.addEventListener("change", () => {
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.generateProofSecretButton) {
  els.generateProofSecretButton.addEventListener("click", () => {
    setInputValue(els.launcherProofSecretInput, generateLauncherProofSecret());
    invalidateReleaseValidation("Proof secret generated", "Save or run cloud setup, then set the same secret on the server.");
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
if (els.generateSocialSecretButton) {
  els.generateSocialSecretButton.addEventListener("click", () => {
    setInputValue(els.socialServerSecretInput, generateLauncherProofSecret());
    invalidateReleaseValidation("Server social secret generated", "Save or run cloud setup, then set the same secret on the server.");
    saveDeveloperSecrets().catch((error) => setDevLog(cleanErrorMessage(error)));
  });
}
els.bucketInput.addEventListener("input", () => {
  updateReleaseUploadState();
});

installPointerLighting();
void loadLegalGate();
refresh().catch((error) => {
  const message = cleanErrorMessage(error);
  setBadge("Error", "bad");
  setLog(message);
  setUnavailable(els.playButton, false);
  els.playButton.title = "Run the launch checks and create a support report if anything fails.";
  showToast("Launcher error", message, "error", {
    context: "play:start",
    packKey: activeSidebarPack,
    copyLabel: "Click here to copy"
  });
});

window.addEventListener("focus", () => {
  if (Date.now() - lastStatusRefreshAt > 5000) {
    refreshQuietly();
  }
});

window.setInterval(() => {
  refreshQuietly();
}, 60_000);
