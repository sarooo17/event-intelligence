import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyCampaignArtifact(jsonText, checksumText) {
  const report = JSON.parse(jsonText);
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.json)\s*$/.exec(checksumText);
  if (!match) return { valid: false, reason: 'checksum-format' };
  const actual = createHash('sha256').update(jsonText).digest();
  const expected = Buffer.from(match[1], 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { valid: false, reason: 'checksum-mismatch' };
  if (report?.schema !== 'event-intelligence.railway-validation-campaign.v1') return { valid: false, reason: 'schema-mismatch' };
  if (report.productionSloCertified !== false) return { valid: false, reason: 'self-certification-forbidden' };
  if (!Array.isArray(report.missingMetrics) || !report.sloGate || report.sloGate.status !== 'blocked') return { valid: false, reason: 'incomplete-evidence-not-marked' };
  return { valid: true, report, sha256: match[1] };
}

export function verifyRawSampleArtifact(sampleText, checksumText, expectedRows) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.jsonl)\s*$/.exec(checksumText);
  if (!match) return { valid: false, reason: 'checksum-format' };
  const actual = createHash('sha256').update(sampleText).digest();
  const expected = Buffer.from(match[1], 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { valid: false, reason: 'checksum-mismatch' };
  const rows = sampleText ? sampleText.trimEnd().split('\n') : [];
  if (rows.length !== expectedRows) return { valid: false, reason: 'row-count-mismatch' };
  try {
    for (const line of rows) {
      const row = JSON.parse(line);
      if (typeof row.eventId !== 'string' || typeof row.workerId !== 'string') return { valid: false, reason: 'sample-schema-mismatch' };
      for (const key of ['providerToWorkerResponseMs', 'ingestToMatchMs', 'matchToWakeMs', 'hostEffectMs', 'providerToHostEndToEndMs']) {
        if (key in row && row[key] !== null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)) return { valid: false, reason: 'sample-value-invalid' };
      }
    }
  } catch { return { valid: false, reason: 'sample-json-invalid' }; }
  return { valid: true, rows: rows.length, sha256: match[1] };
}
