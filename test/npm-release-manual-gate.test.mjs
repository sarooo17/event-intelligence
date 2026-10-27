import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const file=readFileSync(new URL('../.github/workflows/publish-npm.yml',import.meta.url),'utf8');

test('npm publication has no push, tag or implicit main-branch release trigger',()=>{
  assert.match(file,/^on:\s*\n  workflow_dispatch:/m);
  assert.doesNotMatch(file,/^  push:/m);
  assert.doesNotMatch(file,/^    tags:/m);
  assert.doesNotMatch(file,/github\.event_name == 'push'/);
});

test('operator confirmation is a mandatory failing step, not a skipped job',()=>{
  assert.match(file,/  publish:\s*\n    runs-on:/m);
  assert.doesNotMatch(file,/^    if:.*inputs\.confirm/m);
  assert.match(file,/test "\$GITHUB_EVENT_NAME" = "workflow_dispatch"/);
  assert.match(file,/test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(file,/test "\$RELEASE_CONFIRM" = "publish"/);
  assert.ok(file.indexOf('Enforce explicit main-branch release approval')<
    file.indexOf('actions/checkout@v4'),'release guard must run before any checkout');
});

test('release packaging verification remains mandatory before npm publish',()=>{
  for(const step of [
    'node scripts/check-release-manifest.mjs',
    'npm run check',
    'npm run pack:check',
    'npm view "mcp-event-intelligence@$VERSION" version',
    'npm publish --access public --tag "$TAG"',
  ])assert.ok(file.includes(step),step);
});

test('every prerelease is explicitly published to npm next, never latest',()=>{
  assert.match(file,/if \[\[ "\$VERSION" == \*-\* \]\]; then/);
  assert.match(file,/TAG=next/);
  assert.match(file,/TAG=latest/);
  assert.match(file,/npm publish --access public --tag "\$TAG"/);
});

const launchWorkflow=readFileSync(new URL('../.github/workflows/mcp-launch-check.yml',import.meta.url),'utf8');
const releaseWorkflow=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
test('manual npm publish requires an exact operator-approved version',()=>{
  assert.ok(file.includes('expected_version:'));
  assert.ok(file.includes('test -n "$OPERATOR_VERSION"'));
  assert.ok(file.includes('version")" = "$OPERATOR_VERSION"'));
});
test('MCP Registry prereleases are explicitly unsupported, not falsely certified',()=>{
  assert.ok(launchWorkflow.includes('node scripts/check-release-manifest.mjs'));
  assert.ok(launchWorkflow.includes('if [[ "$VERSION" == *-* ]]; then'));
  assert.ok(launchWorkflow.includes('MCP Registry prerelease unsupported'));
  assert.ok(launchWorkflow.includes('./mcp-publisher validate server.json'));
});
test('npm prerelease cannot trigger a stable MCP Registry/GitHub release',()=>{
  assert.ok(releaseWorkflow.includes('name: Classify release channel'));
  assert.ok(releaseWorkflow.includes('mcp_release=false'));
  assert.ok(releaseWorkflow.includes('mcp_release=true'));
  for(const step of ['Resolve and verify version','Install mcp-publisher',
    'Validate server metadata','Check MCP Registry',
    'Verify MCP Registry publication','Create GitHub Release']){
    const at=releaseWorkflow.indexOf('- name: '+step);
    assert.ok(at>=0,step);
    assert.ok(releaseWorkflow.slice(at,at+200).includes(
      "steps.channel.outputs.mcp_release == 'true'"),step+' must be stable-only');
  }
  assert.ok(releaseWorkflow.includes(
    "steps.channel.outputs.mcp_release == 'true' && steps.registry.outputs.exists != 'true'"));
});
