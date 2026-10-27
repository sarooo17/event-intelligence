# Explicit npm release authorization

Issue [#50](https://github.com/sarooo17/event-intelligence/issues/50).

Publishing `mcp-event-intelligence` to npm is now **manual-only**, even
when `package.json` changes on `main`, a test command changes, or a tag
is pushed. The `Publish npm` workflow supports one entrypoint:

1. Open GitHub Actions → `Publish npm` → `Run workflow`.
2. Select **main** and supply exact confirmation `publish`.
3. The job rejects every other event/ref/input combination before
   installing dependencies, packing, or publishing.
4. Existing checks remain mandatory: manifest consistency, `npm run check`,
   `npm run pack:check`, and registry existence check.
5. If the version already exists in npm, publish step remains skipped,
   preserving npm version immutability.

**Why fail instead of skip?** The existing `Release` workflow listens for a
successful completion of `Publish npm`. A skipped job can appear successful
and must not accidentally trigger a follow-on GitHub/MCP registry release.
Invalid operator input causes a failed job.

This is a *control-plane gate*, not automatic validation of semver intent,
source-to-tag compatibility or production readiness; owners must review
those separately. Never publish a version merely to make a fork's CI green.

## Safe npm tags

The manually confirmed publish job selects `--tag next` whenever the
package semver contains a prerelease identifier (`-next.0`, `-rc.1`, etc).
Only stable semver versions can select `--tag latest`. This prevents an
integration candidate from changing what unsuspecting users install with
`npm install mcp-event-intelligence`. The npm registry existence check
still prevents overwriting an already published version.
