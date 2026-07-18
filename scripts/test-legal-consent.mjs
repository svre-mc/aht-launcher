import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  legalConsentStatus,
  recordLegalConsent
} from '../src/legalConsent.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-legal-consent-'));
const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const consentPath = path.join(root, 'legal-consent.json');

const existing = await legalConsentStatus({
  appRoot,
  consentPath,
  identity: { createdAt: '2026-07-01T00:00:00.000Z' }
});
assert.equal(existing.required, true);
assert.equal(existing.reason, 'updated');
assert.match(existing.termsText, /SIIS ENTERPRISE LLC/i);
assert.match(existing.privacyText, /Minecraft username/i);

await assert.rejects(
  () => recordLegalConsent({ appRoot, consentPath, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, affirmed: false }),
  /affirmatively agree/i
);
await assert.rejects(
  () => recordLegalConsent({ appRoot, consentPath, termsVersion: 'old', privacyVersion: PRIVACY_VERSION, affirmed: true }),
  /changed/i
);

const accepted = await recordLegalConsent({
  appRoot,
  consentPath,
  termsVersion: TERMS_VERSION,
  privacyVersion: PRIVACY_VERSION,
  affirmed: true,
  appVersion: '9.9.9',
  platform: 'win32',
  arch: 'x64',
  identity: { minecraftUsername: 'LegalUser_1', installId: 'private-install-id' }
});
assert.equal(accepted.affirmed, true);
assert.equal(accepted.minecraftUsername, 'LegalUser_1');
assert.notEqual(accepted.installIdSha256, 'private-install-id');
assert.equal(accepted.installIdSha256.length, 64);

const current = await legalConsentStatus({ appRoot, consentPath, identity: {} });
assert.equal(current.required, false);
assert.equal(current.accepted, true);

const stored = JSON.parse(await fs.readFile(consentPath, 'utf8'));
stored.termsVersion = 'old';
await fs.writeFile(consentPath, JSON.stringify(stored));
const changed = await legalConsentStatus({ appRoot, consentPath, identity: {} });
assert.equal(changed.required, true);
assert.equal(changed.reason, 'updated');

const developer = await legalConsentStatus({ appRoot, consentPath: path.join(root, 'missing.json'), developerMode: true });
assert.equal(developer.required, false);

console.log('legal consent tests passed');
