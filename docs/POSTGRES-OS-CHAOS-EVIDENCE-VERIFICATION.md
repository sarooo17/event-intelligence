# Verifying raw PG16 OS SIGKILL soak evidence (#47)

The real-process soak fixture emits **success JSON only after all rounds finish**.
The workflow also produces an explicit status=incomplete JSON marker if a
run aborts. Neither a green ordinary CI job nor a PR comment is enough
to satisfy the actual 60-round evidence requirement.

## Obtain real artifacts

Use the already-merged GitHub Actions workflow:
**PostgreSQL OS Kill Chaos (bounded evidence)** → **Run workflow** →
branch **main**, rounds **60**.

The run archives pg-os-chaos-evidence.json (60 synthetic OS kills,
bounded timings and recovered receipt identities),
pg-os-chaos-test.log (actual Node assertions), and pg-os-chaos-host.txt
(exact checkout SHA, Node/driver/hardware and run identity).
A service startup failure can emit a different explicit incomplete
JSON marker through the independent fallback job: it is failure
evidence, never a pass.

First confirm the real bounded-os-chaos job concluded success. The
workflow must not have been cancelled. Record the GitHub Actions run
ID and attempt in #47, since runs may have multiple attempts.

## Verify the artifact bundle offline

After extracting the GitHub Actions artifact, run:

    node scripts/evidence/verify-postgres-os-chaos.mjs \
      --json pg-os-chaos-evidence.json \
      --host pg-os-chaos-host.txt \
      --log pg-os-chaos-test.log \
      --rounds 60 \
      --commit YOUR_EXACT_40_CHAR_CHECKED_OUT_SHA

The command exits nonzero unless report, host and log agree on:
60 distinct rounds; actual SIGKILL; separate victim/successor PIDs;
fencing generation 2; alternating workers; one unique deterministic
receipt per round; 60 recovered receipts; exact Node/driver/source-SHA
provenance; recalculated p50/p95/p99; and one successful Node OS-kill
test with zero failures. Incomplete markers, missing logs, wrong commits,
duplicate receipts and altered percentiles fail closed. Successful
stdout is a machine-readable verifier receipt.

This is a **consistency verifier**, NOT a cryptographic GitHub
attestation. Validate the actual run conclusion and source archive
through GitHub separately; an adversary with the ability to fabricate
the entire bundle can create self-consistent counterfeit metrics.
The test does NOT prove remote MCP provider replay, host effects,
production exactly-once, real elapsed lease expiry, network partitions,
high-cardinality CEP or primary database failover. #47 remains open
after this bounded fixture evidence.

Verifier unit tests are executed in ordinary CI without PostgreSQL;
they are not fake runs and do not add 60 actual process kills to each PR.
