import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { recoverRepairFailure, repairPermissionTarget, permissionGrantScript, repairNetworkFailure } from '../src/repairRecovery.js';

test('permission Allow requests elevation once and Deny never grants or completes repair', async () => {
  const target = { root: '/fixture/game', target: '/fixture/game/mods' };
  for (const approved of [true, false]) {
    const calls = [];
    const work = recoverRepairFailure({ platform: 'win32', error: new Error('denied'), roots: [target.root],
      findTarget: async () => target, ask: async kind => { calls.push(kind); return approved; },
      elevate: async selected => { assert.equal(selected, target); calls.push('uac'); } });
    if (approved) assert.equal(await work, 'permission');
    else await assert.rejects(work, { code: 'AHT_REPAIR_PERMISSION_REQUIRED' });
    assert.deepEqual(calls, approved ? ['permission', 'uac'] : ['permission']);
  }
  const failure = Object.assign(new Error('UAC declined'), { code: 'AHT_REPAIR_PERMISSION_REQUIRED' });
  await assert.rejects(recoverRepairFailure({ platform: 'win32', roots: [], findTarget: async () => target,
    ask: async () => true, elevate: async () => { throw failure; } }), e => e === failure);
  assert.equal(await recoverRepairFailure({ platform: 'win32', error: {}, permissionAttempted: true,
    findTarget: () => assert.fail('repeated elevation'), ask: () => assert.fail('repeated prompt') }), null);
});
test('network retry is explicit and bounded, with no elevation for outages or server rejection', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const error = new Error('setup failed', { cause: Object.assign(new Error('connection failed'), { code: 'ENOTFOUND' }) });
    assert.equal(repairNetworkFailure(error), true);
    for (const approved of [true, false]) {
      const result = await recoverRepairFailure({ error, platform, findTarget: async () => null,
        ask: async kind => { assert.equal(kind, 'network'); return approved; }, elevate: () => assert.fail('network elevation') });
      assert.equal(result, approved ? 'network' : null);
    }
    assert.equal(await recoverRepairFailure({ error, platform, networkAttempted: true, findTarget: async () => null,
      ask: () => assert.fail('retry loop') }), null);
  }
  for (const error of [{ code: 'ACCESS_RESTRICTED', message: 'Access denied' }, { message: 'HTTP 403' }, { message: 'HTTP 429' }]) {
    assert.equal(repairNetworkFailure(error), false);
  }
});
test('writable locked folders, outside paths and linked paths never trigger permission grants', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aht-repair-permissions-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const error = file => Object.assign(new Error('access denied'), { code: 'EPERM', path: file });
  assert.equal(await repairPermissionTarget(error(root), [root]), null);
  const file = path.join(root, 'test.txt');
  await fs.writeFile(file, 'preserved');
  assert.equal(await repairPermissionTarget(error(file), [root]), null);
  assert.equal(await repairPermissionTarget(error(path.dirname(root)), [root]), null);
  const missing = path.join(root, 'not-created');
  assert.deepEqual(await repairPermissionTarget(error(missing), [missing]), { root: missing, target: missing, create: true });
  const linked = path.join(root, 'linked');
  await fs.symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await repairPermissionTarget(error(path.join(linked, 'test.txt')), [root]), null);
  await fs.unlink(linked);
  assert.equal(await fs.readFile(file, 'utf8'), 'preserved');
});
test('Windows helper restores a real denied fixture ACL while leaving sibling data and ACL unchanged', { skip: process.platform !== 'win32' }, async t => {
  const execute = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-permission-acl-'));
  const target = path.join(root, 'game');
  const sibling = path.join(root, 'keep.txt');
  await fs.mkdir(target);
  await fs.writeFile(sibling, 'unchanged');
  const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-){1,14}\d+/)[0];
  const ps = code => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; " + code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const original = (await ps(`(Get-Acl -LiteralPath ${literal(target)}).Sddl`)).stdout.trim();
  const siblingAcl = (await ps(`(Get-Acl -LiteralPath ${literal(sibling)}).Sddl`)).stdout.trim();
  t.after(async () => {
    await ps(`$acl=Get-Acl -LiteralPath ${literal(target)}; $acl.SetSecurityDescriptorSddlForm(${literal(original)}); Set-Acl -LiteralPath ${literal(target)} -AclObject $acl`);
    await fs.rm(root, { recursive: true, force: true });
  });
  await ps(`$acl=Get-Acl -LiteralPath ${literal(target)}; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.SecurityIdentifier]::new('${sid}'); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath ${literal(target)} -AclObject $acl`);
  await assert.rejects(fs.writeFile(path.join(target, 'proof.txt'), 'repaired'), e => ['EACCES', 'EPERM'].includes(e.code));
  const selected = await repairPermissionTarget(Object.assign(new Error('denied'), { code: 'EACCES', path: target }), [target]);
  assert.equal(selected.target, target);
  await ps(permissionGrantScript({ ...selected, sid }));
  await fs.writeFile(path.join(target, 'proof.txt'), 'repaired');
  const missing = path.join(root, 'created-game');
  await ps(permissionGrantScript({ root: missing, target: missing, create: true, sid }));
  await fs.writeFile(path.join(missing, 'proof.txt'), 'created');
  assert.equal(await fs.readFile(sibling, 'utf8'), 'unchanged');
  assert.equal((await ps(`(Get-Acl -LiteralPath ${literal(sibling)}).Sddl`)).stdout.trim(), siblingAcl);
});
