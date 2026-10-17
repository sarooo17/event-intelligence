# Host v3 reference matrix — evidence and limitations

This matrix is a reproducible **repository-maintained conformance exercise** for
[issue #42](https://github.com/sarooo17/event-intelligence/issues/42).
It executes **all seven real host-conformance v3 management scenarios** per
fixture, including trigger create/list/pause/resume/update/delete, persistent
wake/receipt replay after restart, maxFirings and observability redaction.

Run after building the package:

```bash
npm run build
node conformance/host-v3-matrix.mjs
# Or include it in all CI tests:
node --test test/host-v3-matrix.test.mjs
```

The JSON report is `event-intelligence.host-v3-matrix.v1`. Each fixture
includes the actual unmodified `runHostConformance()` v3 report and explicitly
declares integration style, execution boundary and provenance.

| Fixture | Host integration | Execution boundary | Authorship |
| --- | --- | --- | --- |
| `reference-direct-in-process` | EI reference host, direct engine | In process | EI repository |
| `reference-neutral-in-process` | `createEventIntelligence()` neutral façade | In process | EI repository |
| `reference-forked-os-process` | Separate IPC reference host | OS process, SIGKILL/reopen | EI repository |

**What a green report proves:** these *three local host shapes* satisfy the
current v3 management harness and its deterministic synthetic source/receipt
contract. The OS-process fixture actually kills and restarts the reference
worker and reloads its durable EI store. No models or real external MCP
servers are needed for a reproducible gate.

**What it does not prove:** three independently written host implementations;
third-party adoption; published npm consumer conformity; network transport
reconnect to real external services; PostgreSQL multi-worker failover; exactly
once execution of external host effects; end-to-end approval/interrupt policy
across arbitrary runtimes. In particular,
`independentExternalHostVerified: false` remains **false by construction**
regardless of all local test results. Claiming independence requires a genuinely
external author and reproducible evidence supplied by that integration.

No compatibility adapters, second scheduler, agent loop or runtime-name
dispatch are added. Existing public conformance interface remains v3; this
matrix is a repo-local verification orchestrator, not a replacement for the
independently authored host requirement in #42.
