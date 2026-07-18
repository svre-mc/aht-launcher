const { contextBridge, ipcRenderer } = require('electron');

function developerApiAllowed() {
  try {
    return new URLSearchParams(window.location.search || '').get('mode') === 'developer';
  } catch {
    return false;
  }
}

const playerApi = {
  getStatus: (packKey = 'aht') => ipcRenderer.invoke('status:get', { packKey }),
  copyErrorReport: (payload) => ipcRenderer.invoke('diagnostics:copyErrorReport', payload || {}),
  saveSettings: (config, packKey = 'aht') => ipcRenderer.invoke('settings:save', { config, packKey }),
  testFeed: (config, packKey = 'aht') => ipcRenderer.invoke('settings:testFeed', { config, packKey }),
  startUpdate: (payload) => ipcRenderer.invoke('update:start', typeof payload === 'object' && payload ? payload : { forceRepair: Boolean(payload) }),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  startLauncherUpdate: () => ipcRenderer.invoke('launcher:updateStart'),
  restartLauncherUpdate: () => ipcRenderer.invoke('launcher:updateRestart'),
  getLauncherUpdateState: () => ipcRenderer.invoke('launcher:updateState'),
  scanFiles: (packKey = 'aht') => ipcRenderer.invoke('files:scan', { packKey }),
  scanChanges: (packKey = 'aht') => ipcRenderer.invoke('changes:scan', { packKey }),
  syncChanges: (packKey = 'aht') => ipcRenderer.invoke('changes:sync', { packKey }),
  accountRegister: (username) => ipcRenderer.invoke('account:register', username),
  legalStatus: () => ipcRenderer.invoke('legal:status'),
  legalAccept: (payload) => ipcRenderer.invoke('legal:accept', payload || {}),
  appExit: () => ipcRenderer.invoke('app:exit'),
  socialList: () => ipcRenderer.invoke('social:list'),
  socialAction: (payload) => ipcRenderer.invoke('social:action', payload || {}),
  play: (packKey = 'aht') => ipcRenderer.invoke('play:start', { packKey }),
  setupRecommend: () => ipcRenderer.invoke('setup:recommend'),
  setupApply: () => ipcRenderer.invoke('setup:apply'),
  selectJson: () => ipcRenderer.invoke('dialog:json'),
  selectZip: () => ipcRenderer.invoke('dialog:zip'),
  selectFolder: (defaultPath = '') => ipcRenderer.invoke('dialog:folder', defaultPath),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target)
};

const developerApi = {
  devBuildClientZip: (payload) => ipcRenderer.invoke('dev:buildClientZip', payload),
  devBuildRelease: (payload) => ipcRenderer.invoke('dev:buildRelease', payload),
  devInspectPackZip: (packZip) => ipcRenderer.invoke('dev:inspectPackZip', packZip),
  devValidateRelease: (payload) => ipcRenderer.invoke('dev:validateRelease', payload),
  devCloudLogin: (payload) => ipcRenderer.invoke('dev:cloudLogin', payload),
  devCloudSetupBuckets: (payload) => ipcRenderer.invoke('dev:cloudSetupBuckets', payload),
  devCloudSetupSecrets: (payload) => ipcRenderer.invoke('dev:cloudSetupSecrets', payload),
  devCloudDeployWorker: (payload) => ipcRenderer.invoke('dev:cloudDeployWorker', payload),
  devCloudPreflight: (payload) => ipcRenderer.invoke('dev:cloudPreflight', payload),
  devWritePlayerDefaults: (payload) => ipcRenderer.invoke('dev:writePlayerDefaults', payload),
  devSyncR2: (payload) => ipcRenderer.invoke('dev:syncR2', payload),
  devPublishModpackGithub: (payload) => ipcRenderer.invoke('dev:publishModpackGithub', payload),
  devFindLauncherBuilds: () => ipcRenderer.invoke('dev:findLauncherBuilds'),
  devSyncLauncherUpdate: (payload) => ipcRenderer.invoke('dev:syncLauncherUpdate', payload),
  devCheckLauncherWorkflow: (payload) => ipcRenderer.invoke('dev:checkLauncherWorkflow', payload),
  devDispatchLauncherWorkflow: (payload) => ipcRenderer.invoke('dev:dispatchLauncherWorkflow', payload),
  devDeployLauncher: (payload) => ipcRenderer.invoke('dev:deployLauncher', payload),
  devLauncherDeployState: () => ipcRenderer.invoke('dev:launcherDeployState'),
  devUploadState: () => ipcRenderer.invoke('dev:uploadState'),
  devPlanServerTransfer: (payload) => ipcRenderer.invoke('dev:planServerTransfer', payload),
  devSaveServerTransfer: (payload) => ipcRenderer.invoke('dev:saveServerTransfer', payload),
  devSyncServerFiles: (payload) => ipcRenderer.invoke('dev:syncServerFiles', payload),
  devServerTransferState: () => ipcRenderer.invoke('dev:serverTransferState'),
  devGetSecrets: () => ipcRenderer.invoke('dev:getSecrets'),
  devSaveSecrets: (payload) => ipcRenderer.invoke('dev:saveSecrets', payload),
  devLogin: (payload) => ipcRenderer.invoke('dev:login', payload),
  devSummary: () => ipcRenderer.invoke('dev:summary'),
  devEvents: (limit) => ipcRenderer.invoke('dev:events', limit),
  devLauncherDownloads: (payload) => ipcRenderer.invoke('dev:launcherDownloads', payload || {}),
  devPlayerIpv4Groups: () => ipcRenderer.invoke('dev:playerIpv4Groups'),
  devUpdateLogs: (limit) => ipcRenderer.invoke('dev:updateLogs', limit),
  devPublishUpdateLog: (payload) => ipcRenderer.invoke('dev:publishUpdateLog', payload)
};

const api = { ...playerApi };
if (developerApiAllowed()) {
  Object.assign(api, developerApi);
}

contextBridge.exposeInMainWorld('aht', api);
