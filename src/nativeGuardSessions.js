import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Explicitly process-local; shared by hot imports, never written to an instance file.
const key = Symbol.for('aht.phoenix.runtime-state.v2');
export const nativeGuardSessions = globalThis[key] ||= {
  sessions: new Map(), pending: new Map(), launcherSessionId: randomBytes(16).toString('hex')
};

export function nativeGuardSessionKey({ gameDir, javaPath = '', binaryPath, binaryHash, launcherPid, launcherSessionId, platform }) {
  const normalized = value => {
    const resolved = value ? path.resolve(value) : '';
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return JSON.stringify([normalized(gameDir), normalized(javaPath), normalized(binaryPath), binaryHash, launcherPid, launcherSessionId]);
}
