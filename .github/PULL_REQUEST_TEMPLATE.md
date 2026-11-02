## Problem and scope

<!-- What problem does this PR solve? Link related issues/acceptances. -->

Closes/advances:

## Behavior and host ownership

<!-- Identify affected contracts, sources, scope/tenant boundaries and who owns
permissions, approvals, continuation, durable receipts and credentials. -->

## Compatibility and persisted state

- Public API / schema / host contract: <!-- unchanged, changed with migration, or N/A -->
- Stored-state migration or fail-closed upgrade path: <!-- specify or N/A -->
- Downstream consumer pins / deployments: <!-- unchanged unless owner explicitly approved -->

## Tests and evidence

<!-- List exact commands and results. Include adverse tests for protocol,
multitenancy, replay, cancellation, crashes or fail-closed behavior as applicable.
For performance claims include raw artifacts, rates, hardware, source SHA,
timestamp and sample completeness. -->

## Security, privacy and evidence boundaries

- [ ] No credentials, private customer payloads or identifiers in changed files or artifacts.
- [ ] Authority and tenant/scoping behavior are preserved or explained.
- [ ] Tests and documentation cover changed semantics, including failure cases.
- [ ] Release/readiness/production claims distinguish implemented code from verified deployment evidence.
- [ ] Existing issue acceptance remains unchecked unless its exact evidence has been verified.

## Review and merge

- [ ] Required CI and package/PG checks green on the **final** HEAD.
- [ ] Independent review completed on the **final** HEAD; actionable threads resolved.
- [ ] No unauthorized npm publish, consumer upgrade or production deployment.
