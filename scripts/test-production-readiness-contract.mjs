import fs from 'node:fs';

const source = fs.readFileSync(new URL('./check-production-readiness.mjs', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const liveMutateFlag = "const liveMutatingChecks = args.has('--live-mutate');";
assert(source.includes(liveMutateFlag), 'production readiness must require an explicit --live-mutate flag for mutating live checks');
assert(source.includes('liveMutatingChecks,'), 'production readiness JSON report must expose whether live mutating checks ran');
assert(source.includes('skipped read-only run; pass --live-mutate'), 'read-only readiness runs must describe skipped mutating proof checks');
assert(source.includes('production-readiness-latest.json') && source.includes('function writeLatestReport') && source.includes('writeLatestReport(report);'), 'production readiness must write a durable latest JSON report for every run');

const functionDeclaration = 'function liveLauncherProofStatus(baseUrl)';
const proofCall = 'const proofStatus = liveLauncherProofStatus(proofBaseUrl);';
const declarationIndex = source.indexOf(functionDeclaration);
const callIndex = source.indexOf(proofCall);
assert(declarationIndex >= 0, 'live launcher proof helper declaration is missing');
assert(callIndex > declarationIndex, 'live launcher proof helper call is missing or appears before declaration');

const guardIndex = source.lastIndexOf('if (liveMutatingChecks) {', callIndex);
assert(guardIndex >= 0, 'live launcher proof helper call must be guarded by liveMutatingChecks');
const guardBlock = source.slice(guardIndex, callIndex + proofCall.length);
assert(!guardBlock.includes('} else {'), 'live launcher proof helper call must be inside the liveMutatingChecks true branch');

const liveProofReferences = [...source.matchAll(/liveLauncherProofStatus\(/g)].map((match) => match.index);
assert(liveProofReferences.length === 2, `live launcher proof helper should only appear in its declaration and guarded call, found ${liveProofReferences.length}`);

const runFunctionIndex = source.indexOf('function run()');
const mutatingCallInRun = source.indexOf(proofCall, runFunctionIndex);
assert(mutatingCallInRun === -1, 'run() must not directly call the mutating launcher proof helper');

console.log('Production readiness default path is read-only; live proof POST checks are opt-in.');
