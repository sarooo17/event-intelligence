# Source-pinned host conformance and ergonomics (#272)

This is an intentionally **bounded engineering report**, not third-party
adoption, a production latency SLO or proof of universal adapter savings.
The product owner waived a second developer for **#42**, and the result is
clearly recorded as a *governance choice*, not as a self-certified adoption.

CI workflow `.github/workflows/host-ergonomics-report.yml` creates an
artifact `host-ergonomics-source-pinned/host-ergonomics.json`. The report
reads entire immutable revision-pinned files, not selected glue lines:

| Source | Revision |
| --- | --- |
| Muffin baseline `agent/event-intelligence.ts` | `a6e6bfaec5d6847b1985980fe6f524ef0193dc02` |
| Muffin canonical adapter PR #17 | `5f68a51bd99568bd8268d3d5ab9a1947b81d041b` |
| EI original embedded core | `v0.11.0` |
| EI revised embedded core | actual CI checkout SHA |

The complete Muffin adapter went from **398 physical / 365 nonblank LOC**
to **391 / 360** (only **7 physical lines fewer, ~1.8%**). The report
also measures the corresponding existing EI embedded-core module, and
prints the combined **two-file source slice** delta. That delta is NOT
an entire application or project accounting: unrelated EI capabilities,
tests and libraries are deliberately not silently claimed as kit savings.
No new generic adapter-kit module was shipped, and PR #274 was rejected
for unnecessary public wrapper indirection.

The test runs the *real* locally authored v3 management matrix:
three integration boundaries, seven scenarios each, and reports
`fixtureAuthorship` for every entry plus
`independentExternalHostVerified:false`. A separate clean-room test in
CI already verifies packed headless and multi-target hosts. Runtime
setup timings measure only construction/close of a stub EI facade over
five attempts, in the GitHub Actions execution environment. No human
integration time, deployed host performance, network latency or SLO
can be inferred from these millisecond figures.

**Result:** conformance is reproducible and the net LOC benefit is
negligible; there is no evidence for a universally "tiny" adapter.
Keep #269 open for real total-integration-cost improvements without
moving host policy, credentials, authority or evidence taint into EI.
The #45/#47/#50 production security, SLO and stable-release gates stay open.
