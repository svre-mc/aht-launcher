import { createHash } from 'node:crypto';

export const memoryR2Etag = value => createHash('sha256').update(String(value)).digest('hex');

/** Model the conditional-write contract so account tests cannot hide lost updates. */
export function memoryR2Put(objects, key, value, options = {}) {
  const prior = objects.get(key);
  if (options.onlyIf?.etagMatches && (prior === undefined || memoryR2Etag(prior) !== options.onlyIf.etagMatches)) return null;
  if (options.onlyIf?.etagDoesNotMatch === '*' && prior !== undefined) return null;
  objects.set(key, String(value));
  return { etag: memoryR2Etag(value) };
}
