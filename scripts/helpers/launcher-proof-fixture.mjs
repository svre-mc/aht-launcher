function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function workerLauncherProofFixture(payload, options = {}) {
  const kid = String(options.kid || 'aht-launcher-proof-v1');
  const signatureValue = String(options.signature || 'test-signature');
  const header = {
    alg: 'HS256',
    typ: 'AHT-LAUNCHER-PROOF',
    kid
  };
  return {
    protocol: 'aht-launcher-proof-v1',
    schemaVersion: 1,
    trusted: true,
    source: 'worker',
    token: `${base64UrlJson(header)}.${base64UrlJson(payload)}.${signatureValue}`,
    header,
    payload,
    signature: { alg: 'HS256', kid, value: signatureValue }
  };
}
