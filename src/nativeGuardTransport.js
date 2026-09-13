import net from 'node:net';
import { spawn } from 'node:child_process';

const failure = (message, code) => Object.assign(new Error(message), { code });

/** One bounded line over loopback, with an absolute (not reset-on-data) deadline. */
export function readNativeGuardLine(port, requestLine, maximumBytes = 16 * 1024, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(failure('Phoenix Anti-cheat response timed out.', 'PHOENIX_PROBE_TIMEOUT')), timeoutMs);
    try { socket = net.connect({ host: '127.0.0.1', port }); }
    catch (error) { finish(error); return; }
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(`${requestLine}\n`));
    socket.on('data', data => {
      size += data.length;
      if (size > maximumBytes) return finish(failure('Phoenix Anti-cheat response too large.', 'PHOENIX_PROBE_INVALID'));
      chunks.push(data);
      const bytes = Buffer.concat(chunks, size);
      const end = bytes.indexOf(10);
      if (end >= 0) finish(null, bytes.subarray(0, end).toString('utf8'));
    });
    socket.on('end', () => finish(failure('Phoenix Anti-cheat closed before responding.', 'PHOENIX_PROBE_CLOSED')));
    socket.on('close', () => finish(failure('Phoenix Anti-cheat connection closed.', 'PHOENIX_PROBE_CLOSED')));
  });
}

/** Starts only the verified binary and consumes one authenticated startup descriptor. */
export async function startNativeGuardProcess({ binary, gameDir, javaPath, launcherPid, launcherSessionId, validateDescriptor,
  timeoutMs = 8000 }) {
  const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  try {
    const descriptor = await new Promise((resolve, reject) => {
      let done = false;
      let size = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdin.off('error', onError);
        child.stdout.off('data', onData);
        error ? reject(error) : resolve(value);
      };
      const onError = error => finish(error);
      const onExit = () => finish(failure('Phoenix Anti-cheat stopped during startup.', 'PHOENIX_START_FAILED'));
      const onData = data => {
        size += data.length;
        if (size > 4096) return finish(failure('Phoenix Anti-cheat startup response too large.', 'PHOENIX_START_INVALID'));
        chunks.push(data);
        const bytes = Buffer.concat(chunks, size);
        const end = bytes.indexOf(10);
        if (end < 0) return;
        try {
          const info = validateDescriptor(JSON.parse(bytes.subarray(0, end).toString('utf8')));
          if (info.launcherPid !== launcherPid || info.launcherSessionId !== launcherSessionId || info.guardPid !== child.pid) {
            throw failure('Phoenix Anti-cheat startup identity mismatch.', 'PHOENIX_START_INVALID');
          }
          finish(null, info);
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(failure('Phoenix Anti-cheat startup timed out.', 'PHOENIX_START_TIMEOUT')), timeoutMs);
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
      // Drain only; native diagnostics and session material do not become public errors.
      child.stderr.resume();
      child.stdin.on('error', onError);
      child.stdin.end(`${JSON.stringify({ gameDir, javaPath, launcherPid, launcherSessionId })}\n`);
    });
    // Keep harmless terminal error handlers after the startup promise settles.
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return { descriptor, child };
  } catch (error) {
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.kill();
    throw error;
  }
}
