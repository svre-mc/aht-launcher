import fs from 'node:fs/promises';
import path from 'node:path';

// Older published packs reference this logo after replacing the original artwork.
export async function ensureModDirectorIcon(instanceDir) {
  const configPath = path.join(instanceDir, 'config', 'mod-director', 'modpack.json');
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const expected = 'config/itlt/RLCraft_Dregora_Logo_FINAL.png';
  if (config?.icon?.path?.replaceAll('\\', '/') !== expected) return false;
  const target = path.join(instanceDir, expected);
  try { await fs.lstat(target); return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = path.join(instanceDir, 'config', 'itlt', 'icon256x256.png');
  const bytes = await fs.readFile(source);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw new Error('The installed Minecraft pack logo is damaged. Run Repair.');
  try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return true;
}
