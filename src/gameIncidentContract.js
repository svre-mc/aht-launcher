// Shared allowlist: reports contain symbols and measurements, never raw log lines.
export const INCIDENT_KINDS = new Set(['boot', 'connected', 'disconnected', 'fatal_error', 'crash', 'process_exit', 'normal_exit']);
export const INCIDENT_REASONS = new Set(['unknown', 'remote_closed', 'read_timeout', 'protocol_error',
  'out_of_memory', 'process_crash', 'server_kick', 'normal_exit', 'local_quit', 'exception']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const METRIC_NAMES = ['heapUsedBytes', 'heapMaxBytes', 'gcMillis', 'uptimeMillis', 'playerPingMillis',
  'workerDelayMicros', 'edgeRttMicros', 'edgeRetransmits', 'queuedBytes', 'backpressureMillis',
  'keepalivePendingMillis', 'inboundIdleMillis', 'exitCode', 'droppedEvents'];
const classSymbol = /^(?:[A-Za-z_$][\w$]*\.)*(?:Exception|Error|Throwable|[A-Za-z_$][\w$]*(?:Exception|Error|Throwable))$/;
const frameSymbol = /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*#[A-Za-z_$][\w$]*(?::\d{1,6})?$/;
export function normalizeIncident(value, now = Date.now()) {
  if (!value || !uuid.test(value.id || '') || !uuid.test(value.connectionId || '')
      || (value.launchId && !uuid.test(value.launchId)) || !INCIDENT_KINDS.has(value.kind)
      || !INCIDENT_REASONS.has(value.reasonCode)) throw new Error('Invalid incident.');
  const time = Date.parse(value.occurredAt);
  if (!Number.isFinite(time) || Math.abs(time - now) > 24 * 60 * 60 * 1000) throw new Error('Invalid incident time.');
  const symbols = (values, limit, pattern) => (Array.isArray(values) ? values : []).filter(item =>
    typeof item === 'string' && item.length <= 180 && !/[\r\n]/.test(item) && pattern.test(item)).slice(0, limit);
  const metrics = {};
  for (const key of METRIC_NAMES) {
    const n = value.metrics?.[key];
    if (Number.isSafeInteger(n) && n >= -1 && n <= 2 ** 48) metrics[key] = n;
  }
  return { schemaVersion: 1, id: value.id.toLowerCase(), launchId: value.launchId?.toLowerCase() || '',
    connectionId: value.connectionId.toLowerCase(), occurredAt: new Date(time).toISOString(),
    kind: value.kind, reasonCode: value.reasonCode, exceptionClasses: symbols(value.exceptionClasses, 6, classSymbol),
    stackFrames: symbols(value.stackFrames, 8, frameSymbol), metrics };
}

export function explainIncident(events = []) {
  const terminal = events.filter(e => ['disconnected', 'crash', 'process_exit', 'normal_exit'].includes(e.kind));
  const server = terminal.find(e => e.source === 'backend' && e.reasonCode === 'server_kick');
  const client = terminal.find(e => e.source === 'client' && ['exception', 'protocol_error', 'out_of_memory', 'process_crash'].includes(e.reasonCode));
  const timeout = terminal.find(e => e.reasonCode === 'read_timeout');
  if (server) return { code: 'server_kick', confidence: 'server-observed',
    explanation: 'The backend issued a disconnect. Check the matching server rejection or enforcement event.' };
  if (client) return { code: client.reasonCode, confidence: 'client-reported',
    explanation: 'The client captured an error in this incident. Exception classes and frames identify the failing boundary; they do not establish the underlying cause alone.' };
  if (timeout) return { code: 'read_timeout', confidence: 'observed-symptom',
    explanation: 'A read timeout was observed. Compare client activity, server pauses and proxy measurements.' };
  if (terminal.some(e => e.source === 'client' && e.reasonCode === 'local_quit')) return {
    code: 'local_quit', confidence: 'client-reported', explanation: 'The client reported Minecraft’s quitting reason. No captured error overrides that observation.' };
  if (terminal.some(e => e.source === 'client' && e.reasonCode === 'normal_exit')) return {
    code: 'normal_exit', confidence: 'client-reported', explanation: 'The client recorded a normal game shutdown.' };
  if (terminal.length && terminal.every(e => e.reasonCode === 'normal_exit')) return {
    code: 'normal_exit', confidence: 'observed-symptom', explanation: 'A normal local shutdown was reported.' };
  return { code: 'unresolved', confidence: 'insufficient-evidence',
    explanation: 'The connection or process ended without a captured cause. A generic close does not identify who caused it.' };
}

export function correlateIncidents(records = []) {
  const events = records.flatMap(record => (record.events || []).map(event => ({ ...event, source: record.source,
    launcherVersion: record.launcherVersion || '', packVersion: record.packVersion || '' })))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const terminals = events.filter(e => ['disconnected', 'crash', 'process_exit'].includes(e.kind));
  const used = new Set(); const incidents = [];
  for (const event of terminals) {
    if (used.has(event.id)) continue;
    const time = Date.parse(event.occurredAt);
    const matches = events.filter(other => !used.has(other.id) && Math.abs(Date.parse(other.occurredAt) - time) <= 10_000
      && (!event.launchId || !other.launchId || other.launchId === event.launchId)
      && (other.source !== event.source || other.connectionId === event.connectionId));
    for (const other of matches) used.add(other.id);
    const sources = [...new Set(matches.map(e => e.source))];
    incidents.push({ id: event.id, occurredAt: event.occurredAt, launchId: event.launchId,
      correlation: sources.length > 1 ? (matches.every(e => e.launchId && e.launchId === event.launchId)
        ? 'launch-id-and-time' : 'player-uuid-and-time') : 'single-source',
      missingSources: ['client', 'backend', 'proxy'].filter(source => !sources.includes(source)),
      diagnosis: explainIncident(matches), events: matches });
  }
  return { schemaVersion: 1, retention: 'Bounded session ring: at most 32 slots per source and 32 events per slot.',
    incidents: incidents.slice(0, 32) };
}
