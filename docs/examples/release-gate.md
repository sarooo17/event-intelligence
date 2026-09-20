# Example: release gate without an always-on agent

Goal:

> After a PR merges and the deployment succeeds, wait for a stable period. If the release is still healthy, wake the release-review task.

A possible event graph is:

```text
github.pr.merged
        +
deploy.succeeded
        ↓
release.deployed@1
        ↓
absence(deploy.error, 10m)
        ↓
release.ready@1
        ↓
signed runtime wake
        ↓
release-review task
```

The model/runtime does not need to remain active during the wait.

## Why derived events?

Without composition the final trigger would need to know every low-level provider event forever.

With composition, a reusable semantic boundary can be introduced:

```text
provider facts -> release.ready@1
```

Other agents or triggers can consume that contract without knowing how readiness was derived.

## Provenance

A downstream event keeps flattened root evidence:

```text
release.ready@1
  ├─ github delivery ref
  ├─ deploy event ref
  └─ timer/deadline ref
```

The lineage does not copy the full provider payload.

## Restart behavior

If the service stops during the 10-minute stability window, the deadline remains persisted. On restart, the scheduler recovers due work and re-enters it as an internal timer occurrence.

The full-system acceptance test exercises this behavior with the actual service process and a signed generic runtime receiver.
