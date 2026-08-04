import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  completeLaunchAttempt,
  createLaunchAttempt,
  formatLaunchReport,
  LAUNCH_LOG_FILE_PREFIX,
  LAUNCH_LOG_RETENTION,
  runLaunchStep,
  sanitizeDiagnosticText,
  setLaunchRequirement,
  writeLaunchReport
} from '../src/launchDiagnostics.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launch-diagnostics-'));
const instanceDir = path.join(root, 'A Hard Time');

try {
  const adversarialSecrets = [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'api_key = exposed-api-key',
    "client_secret: 'exposed-client-secret'",
    '?access_token=exposed-access-token&channel=stable',
    `{"refresh_token":"${'x'.repeat(5000)}`
  ];
  for (const secret of adversarialSecrets) {
    const sanitized = sanitizeDiagnosticText(secret, 240);
    assert(!/exposed-|dXNlcj|x{20}/i.test(sanitized), `Secret redaction missed an adversarial form: ${sanitized}`);
    assert(sanitized.includes('<redacted>'), `Secret redaction did not leave a clear placeholder: ${sanitized}`);
  }

  const attempt = createLaunchAttempt({
    attemptId: '11111111-2222-4333-8444-555555555555',
    startedAt: '2026-08-04T03:15:20.123Z',
    appName: 'A Hard Time Launcher',
    appVersion: '0.1.82',
    mode: 'player',
    packaged: true,
    packId: 'a-hard-time-dregora',
    packName: 'A Hard Time',
    channel: 'stable',
    instanceDir,
    minecraftRoot: path.join(root, 'Minecraft')
  });
  setLaunchRequirement(attempt, 'instance', 'PASS', instanceDir);
  setLaunchRequirement(attempt, 'installed', 'PASS', 'Installed version 2.8.2.');
  setLaunchRequirement(attempt, 'integrity', 'FAIL', 'One managed mod is missing.');
  setLaunchRequirement(attempt, 'java8', 'PASS', 'Temurin 1.8.0_462 amd64.');
  await assert.rejects(
    runLaunchStep(
      attempt,
      'integrity',
      'Verify managed modpack files',
      async () => { throw new Error('Repair required. 1 mod file issue found. token=private-value'); }
    ),
    /Repair required/
  );
  attempt.system = {
    osName: 'Windows 11 10.0.26100',
    arch: 'x64 / Windows',
    cpuModel: 'Test CPU',
    logicalCores: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 8 * 1024 ** 3,
    gpus: ['Test GPU'],
    disks: [{ label: 'AHT instance drive', totalBytes: 512 * 1024 ** 3, freeBytes: 200 * 1024 ** 3 }]
  };
  attempt.minecraftSignals = [
    'Authorization: Bearer secret-token',
    '--accessToken very-secret',
    'Process crashed with exit code 1'
  ];
  completeLaunchAttempt(attempt, 'FAILED', new Error('Repair required. 1 mod file issue found. password=hunter2'));
  const saved = await writeLaunchReport(instanceDir, attempt);
  const expectedDirectory = path.join(instanceDir, 'logs', 'launcher');
  assert.equal(path.dirname(saved.path), expectedDirectory, 'Launch report escaped the selected AHT instance logs folder.');
  assert.match(path.basename(saved.path), /^AHT-Launch-2026-08-04T03-15-20-123Z-FAILED-11111111\.txt$/);
  assert.match(saved.text, /^A HARD TIME LAUNCH REPORT\r?\n/);
  for (const heading of ['LIKELY CAUSE', 'RECOMMENDED ACTION', 'LAUNCH PROCESS', 'REQUIREMENTS', 'PC AND RUNTIME', 'RECENT MINECRAFT LAUNCHER SIGNALS', 'TECHNICAL DETAILS', 'PRIVACY']) {
    assert(saved.text.includes(heading), `Launch report is missing ${heading}.`);
  }
  assert(saved.text.includes('One or more managed modpack files are missing'), 'Likely cause was not derived from the exact failed stage.');
  assert(saved.text.includes('[FAIL       ] 1. Verify managed modpack files'), 'Failed process step was not listed cleanly.');
  assert(saved.text.includes('Windows 11 10.0.26100') && saved.text.includes('Test CPU') && saved.text.includes('Test GPU'), 'PC specification summary is incomplete.');
  assert(saved.text.includes('64-bit Java 8'), 'Requirements checklist is incomplete.');
  assert(!saved.text.includes('private-value') && !saved.text.includes('very-secret') && !saved.text.includes('hunter2'), 'Launch report leaked a credential or token.');
  assert(!saved.text.trim().startsWith('{'), 'Launch report regressed to a raw JSON dump.');

  const minecraftSentinel = path.join(instanceDir, 'logs', 'latest.log');
  await fs.mkdir(path.dirname(minecraftSentinel), { recursive: true });
  await fs.writeFile(minecraftSentinel, 'minecraft log sentinel\n', 'utf8');
  for (let index = 0; index < LAUNCH_LOG_RETENTION + 7; index += 1) {
    const rolling = createLaunchAttempt({
      attemptId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`,
      startedAt: new Date(Date.UTC(2026, 7, 4, 4, 0, index)).toISOString(),
      appVersion: '0.1.82',
      packId: 'a-hard-time-dregora',
      packName: 'A Hard Time',
      channel: 'stable',
      instanceDir
    });
    completeLaunchAttempt(rolling, 'HANDOFF CONFIRMED');
    await writeLaunchReport(instanceDir, rolling);
  }
  const reportNames = (await fs.readdir(expectedDirectory)).filter((name) => name.startsWith(LAUNCH_LOG_FILE_PREFIX));
  assert.equal(reportNames.length, LAUNCH_LOG_RETENTION, 'Owned launcher reports were not capped at the retention limit.');
  assert.equal(await fs.readFile(minecraftSentinel, 'utf8'), 'minecraft log sentinel\n', 'Retention touched Minecraft latest.log.');

  const newest = reportNames.sort().at(-1);
  const newestText = await fs.readFile(path.join(expectedDirectory, newest), 'utf8');
  assert(newestText.includes('Result: HANDOFF CONFIRMED'), 'Successful handoff was mislabeled as full game success.');
  assert(newestText.includes('If Minecraft later exits'), 'Handoff report does not explain the separate post-launch crash boundary.');

  const postHandoffCrash = createLaunchAttempt({
    attemptId: '99999999-2222-4333-8444-555555555555',
    appVersion: '0.1.82',
    packId: 'a-hard-time-dregora',
    packName: 'A Hard Time',
    channel: 'stable',
    instanceDir
  });
  postHandoffCrash.minecraftSignals = ['Minecraft Launcher: No libraries?!'];
  completeLaunchAttempt(postHandoffCrash, 'HANDOFF CONFIRMED');
  const postHandoffCrashReport = await writeLaunchReport(instanceDir, postHandoffCrash);
  assert(
    postHandoffCrashReport.text.includes('Minecraft or Forge stopped because a required library or class is missing.'),
    'A copied post-handoff report did not classify a common missing-library crash signal.'
  );

  const missingJavaSnapshot = createLaunchAttempt({
    appVersion: '0.1.82',
    packId: 'a-hard-time-dregora',
    packName: 'A Hard Time',
    channel: 'stable',
    instanceDir
  });
  setLaunchRequirement(missingJavaSnapshot, 'java8', 'FAIL', 'No usable runtime detected.');
  completeLaunchAttempt(missingJavaSnapshot, 'DIAGNOSTIC');
  assert(
    formatLaunchReport(missingJavaSnapshot).includes('A usable 64-bit Java 8 runtime was not detected.'),
    'A manual diagnostic snapshot ignored its failed Java requirement.'
  );

  const unwritableInstance = path.join(root, 'Unwritable AHT');
  await fs.mkdir(unwritableInstance, { recursive: true });
  await fs.writeFile(path.join(unwritableInstance, 'logs'), 'blocks the logs directory', 'utf8');
  const unwritableAttempt = createLaunchAttempt({ instanceDir: unwritableInstance });
  completeLaunchAttempt(unwritableAttempt, 'FAILED', new Error('Synthetic launch failure'));
  await assert.rejects(writeLaunchReport(unwritableInstance, unwritableAttempt));
  assert.equal(unwritableAttempt.reportPath, '', 'A failed report write falsely claimed that a saved report exists.');

  console.log(JSON.stringify({
    reportPath: saved.path,
    reportChars: saved.text.length,
    retainedReports: reportNames.length,
    rawJson: false,
    credentialsRedacted: true,
    gameSuccessNotClaimed: true,
    postHandoffCauseClassified: true,
    manualRequirementClassified: true,
    failedWriteNotClaimed: true
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
