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
    'npm publish --access public',
  ])assert.ok(file.includes(step),step);
});
