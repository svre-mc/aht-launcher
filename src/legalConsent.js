import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, readJsonFile, writeJsonFile } from './utils.js';

export const TERMS_VERSION = '2026-07-14.1';
export const PRIVACY_VERSION = '2026-07-14.1';
export const LEGAL_EFFECTIVE_AT = '2026-07-14T00:00:00-07:00';

const TERMS_FILE = 'TERMS_OF_SERVICE.txt';
const PRIVACY_FILE = 'PRIVACY_POLICY.txt';

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export async function loadLegalDocuments(appRoot) {
  const legalRoot = path.join(path.resolve(appRoot), 'legal');
  const [termsText, privacyText] = await Promise.all([
    fs.readFile(path.join(legalRoot, TERMS_FILE), 'utf8'),
    fs.readFile(path.join(legalRoot, PRIVACY_FILE), 'utf8')
  ]);
  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    effectiveAt: LEGAL_EFFECTIVE_AT,
    termsText,
    privacyText,
    termsSha256: sha256(termsText),
    privacySha256: sha256(privacyText)
  };
}

async function readConsent(consentPath) {
  if (!(await pathExists(consentPath))) return null;
  try {
    return await readJsonFile(consentPath);
  } catch {
    return null;
  }
}

export async function legalConsentStatus({ appRoot, consentPath, identity = {}, developerMode = false } = {}) {
  const documents = await loadLegalDocuments(appRoot);
  const consent = await readConsent(consentPath);
  const accepted = Boolean(
    consent
    && consent.affirmed === true
    && consent.termsVersion === documents.termsVersion
    && consent.privacyVersion === documents.privacyVersion
    && consent.termsSha256 === documents.termsSha256
    && consent.privacySha256 === documents.privacySha256
  );
  const identityCreatedAt = Date.parse(String(identity.createdAt || ''));
  const effectiveAt = Date.parse(LEGAL_EFFECTIVE_AT);
  const existingInstall = Number.isFinite(identityCreatedAt) && Number.isFinite(effectiveAt) && identityCreatedAt < effectiveAt;
  return {
    required: !developerMode && !accepted,
    accepted,
    reason: accepted ? 'accepted' : (consent || existingInstall ? 'updated' : 'first-run'),
    acceptedAt: accepted ? String(consent.acceptedAt || '') : '',
    ...documents
  };
}

export async function recordLegalConsent({
  appRoot,
  consentPath,
  termsVersion,
  privacyVersion,
  affirmed,
  appVersion = '',
  platform = process.platform,
  arch = process.arch,
  identity = {}
} = {}) {
  if (affirmed !== true) throw new Error('You must affirmatively agree before continuing.');
  const documents = await loadLegalDocuments(appRoot);
  if (termsVersion !== documents.termsVersion || privacyVersion !== documents.privacyVersion) {
    throw new Error('The Terms or Privacy Policy changed. Review the current version before accepting.');
  }
  const record = {
    schemaVersion: 1,
    affirmed: true,
    termsVersion: documents.termsVersion,
    privacyVersion: documents.privacyVersion,
    termsSha256: documents.termsSha256,
    privacySha256: documents.privacySha256,
    acceptedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    platform: String(platform || ''),
    arch: String(arch || ''),
    minecraftUsername: String(identity.minecraftUsername || ''),
    installIdSha256: sha256(identity.installId || '')
  };
  await writeJsonFile(consentPath, record);
  return record;
}
