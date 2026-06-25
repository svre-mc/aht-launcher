import assert from 'node:assert/strict';
import {
  cleanR2AccountId,
  directR2CredentialsReady,
  missingDirectR2CredentialLabels,
  r2Endpoint
} from '../src/r2DirectUpload.js';

assert.equal(cleanR2AccountId('abc123'), 'abc123');
assert.equal(cleanR2AccountId('https://abc123.r2.cloudflarestorage.com'), 'abc123');
assert.equal(cleanR2AccountId('abc123.r2.cloudflarestorage.com/bucket/key'), 'abc123');
assert.equal(r2Endpoint('abc123'), 'https://abc123.r2.cloudflarestorage.com');
assert.equal(directR2CredentialsReady({
  accountId: 'abc123',
  accessKeyId: 'key',
  secretAccessKey: 'secret'
}), true);
assert.equal(directR2CredentialsReady({
  accountId: 'abc123',
  accessKeyId: 'key',
  secretAccessKey: ''
}), false);
assert.deepEqual(missingDirectR2CredentialLabels({
  accountId: '',
  accessKeyId: '',
  secretAccessKey: ''
}), ['R2 Account ID', 'R2 Access Key ID', 'R2 Secret Access Key']);

console.log(JSON.stringify({ ok: true }, null, 2));
