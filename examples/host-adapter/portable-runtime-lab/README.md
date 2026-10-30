# Native agent-tool portability lab (EI-maintained, isolated npm consumer)

Purpose: determine whether a **new**, small, runtime-neutral tool bridge would
actually reduce the code needed to adopt Event Intelligence, or whether the
existing `mcp-event-intelligence/embedded` facade already handles the shared
work. This is a **test runtime, not the Event Intelligence runtime itself**.

Unlike the previously supplied headless and multi-org/PG16 host fixtures,
this one implements a small **native tool-enabled host** (its own admission,
principal tickets, membership, agent and graph identity, tools and result ABI)
without importing EI. It then adds EI *only* in `ei-bridge.mjs`.
The package installs **published npm** `0.12.0-next.0` using a separate
project `package.json` and pinned SHA-512 lock. No source code from EI and no
vendor SDK is imported by the host. Neither Muffin nor Artemis is a dependency.

## Source ownership, not line-count theater

| File | Responsibility |
| --- | --- |
| `host.mjs` | 100% host-owned: users, agents/graphs, teams, membership, tickets, native tool registration, host-only wake receipt simulation |
| `ei-bridge.mjs` | **Only EI-specific integration**: `mcp.list`, wake callbacks, authenticated context, native bind, taint |
| `test.mjs` | EI public-package integration and negative test scenarios |
| `package.json` / lock | Separate public npm consumer install, no local path override |

Counts must be generated from whole files after a verified final HEAD.
Do not count `host.mjs` as EI adapter glue, *but* do count all host code
when reporting **total from-scratch implementation cost**, and never
subtract a purpose-built lab from real production app code.

## Scenarios

- Two organizations, multiple teams and users; owner vs teammate, agent
  vs graph target, current-membership checks on every invocation.
- Host-minted opaque invocation tickets: a forged model or MCP payload cannot
  become a principal, and a revoked user's old ticket is denied.
- Real eight-tool EI portable catalog mapped to the host's native function
  descriptor ABI, static capability allowlisting and fail-before-register
  on unknown capabilities, no automatic write permission.
- The exact same canonical public embedded entry point in headless mode
  exposes **zero** model tools.
- Native results are **structured with explicit untrusted provenance**, never
  rendered as trusted prompts. Existing host-specific tool UI is not in EI.
- Host wake target ownership, basic duplicate receipt, forged collisions and
  revocation after resolution.
- Real CEP event registration, native tool-based trigger creation with explicit
  owner vs teammate denial, per-org trigger listing and a matched source event
  delivering exactly one wake to the appropriate agent (single process only).

**Critical limitations:** this fixture's authority and receipt maps are
**in process**. They are not an HA database, do not establish cross-worker
exactly-once effects, and cannot demonstrate a durable post-commit/SIGKILL
recovery or real authorization tokens. Existing independently tested
PostgreSQL 16 graph+host outbox reference covers those **bounded** cases;
neither artifact constitutes external production security certification.
Test authorship is EI-maintained, not third-party independent.

## Run and decisions

```sh
cd examples/host-adapter/portable-runtime-lab
npm ci
npm test
```

Do not add another EI helper unless this lab **plus distinct external
tool-enabled consumers** show duplicated safe glue, a lower *combined*
host+new EI runtime/typings/dependencies footprint, and no
regression in tenant policy, native approval/interrupt/taint, or receipts.
The design hypothesis is that **one host-native mapping is unavoidable**
but a second generic composer would be redundant. All code remains on an
unmerged research PR; never auto-update Artemis/Muffin or publish npm.
