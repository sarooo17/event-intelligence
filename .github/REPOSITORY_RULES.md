# Repository contribution and merge rules

These are **project conventions**, not a claim that GitHub branch protection
or a repository ruleset is currently enabled. GitHub Rulesets must be configured
by someone with repository administration rights in **Settings → Rules →
Rulesets**. A Markdown file does not enforce them.

## Intended protection of `main`

1. Require all changes by pull request (except separately authorized,
   logged emergency fixes).
2. Require the **exact final commit HEAD** to pass the applicable GitHub
   Actions checks; presently run families include CI, Clean-room Smoke,
   Security Scan, MCP Launch Check, Public Release Check and PostgreSQL
   validation smoke. GitHub rulesets normally reference check contexts/jobs,
   not merely the workflow display names: inspect actual check context names
   before enabling a status-check rule.
3. Require review by someone other than the PR author, including resolved
   actionable review threads. Automated Codex findings are additional review
   evidence, not an external human production/security certification.
4. Prevent force pushes and branch deletion on `main`. Avoid direct
   pushes except controlled emergency policy.
5. Restrict release tags/`latest` publication to the manual operator
   publishing workflow, keeping `next` separate from stable releases.
6. Never auto-promote the nine stable-v1 readiness rows or optional
   #376/#317 certification items because CI or a PR is green.

## Verification and maintenance

- Check [CONTRIBUTING.md](../CONTRIBUTING.md), the
  [PR template](PULL_REQUEST_TEMPLATE.md), and the
  [v1 readiness ledger](../docs/V1-READINESS-LEDGER.md).
- Any actual ruleset or status-check change requires repository admin access,
  an explicit review of available check contexts and an effective ruleset
  read-back. Do not claim this file itself configures branch protections.
- A personal/solo repository may not have an independent human reviewer;
  this should be stated as a limitation, not bypassed by falsely claiming one.
