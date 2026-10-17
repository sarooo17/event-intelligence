import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runLocalHostV3Matrix,
  HOST_V3_MATRIX_SCHEMA,
} from '../conformance/host-v3-matrix.mjs';

test('three EI-maintained host shapes exercise all v3 management cases independently of their execution boundary', {
  timeout: 120000,
}, async () => {
  const matrix = await runLocalHostV3Matrix();
  assert.equal(matrix.schema, HOST_V3_MATRIX_SCHEMA);
  assert.equal(matrix.complete, true, JSON.stringify(matrix, null, 2));
  assert.equal(matrix.independentExternalHostVerified, false,
    'EI-maintained fixture matrix must never claim third-party adoption');
  assert.deepEqual(matrix.fixtures.map(f => f.id), [
    'reference-direct-in-process',
    'reference-neutral-in-process',
    'reference-forked-os-process',
  ]);
  assert.deepEqual(matrix.fixtures.map(f => f.executionBoundary), [
    'same-process',
    'same-process',
    'os-process-sigkill-and-restart',
  ]);
  for (const row of matrix.fixtures) {
    assert.equal(row.authorship, 'ei-repository-maintained');
    assert.equal(row.v3Report.profile, 'management');
    assert.equal(row.v3Report.passed, true);
    assert.deepEqual(row.v3Report.summary,
      { total: 7, passed: 7, failed: 0 });
    assert.ok(row.v3Report.results.some(item =>
      item.id === 'management.lifecycle' && item.status === 'pass'));
    assert.ok(row.v3Report.results.some(item =>
      item.id === 'core.restart-after-delivery-replay' &&
      item.status === 'pass'));
    assert.ok(row.v3Report.observability.eventNames.includes('ei.wake.delivered'));
  }
  assert.ok(matrix.limitations.some(item =>
    /independently developed third-party/.test(item)));
});
