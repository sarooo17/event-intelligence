// Repeatable, locally authored host-shape matrix. This is NOT evidence that
// an independent third party adopted EI. It runs the same v3 management
// contract against three different host integration / execution boundaries.
import { pathToFileURL } from 'node:url';

import { runHostConformance } from '../scripts/host-conformance.mjs';
import { referenceHostAdapter } from './reference-host.mjs';
import { createProcessHostAdapter } from './process-host-adapter.mjs';

export const HOST_V3_MATRIX_SCHEMA =
  'event-intelligence.host-v3-matrix.v1';

function adapters() {
  return [
    {
      id: 'reference-direct-in-process',
      executionBoundary: 'same-process',
      integrationBoundary: 'low-level-reference-host',
      adapter: referenceHostAdapter,
    },
    {
      id: 'reference-neutral-in-process',
      executionBoundary: 'same-process',
      integrationBoundary: 'createEventIntelligence-facade',
      adapter: {
        name: 'reference-neutral-facade',
        createHarness: options => referenceHostAdapter.createHarness({
          ...options,
          useNeutralFacade: true,
        }),
      },
    },
    {
      id: 'reference-forked-os-process',
      executionBoundary: 'os-process-sigkill-and-restart',
      integrationBoundary: 'ipc-reference-host',
      adapter: createProcessHostAdapter(),
    },
  ];
}

/**
 * Execute actual v3 management operations, not a mocked conformance verdict.
 * All fixtures here are maintained in the EI repository: no "independent
 * external host" evidence is implied by different transport boundaries.
 */
export async function runLocalHostV3Matrix() {
  const fixtures = [];
  for (const item of adapters()) {
    const report = await runHostConformance(item.adapter, {
      profile: 'management',
    });
    fixtures.push({
      id: item.id,
      authorship: 'ei-repository-maintained',
      executionBoundary: item.executionBoundary,
      integrationBoundary: item.integrationBoundary,
      v3Report: report,
    });
  }
  const unique = new Set(fixtures.map(row => row.id)).size === fixtures.length;
  const complete = unique && fixtures.length === 3 &&
    fixtures.every(row => row.v3Report.passed &&
      row.v3Report.schema === 'event-intelligence.host-conformance.v3' &&
      row.v3Report.profile === 'management' &&
      row.v3Report.summary.total === 7 &&
      row.v3Report.summary.passed === 7);
  return {
    schema: HOST_V3_MATRIX_SCHEMA,
    complete,
    independentExternalHostVerified: false,
    limitations: [
      'All three host shapes are authored or maintained in the EI repository',
      'No independently developed third-party consumer has been validated',
      'OS child restart is tested in the reference IPC fixture, not distributed multi-worker failover',
      'The host owns model tools, authorization, transport, continuation effects and durable host receipts',
    ],
    fixtures,
  };
}

if (process.argv[1] && import.meta.url ===
    pathToFileURL(process.argv[1]).href) {
  const report = await runLocalHostV3Matrix();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.complete) process.exitCode = 1;
}
