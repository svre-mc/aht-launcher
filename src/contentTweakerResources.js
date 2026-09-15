// ContentTweaker creates default blockstates when a registered block has none.
// Those files must be included in the release's trusted manifest, or every game
// start recreates an unexpected protected file after an otherwise clean Repair.
export function contentTweakerBlockstates(script = '') {
  const code = script.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith('//') || token.startsWith('/*') ? ' ' : token);
  if (!/^\s*#loader\s+contenttweaker\b/m.test(code)) return [];
  const paths = new Set();
  for (const match of code.matchAll(/\b(?:val|var)\s+(\w+)\s*=\s*VanillaFactory\s*\.\s*createBlock\s*\(\s*(["'])([a-z0-9_]+)\2\s*,/g)) {
    if (new RegExp(`\\b${match[1]}\\s*\\.\\s*register\\s*\\(`).test(code)) {
      paths.add(`resources/contenttweaker/blockstates/${match[3]}.json`);
    }
  }
  return [...paths];
}

export async function validateContentTweakerResources(files, readText) {
  const paths = new Set(files);
  const missing = new Set();
  for (const file of paths) {
    if (!file.startsWith('scripts/') || !file.endsWith('.zs')) continue;
    for (const resource of contentTweakerBlockstates(await readText(file))) {
      if (!paths.has(resource)) missing.add(resource);
    }
  }
  if (missing.size) {
    throw new Error(`Client pack is missing ContentTweaker blockstates: ${[...missing].sort().join(', ')}. Include these resources before building; Minecraft would recreate them and trigger Repair again.`);
  }
}
