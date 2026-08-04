import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LAUNCH_LOG_FOLDER = path.join('logs', 'launcher');
export const LAUNCH_LOG_FILE_PREFIX = 'AHT-Launch-';
export const LAUNCH_LOG_RETENTION = 30;

const REQUIREMENTS = [
  ['instance', 'AHT instance folder'],
  ['installed', 'Installed AHT manifest'],
  ['releaseFeed', 'AHT release service'],
  ['integrity', 'Managed modpack files'],
  ['java8', '64-bit Java 8'],
  ['minecraftProfile', 'AHT Minecraft profile'],
  ['minecraftRuntime', 'Minecraft 1.12.2 and Forge files'],
  ['launcherProof', 'AHT launcher session proof'],
  ['minecraftLauncher', 'Minecraft Launcher application']
];

function bounded(value, max = 500) {
  const text = String(value ?? '')
    .replace(/\r\n?|\n/g, ' | ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function sanitizeDiagnosticText(value = '', max = 500) {
  const secretName = '(?:access[-_]?token|client[-_]?token|identity[-_]?token|refresh[-_]?token|session[-_]?token|api[-_]?key|client[-_]?secret|password|secret|signature|proof|token|key)';
  const secretValue = '(?:"[^"\\r\\n]*(?:"|$)|\'[^\'\\r\\n]*(?:\'|$)|[^\\s,;&}]+)';
  return String(value ?? '').replace(/\0/g, '').trim()
    .replace(new RegExp(`(--${secretName}(?:\\s+|\\s*=\\s*))${secretValue}`, 'gi'), '$1<redacted>')
    .replace(new RegExp(`((?:["']?)${secretName}(?:["']?)\\s*[:=]\\s*)${secretValue}`, 'gi'), '$1<redacted>')
    .replace(/(Authorization\s*:\s*)[^\r\n]*/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-token>')
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://<credentials>@')
    .replace(/\r\n?|\n/g, ' | ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .slice(0, max)
    .trim();
}

function newRequirementState() {
  return Object.fromEntries(REQUIREMENTS.map(([key, label]) => [key, {
    key,
    label,
    status: 'NOT CHECKED',
    detail: ''
  }]));
}

export function createLaunchAttempt(options = {}) {
  const startedAt = options.startedAt || new Date().toISOString();
  return {
    schemaVersion: 1,
    attemptId: options.attemptId || crypto.randomUUID(),
    startedAt,
    finishedAt: '',
    result: 'IN PROGRESS',
    app: {
      name: bounded(options.appName || 'A Hard Time Launcher', 80),
      version: bounded(options.appVersion || '', 40),
      mode: bounded(options.mode || 'player', 20),
      packaged: Boolean(options.packaged)
    },
    pack: {
      id: bounded(options.packId || '', 80),
      name: bounded(options.packName || 'A Hard Time', 80),
      channel: bounded(options.channel || 'stable', 24),
      installedVersion: '',
      latestVersion: ''
    },
    instanceDir: bounded(options.instanceDir || '', 500),
    minecraftRoot: bounded(options.minecraftRoot || '', 500),
    steps: [],
    requirements: newRequirementState(),
    system: null,
    minecraftSignals: [],
    error: null,
    reportPath: ''
  };
}

export function setLaunchRequirement(attempt, key, status, detail = '') {
  if (!attempt?.requirements?.[key]) return;
  attempt.requirements[key] = {
    ...attempt.requirements[key],
    status: ['PASS', 'FAIL', 'WARN', 'NOT CHECKED'].includes(status) ? status : 'NOT CHECKED',
    detail: sanitizeDiagnosticText(detail, 500)
  };
}

export function beginLaunchStep(attempt, key, label, detail = '') {
  const step = {
    number: attempt.steps.length + 1,
    key: bounded(key, 60),
    label: bounded(label, 120),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    durationMs: 0,
    detail: sanitizeDiagnosticText(detail, 500)
  };
  attempt.steps.push(step);
  return step;
}

export function finishLaunchStep(step, status = 'PASS', detail = '') {
  if (!step) return;
  step.status = status === 'FAIL' ? 'FAIL' : (status === 'WARN' ? 'WARN' : 'PASS');
  step.finishedAt = new Date().toISOString();
  step.durationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt));
  if (detail) step.detail = sanitizeDiagnosticText(detail, 500);
}

export async function runLaunchStep(attempt, key, label, action, describe = null) {
  const step = beginLaunchStep(attempt, key, label);
  try {
    const result = await action();
    const described = typeof describe === 'function' ? describe(result) : describe;
    const status = described && typeof described === 'object' ? described.status : 'PASS';
    const detail = described && typeof described === 'object' ? described.detail : described;
    finishLaunchStep(step, status || 'PASS', detail || 'Completed.');
    return result;
  } catch (error) {
    finishLaunchStep(step, 'FAIL', error?.message || error || 'Step failed.');
    throw error;
  }
}

export function completeLaunchAttempt(attempt, result, error = null) {
  attempt.finishedAt = new Date().toISOString();
  attempt.result = result === 'HANDOFF CONFIRMED'
    ? 'HANDOFF CONFIRMED'
    : (result === 'DIAGNOSTIC' ? 'DIAGNOSTIC' : 'FAILED');
  if (error) {
    attempt.error = {
      name: sanitizeDiagnosticText(error.name || 'Error', 80),
      code: sanitizeDiagnosticText(error.code || '', 80),
      message: sanitizeDiagnosticText(error.message || error, 1200)
    };
  }
  for (const step of attempt.steps) {
    if (step.status === 'RUNNING') finishLaunchStep(step, 'WARN', 'The launch stopped before this step finished.');
  }
  return attempt;
}

function failedStep(attempt) {
  return [...(attempt?.steps || [])].reverse().find((step) => step.status === 'FAIL') || null;
}

function diagnoseFailedRequirement(attempt) {
  const failed = Object.entries(attempt?.requirements || {}).find(([, item]) => item?.status === 'FAIL');
  if (!failed) return null;
  const [key] = failed;
  const diagnoses = {
    instance: ['The selected AHT instance folder is missing or unavailable.', ['Run Update in the AHT Launcher to restore the selected instance.', 'Do not delete saves or playerdata.']],
    installed: ['The AHT installation is incomplete or its installed manifest cannot be read.', ['Run Update or Repair in the AHT Launcher.', 'Keep the launcher open until verification completes.']],
    releaseFeed: ['The AHT release service is not configured or could not be checked.', ['Check the internet connection and try again.', 'Allow A Hard Time Launcher through firewall or security software if needed.']],
    integrity: ['One or more managed AHT files are missing or damaged.', ['Run Repair in the AHT Launcher.', 'Do not manually delete saves, playerdata, or configuration folders.']],
    java8: ['A usable 64-bit Java 8 runtime was not detected.', ['Enable AHT-managed Adoptium Java 8 in Launcher Settings.', 'Run Update once, then try Play again.']],
    minecraftProfile: ['The exact AHT Minecraft Launcher profile is missing or incomplete.', ['Close Minecraft Launcher.', 'Run Update or Repair in the AHT Launcher.']],
    minecraftRuntime: ['Required Minecraft 1.12.2 or Forge files are missing or incomplete.', ['Close Minecraft Launcher.', 'Run Update or Repair in the AHT Launcher.']],
    launcherProof: ['A valid AHT launcher session proof is not available.', ['Check the internet connection and Minecraft username.', 'Try Play again to request a fresh proof.']],
    minecraftLauncher: ['Minecraft Launcher could not be located or verified.', ['Open Minecraft Launcher once from Applications or the Windows Start menu, then close it.', 'Try Play in the AHT Launcher again.']]
  };
  const diagnosis = diagnoses[key];
  return diagnosis ? { cause: diagnosis[0], actions: diagnosis[1] } : null;
}

function diagnoseMinecraftSignals(attempt) {
  const signals = (Array.isArray(attempt?.minecraftSignals) ? attempt.minecraftSignals : []).join('\n');
  if (!signals.trim()) return null;
  if (/No libraries\?!|NoClassDefFoundError|ClassNotFoundException|missing librar/i.test(signals)) {
    return {
      cause: 'Minecraft or Forge stopped because a required library or class is missing.',
      actions: ['Close Minecraft Launcher.', 'Run Repair in the AHT Launcher, then try Play again.']
    };
  }
  if (/UnsupportedClassVersionError|Usage:\s*javaw|not a supported Java|Java version mismatch/i.test(signals)) {
    return {
      cause: 'Minecraft was started with an incompatible Java runtime.',
      actions: ['Open Launcher Settings and enable AHT-managed Adoptium Java 8.', 'Run Update once, then try Play again.']
    };
  }
  if (/OutOfMemoryError|Could not reserve enough space|insufficient memory/i.test(signals)) {
    return {
      cause: 'Minecraft or Java could not reserve enough usable memory on this PC.',
      actions: ['Close memory-heavy applications before launching.', 'Confirm the PC has enough free memory for the configured AHT allocation, then retry.']
    };
  }
  if (/EXCEPTION_ACCESS_VIOLATION|problematic frame/i.test(signals)) {
    return {
      cause: 'Java stopped in native code, commonly because of a graphics driver, overlay, or injected application.',
      actions: ['Update the graphics driver from the GPU manufacturer.', 'Close game overlays or recording tools, then retry.']
    };
  }
  if (/Process crashed|exit code|crash report/i.test(signals)) {
    return {
      cause: 'Minecraft exited after the AHT Launcher completed the handoff, but the available launcher signal does not contain the exact Forge failure.',
      actions: ['Send this report with the displayed Minecraft exit code.', 'If a new crash report appears, include it without deleting any AHT files.']
    };
  }
  return null;
}

export function diagnoseLaunchFailure(attempt) {
  if (attempt?.result === 'HANDOFF CONFIRMED') {
    const minecraftFailure = diagnoseMinecraftSignals(attempt);
    if (minecraftFailure) return minecraftFailure;
    return {
      cause: 'The AHT Launcher completed its handoff to a verified Minecraft Launcher window.',
      actions: [
        'If Minecraft later exits after you click Play in the Minecraft Launcher, send this report together with the displayed exit code.',
        'Use Copy launch diagnostics again after the exit so the latest Mojang Launcher signals are included.'
      ]
    };
  }
  if (attempt?.result === 'DIAGNOSTIC') {
    const requirementFailure = diagnoseFailedRequirement(attempt);
    if (requirementFailure) return requirementFailure;
    const minecraftFailure = diagnoseMinecraftSignals(attempt);
    if (minecraftFailure) return minecraftFailure;
    return {
      cause: 'This is a manual diagnostic snapshot. No new launch was attempted.',
      actions: ['Send this report with a short description of what happened after you clicked Play.']
    };
  }

  const step = failedStep(attempt);
  const key = step?.key || '';
  const message = `${step?.detail || ''} ${attempt?.error?.message || ''}`;
  if (key === 'load-config') {
    return {
      cause: 'The launcher settings could not be read.',
      actions: ['Restart the AHT Launcher.', 'If it fails again, send this report before changing or deleting any AHT folders.']
    };
  }
  if (key === 'installed-manifest' || /Installed manifest|Install the pack|Installed pack .* does not match/i.test(message)) {
    return {
      cause: 'The selected AHT installation is incomplete, damaged, or belongs to the wrong release channel.',
      actions: ['Open the AHT Launcher and run Update or Repair for the selected pack.', 'Keep the launcher open until verification completes, then try Play again.']
    };
  }
  if (/Update required\.\s*Installed|installed version .* latest version|out of date/i.test(message)) {
    return {
      cause: 'The installed AHT pack version is out of date.',
      actions: ['Run Update for the selected AHT pack.', 'Keep the launcher open until verification completes, then try Play again.']
    };
  }
  if (key === 'release-feed' || /Release feed|latest\.json|fetch|network/i.test(message)) {
    return {
      cause: 'The launcher could not reach or validate the AHT release service.',
      actions: ['Check the internet connection and try again.', 'Allow A Hard Time Launcher through firewall or security software if it is being blocked.']
    };
  }
  if (key === 'integrity' || /Repair required|corrupt|mod file issue/i.test(message)) {
    return {
      cause: 'One or more managed modpack files are missing or do not match the published AHT pack.',
      actions: ['Run Repair in the AHT Launcher.', 'Do not manually delete saves, playerdata, or configuration folders.']
    };
  }
  if (key === 'java-profile-check' || /Java 8|javaw|64-bit Java/i.test(message)) {
    return {
      cause: 'A usable 64-bit Java 8 runtime was not available to the Minecraft profile.',
      actions: ['Open Launcher Settings and enable AHT-managed Adoptium Java 8.', 'Run Update once, then try Play again.']
    };
  }
  if (key === 'launcher-proof' || /proof|registered to this launcher/i.test(message)) {
    return {
      cause: 'The launcher could not create a valid AHT session proof for this installation.',
      actions: ['Confirm the Minecraft username in the AHT Launcher matches the signed-in Minecraft account.', 'Check the internet connection and try again.']
    };
  }
  if (['prepare-profile', 'verify-assets', 'install-forge', 'final-readiness'].includes(key)
      || /Forge|libraries|assets|version metadata|No libraries/i.test(message)) {
    return {
      cause: 'Required Minecraft 1.12.2, Forge, asset, or library files are missing or invalid.',
      actions: ['Close Minecraft Launcher.', 'Run Update or Repair in the AHT Launcher, then try Play again.']
    };
  }
  if (['launcher-handoff', 'select-profile', 'profile-write-check'].includes(key)
      || /profile selection|reopened|did not close cleanly/i.test(message)) {
    return {
      cause: 'Minecraft Launcher or its updater prevented the exact AHT profile from being selected safely.',
      actions: ['Close every Minecraft Launcher window and wait a few seconds.', 'Click Play in the AHT Launcher again.']
    };
  }
  if (key === 'open-launcher' || /could not be opened|usable window|App activation|Minecraft Launcher application/i.test(message)) {
    return {
      cause: 'The operating system could not locate or activate a usable Minecraft Launcher window.',
      actions: ['Open Minecraft Launcher once from Applications or the Windows Start menu, then close it and retry.', 'If it will not open normally, repair or reinstall Minecraft Launcher through the operating system app settings.']
    };
  }
  return {
    cause: step
      ? `The launch stopped during "${step.label}". The exact failure is listed in Technical details.`
      : 'The launcher stopped before it could identify a completed launch stage.',
    actions: ['Restart the AHT Launcher and try once more.', 'If it fails again, send this report without deleting any AHT or Minecraft files.']
  };
}

function gb(value) {
  const bytes = Number(value) || 0;
  return bytes > 0 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : 'Unknown';
}

function statusLine(status, label, detail = '') {
  return `  [${String(status || 'NOT CHECKED').padEnd(11)}] ${label}${detail ? ` - ${detail}` : ''}`;
}

function pushSystemLines(lines, system = {}) {
  lines.push('PC AND RUNTIME');
  lines.push(`  Operating system: ${bounded(system.osName || system.osVersion || 'Unknown', 180)}`);
  lines.push(`  Architecture: ${bounded(system.arch || 'Unknown', 40)}`);
  lines.push(`  CPU: ${bounded(system.cpuModel || 'Unknown', 180)} (${Number(system.logicalCores) || 0} logical cores)`);
  lines.push(`  Memory: ${gb(system.totalMemoryBytes)} total, ${gb(system.freeMemoryBytes)} free`);
  const gpus = Array.isArray(system.gpus) ? system.gpus.filter(Boolean).slice(0, 4) : [];
  lines.push(`  Graphics: ${gpus.length ? gpus.map((item) => bounded(item, 160)).join(' | ') : 'Not reported by the operating system'}`);
  const disks = Array.isArray(system.disks) ? system.disks.slice(0, 4) : [];
  if (disks.length) {
    lines.push('  Storage:');
    for (const disk of disks) {
      lines.push(`    - ${bounded(disk.label || disk.path || 'Drive', 120)}: ${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}`);
    }
  }
  lines.push('');
}

export function formatLaunchReport(attempt) {
  const analysis = diagnoseLaunchFailure(attempt);
  const lines = [];
  lines.push('A HARD TIME LAUNCH REPORT');
  lines.push('================================================================');
  lines.push(`Result: ${attempt.result}`);
  lines.push(`Attempt ID: ${attempt.attemptId}`);
  lines.push(`Started: ${attempt.startedAt}`);
  lines.push(`Finished: ${attempt.finishedAt || 'Not finished'}`);
  lines.push(`Launcher: ${attempt.app.name} ${attempt.app.version || 'Unknown'} (${attempt.app.mode})`);
  lines.push(`Pack: ${attempt.pack.name}${attempt.pack.latestVersion ? ` ${attempt.pack.latestVersion}` : ''} (${attempt.pack.channel})`);
  lines.push(`Instance: ${attempt.instanceDir || 'Not resolved'}`);
  lines.push(`Minecraft root: ${attempt.minecraftRoot || 'Not resolved'}`);
  if (attempt.reportPath) lines.push(`Saved report: ${attempt.reportPath}`);
  lines.push('');
  lines.push('LIKELY CAUSE');
  lines.push(`  ${analysis.cause}`);
  lines.push('');
  lines.push('RECOMMENDED ACTION');
  analysis.actions.forEach((action, index) => lines.push(`  ${index + 1}. ${action}`));
  lines.push('');
  lines.push('LAUNCH PROCESS');
  if (!attempt.steps.length) {
    lines.push('  No launch steps were recorded.');
  } else {
    for (const step of attempt.steps) {
      lines.push(statusLine(step.status, `${step.number}. ${step.label}`, `${step.durationMs} ms${step.detail ? `; ${step.detail}` : ''}`));
    }
  }
  lines.push('');
  lines.push('REQUIREMENTS');
  for (const [key] of REQUIREMENTS) {
    const item = attempt.requirements[key];
    lines.push(statusLine(item.status, item.label, item.detail));
  }
  lines.push('');
  pushSystemLines(lines, attempt.system || {});
  const signals = Array.isArray(attempt.minecraftSignals) ? attempt.minecraftSignals.filter(Boolean).slice(-24) : [];
  lines.push('RECENT MINECRAFT LAUNCHER SIGNALS');
  if (!signals.length) {
    lines.push('  No relevant Mojang Launcher signal was available for this attempt.');
  } else {
    for (const signal of signals) lines.push(`  ${sanitizeDiagnosticText(signal, 600)}`);
  }
  lines.push('');
  lines.push('TECHNICAL DETAILS');
  if (attempt.error) {
    lines.push(`  Failed step: ${failedStep(attempt)?.label || 'Unknown'}`);
    lines.push(`  Error: ${attempt.error.message || 'Unknown error'}`);
    if (attempt.error.code) lines.push(`  Code: ${attempt.error.code}`);
  } else {
    lines.push('  No AHT Launcher error was recorded.');
  }
  if (attempt.reportWriteError) lines.push(`  Report file: ${sanitizeDiagnosticText(attempt.reportWriteError, 500)}`);
  lines.push('');
  lines.push('PRIVACY');
  lines.push('  Passwords, Microsoft/Minecraft tokens, AHT proof tokens, API keys, and environment secrets are not included.');
  lines.push('================================================================');
  return `${lines.join('\r\n')}\r\n`;
}

function fileTimestamp(value) {
  return new Date(value || Date.now()).toISOString().replace(/[:.]/g, '-');
}

export function launchLogDirectory(instanceDir) {
  return path.join(path.resolve(instanceDir), LAUNCH_LOG_FOLDER);
}

export function launchReportPath(instanceDir, attempt) {
  const outcome = String(attempt?.result || 'DIAGNOSTIC').replace(/[^A-Z]/g, '') || 'DIAGNOSTIC';
  const id = String(attempt?.attemptId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'report';
  return path.join(
    launchLogDirectory(instanceDir),
    `${LAUNCH_LOG_FILE_PREFIX}${fileTimestamp(attempt?.startedAt)}-${outcome}-${id}.txt`
  );
}

async function pruneLaunchReports(directory, retention = LAUNCH_LOG_RETENTION) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const reports = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(LAUNCH_LOG_FILE_PREFIX) && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(reports.slice(Math.max(1, retention)).map((name) => fs.unlink(path.join(directory, name)).catch(() => {})));
}

export async function writeLaunchReport(instanceDir, attempt, options = {}) {
  if (!String(instanceDir || '').trim()) throw new Error('AHT instance folder is not available for launch diagnostics.');
  const directory = launchLogDirectory(instanceDir);
  await fs.mkdir(directory, { recursive: true });
  const previousReportPath = attempt.reportPath || '';
  const reportPath = launchReportPath(instanceDir, attempt);
  attempt.reportPath = reportPath;
  attempt.reportWriteError = '';
  try {
    const text = formatLaunchReport(attempt);
    await fs.writeFile(reportPath, text, 'utf8');
    await pruneLaunchReports(directory, Number(options.retention) || LAUNCH_LOG_RETENTION).catch(() => {});
    return { path: reportPath, directory, text, chars: text.length };
  } catch (error) {
    attempt.reportPath = previousReportPath;
    throw error;
  }
}
