import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Portable state/transport fixtures only. Native processes, Electron UI, real
// account ownership, and Forge admission remain separate explicit test stages.
export const backendTests = Object.freeze([
  'account-recovery-lifecycle', 'recovery-result-channel', 'recovery-profile-preservation',
  'account-registration-coordinator', 'launcher-identity-store', 'account-identity-state',
  'account-status-refresh', 'status-account-boundary', 'service-transport',
  'minecraft-registration-service', 'minecraft-recovery-deadline', 'modern-account-recovery',
  'proof-service-boundary', 'launcher-proof-transactions', 'proof-transaction-boundary',
  'phoenix-install-lifecycle', 'phoenix-recovery', 'phoenix-monitor', 'phoenix-monitor-boundary',
  'native-guard-deadlines', 'sidebar-hidden-readiness', 'developer-admin-service', 'developer-service-boundary',
  'java-archive-boundary', 'account-retry-credential-cache', 'bounded-json-portability', 'worker-entrypoint',
  'minecraft-session-identity', 'minecraft-session-main-boundary'
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  ...backendTests.map(name => `scripts/test-${name}.mjs`)], {
  cwd: root, stdio: 'inherit', windowsHide: true, timeout: 180000
});
if (result.error) console.error(`Backend test execution failed: ${result.error.code || 'unavailable'}`);
process.exitCode = result.status ?? 1;
