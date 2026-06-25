const els = {
  badge: document.querySelector('#badge'),
  versionLine: document.querySelector('#versionLine'),
  instanceDir: document.querySelector('#instanceDir'),
  installedVersion: document.querySelector('#installedVersion'),
  latestVersion: document.querySelector('#latestVersion'),
  updateButton: document.querySelector('#updateButton'),
  repairButton: document.querySelector('#repairButton'),
  playButton: document.querySelector('#playButton'),
  log: document.querySelector('#log')
};

let polling = null;

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

function setBadge(text, state) {
  els.badge.textContent = text;
  els.badge.className = `badge ${state || ''}`.trim();
}

async function refreshStatus() {
  const status = await requestJson('/api/status');
  els.versionLine.textContent = `${status.name} ${status.latestVersion}`;
  els.instanceDir.textContent = status.instanceDir;
  els.installedVersion.textContent = status.installedVersion || 'Not installed';
  els.latestVersion.textContent = status.latestVersion;
  els.updateButton.disabled = !status.updateRequired;
  els.playButton.disabled = status.updateRequired || !status.playConfigured;
  setBadge(status.updateRequired ? 'Update required' : 'Ready', status.updateRequired ? 'warn' : 'ok');
}

async function refreshLog() {
  const update = await requestJson('/api/update-log');
  if (update.lastUpdate?.lines) {
    const lines = [...update.lastUpdate.lines];
    if (update.lastUpdate.error) {
      lines.push(`ERROR: ${update.lastUpdate.error}`);
    }
    if (update.lastUpdate.result) {
      lines.push(`Installed ${update.lastUpdate.result.installed.version}`);
    }
    els.log.textContent = lines.join('\n');
  }
  if (!update.running && polling) {
    clearInterval(polling);
    polling = null;
    await refreshStatus();
  }
}

async function startUpdate(forceRepair = false) {
  els.updateButton.disabled = true;
  els.repairButton.disabled = true;
  els.playButton.disabled = true;
  setBadge(forceRepair ? 'Repairing' : 'Updating', 'warn');
  els.log.textContent = '';
  await requestJson('/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRepair })
  });
  polling = setInterval(refreshLog, 1000);
  await refreshLog();
}

els.updateButton.addEventListener('click', () => startUpdate(false).catch((error) => {
  els.log.textContent = error.message;
}));

els.repairButton.addEventListener('click', () => startUpdate(true).catch((error) => {
  els.log.textContent = error.message;
}));

els.playButton.addEventListener('click', async () => {
  try {
    await requestJson('/api/play', { method: 'POST' });
  } catch (error) {
    els.log.textContent = error.message;
  }
});

refreshStatus().catch((error) => {
  setBadge('Config error', 'warn');
  els.log.textContent = error.message;
});
