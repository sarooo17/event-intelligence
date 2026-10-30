// Whole-file same-host adoption footprint. Read all local source and lock
// inputs, verify exact git blobs against independently reviewed #364 source.
// This is an observational cost report, NOT an independent human study.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fixed = Object.freeze({
  'host.mjs': '8584b9f4de74e25e3ff5acea1150603114e935ad',
  'manual-bridge.mjs': '6f9d262bc887f157f30663e1c25e780d685c7196',
  'ei-bridge.mjs': '000a453e9d52f79570b970cde942a6759cf59922',
});
const gitBlobSha = text => createHash('sha1')
  .update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
const count = text => {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return {
    physical: lines.length,
    nonblank: lines.filter(row => row.trim()).length,
    sourceBytes: Buffer.byteLength(text),
  };
};
const rows = {};
for (const [filename, pinnedBlob] of Object.entries(fixed)) {
  const text = readFileSync(resolve(root, filename), 'utf8');
  const actual = gitBlobSha(text);
  assert.equal(actual, pinnedBlob, 'Source changed since exact reviewed #364 ' + filename);
  rows[filename] = { filename, gitBlobSha: actual, ...count(text) };
}
assert.equal(rows['host.mjs'].physical, 130);
assert.equal(rows['manual-bridge.mjs'].physical, 50);
assert.equal(rows['ei-bridge.mjs'].physical, 40);

const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const publication = lock.packages['node_modules/mcp-event-intelligence'];
assert.equal(publication.version, '0.12.0-next.0');
assert.match(publication.integrity, /^sha512-/);
assert.equal(manifest.dependencies['mcp-event-intelligence'], publication.version);

const full = adapter => Object.fromEntries(
  ['physical', 'nonblank', 'sourceBytes'].map(field =>
    [field, rows['host.mjs'][field] + rows[adapter][field]]),
);
const manual = full('manual-bridge.mjs'), existing = full('ei-bridge.mjs');
const delta = Object.fromEntries(['physical', 'nonblank', 'sourceBytes'].map(k =>
  [k, existing[k] - manual[k]]));
const rootManifest = JSON.parse(readFileSync(resolve(root, '../../../package.json'), 'utf8'));
assert.ok(rootManifest.exports['./embedded']);
assert.ok(lock.packages['node_modules/mcp-event-intelligence']);

console.log(JSON.stringify({
  schema: 'ei.host-kit-actual-consumer-source-cost.v1',
  sourcePinnedToMergedPR: 364,
  sourceFiles: rows,
  sameHostOneBridgeAtATime: { manual, existingBinder: existing, changeBinderMinusManual: delta },
  pctWholeHostPhysicalReduction: Number(
    ((manual.physical - existing.physical) * 100 / manual.physical).toFixed(3)),
  install: {
    commands: ['cd examples/host-adapter/portable-runtime-lab',
      'npm ci --ignore-scripts --no-audit --no-fund', 'npm test'],
    packageVersion: publication.version,
    npmIntegrity: publication.integrity,
    lockfilePackageEntriesIncludingRoot: Object.keys(lock.packages).length,
    directDependencies: Object.keys(manifest.dependencies).sort(),
    extraDependenciesOfBinderVsManual: 0,
    additionalEIProductionRuntimeFiles: 0,
    additionalEITypeFiles: 0,
    additionalPublicExports: 0,
    separateVendorAgentSdkRequired: false,
    hostNeedsExistingIdentityAndAuthorization: true,
    durableHostAtomicReceiptIncludedInLab: false,
  },
  coverage: {
    basis: 'source-pinned entire standalone EI-maintained host modules',
    noEIImportsInHost: !readFileSync(resolve(root, 'host.mjs'), 'utf8')
      .includes("from 'mcp-event-intelligence"),
    realManualAndBinderSameApplication: true,
    humanDeveloperHoursObserved: null,
    onboardingElapsedMinutesObserved: null,
    productionMonthlyCostObserved: null,
    externalToolEnabledAdopterVerified: false,
    mcpProviderSetupIncluded: false,
    durablePostgresHostSetupIncluded: false,
    genuineNetAdoptionROIProvenAcrossExternalHosts: false,
  },
}, null, 2));
