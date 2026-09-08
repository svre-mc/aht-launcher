import path from 'node:path';
import { readJsonFile } from './utils.js';

export const RUNTIME_REPAIR_BUILD = 'Runtime Repair 2';

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

export async function prepareRuntimeOnlyRepair({ instanceDir, latest, scan }) {
  const installed = await readJsonFile(path.join(instanceDir, '.aht-launcher', 'installed.json'));
  if (!installed?.packId || installed.packId !== latest?.packId || installed.version !== latest?.version) {
    throw new Error('The modpack has an update available. Run Update before repairing its Minecraft runtime.');
  }
  const integrity = await scan();
  if (!integrity?.valid || !integrity.counts?.managed || Number(integrity.counts.corrupted || 0) !== 0) {
    throw new Error('Modpack files changed during the scan. Click Repair again to repair those files too.');
  }
  return { installed, runtimeOnly: true };
}
