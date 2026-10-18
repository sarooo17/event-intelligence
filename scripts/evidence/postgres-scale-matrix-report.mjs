#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { summarizeScaleEvidence } from './postgres-scale-matrix.mjs';

// The matrix validator deliberately rejects absent/malformed input before
// printing JSON. This wrapper writes a durable, machine-readable FAILURE
// report as well: an empty archived matrix is never acceptable evidence.
const [outputPath, ...inputPaths] = process.argv.slice(2);
if (!outputPath) {
  process.stderr.write('Usage: scale-matrix-report.mjs <report-output.json> <1k> <10k> <100k>\n');
  process.exitCode = 2;
} else {
  let report;
  try {
    if (inputPaths.length !== 3) {
      const e = new Error('Expected exactly three actual profile files');
      e.code = 'EI_PG_SCALE_PROFILE_COUNT_INVALID';
      throw e;
    }
    const actual = inputPaths.map(file => JSON.parse(readFileSync(file, 'utf8')));
    report = summarizeScaleEvidence(actual);
    if (report.status !== 'profiles-observed' ||
        report.missing.length !== 0 || !report.provenanceComplete ||
        !report.environmentsComparable || report.productionSloCertified !== false) {
      const e = new Error('Actual profile matrix incomplete or non-comparable');
      e.code = 'EI_PG_SCALE_MATRIX_INCOMPLETE';
      throw e;
    }
  } catch (error) {
    report = {
      schema: 'event-intelligence.postgres-scale-matrix.failure.v1',
      status: 'failed',
      code: typeof error?.code === 'string' && /^EI_PG_[A-Z_]+$/.test(error.code)
        ? error.code
        : 'EI_PG_SCALE_EVIDENCE_INVALID',
      expectedProfiles: ['1k', '10k', '100k'],
      missingInputPaths: inputPaths.filter(path => !existsSync(path)),
      suppliedInputCount: inputPaths.length,
      productionSloCertified: false,
      // Intentionally omit arbitrary raw error text, DB URLs and input data.
      caveat: 'One or more raw profile files was absent, malformed, invalid or non-comparable; no scale certification is possible.',
    };
    process.exitCode = 1;
  }
  try {
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({
      schema: report.schema, status: report.status,
      ...(report.code ? { code: report.code } : {}),
    }) + '\n');
  } catch {
    process.stderr.write('EI_PG_SCALE_MATRIX_REPORT_WRITE_FAILED\n');
    process.exitCode = 1;
  }
}
