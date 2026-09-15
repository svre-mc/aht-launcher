import path from 'node:path';
import { readJsonFile } from './utils.js';

// A profile's earlier javaRuntime result is not proof that its executable still
// exists. The final Repair gate must execute the selected Java again.
export async function verifyRepairedJava({ runtime, profile, memoryMb, probe }) {
  if (!runtime?.usable || !runtime.path) {
    throw new Error(`Repair could not verify Java 8: ${runtime?.reason || 'Java executable was not found.'}`);
  }
  const selected = profile?.javaPath || runtime.path;
  const checked = await probe(selected, memoryMb, { reuseCachedProbe: false });
  if (!checked?.usable || !checked.javaPath || !checked.heapReady) {
    throw new Error('Repair could not start the selected Java 8 runtime.');
  }
  return { ...runtime, ...checked, path: checked.javaPath };
}

export async function prepareRuntimeOnlyRepair({ instanceDir, latest, scan, repair }) {
  const installed = await readJsonFile(path.join(instanceDir, '.aht-launcher', 'installed.json')).catch(error => {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  });
  if (!installed?.packId || installed.packId !== latest?.packId || installed.version !== latest?.version) {
    if (repair) return repair();
    throw new Error('The modpack has an update available. Run Update before repairing its Minecraft runtime.');
  }
  const integrity = await scan();
  if (!integrity?.valid || !integrity.counts?.managed || Number(integrity.counts.corrupted || 0) !== 0) {
    if (repair) return repair();
    throw new Error('Modpack files changed during the scan. Click Repair again to repair those files too.');
  }
  return { installed, runtimeOnly: true };
}

// Repair the installation without starting a game-scoped helper or issuing a
// Play token. Existing consent is required and the repaired bytes are rechecked.
export async function repairPhoenixInstallation({ getStatus, install }) {
  let status = await getStatus();
  if (!status.required) return status;
  if (!status.consented) {
    throw Object.assign(new Error('Accept the Phoenix Anti-cheat installation before playing.'),
      { code: 'PHOENIX_ANTICHEAT_REQUIRED' });
  }
  if (!status.valid) {
    await install(status.consentAcceptedAt);
    status = await getStatus();
  }
  if (!status.valid || !status.consented) {
    throw new Error('Phoenix Anti-cheat could not be repaired. Check its installation before playing.');
  }
  return status;
}
