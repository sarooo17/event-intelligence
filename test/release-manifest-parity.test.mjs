import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  checkReleaseManifest, validateReleaseManifest,
} from '../scripts/check-release-manifest.mjs';

const read = f => JSON.parse(readFileSync(new URL('../' + f, import.meta.url)));
const pkg = read('package.json');
const lock = read('package-lock.json');
const server = read('server.json');
const clone = value => JSON.parse(JSON.stringify(value));

test('current release metadata is version/name-consistent, without a network call', () => {
  assert.deepEqual(validateReleaseManifest(pkg, lock, server), []);
  assert.deepEqual(checkReleaseManifest(new URL('..', import.meta.url).pathname), []);
});

test('release contract rejects every independently drifting version and package name', () => {
  const mutationCases = [
    ['lock root version', (p,l,s) => { l.version = '0.0.0'; }],
    ['lock packages root version', (p,l,s) => { l.packages[''].version = '0.0.0'; }],
    ['server version', (p,l,s) => { s.version = '0.0.0'; }],
    ['server npm version', (p,l,s) => { s.packages[0].version = '0.0.0'; }],
    ['lock root name', (p,l,s) => { l.name = 'wrong'; }],
    ['lock package name', (p,l,s) => { l.packages[''].name = 'wrong'; }],
    ['server registry name', (p,l,s) => { s.name = 'unrelated'; }],
    ['server npm name', (p,l,s) => { s.packages[0].identifier = 'unrelated'; }],
    ['server npm missing', (p,l,s) => { s.packages = []; }],
  ];
  for (const [name, mutate] of mutationCases) {
    const p=clone(pkg), l=clone(lock), s=clone(server);
    mutate(p,l,s);
    assert.notDeepEqual(validateReleaseManifest(p,l,s), [], name);
  }
  assert.notDeepEqual(validateReleaseManifest({},lock,server), []);
  assert.notDeepEqual(validateReleaseManifest(pkg,lock,{
    ...server, packages: [{ registryType: 'docker', identifier: pkg.name, version: pkg.version }],
  }), []);
});
