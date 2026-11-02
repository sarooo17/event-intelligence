# Security Policy

## Supported versions

The public package remains **pre-1.0**. The npm versions UI screenshot checked on 2026-11-02 confirms
`0.12.0-next.1` on `next` and `0.11.0` on `latest`; pinned consumers
must explicitly opt into the prerelease. This prerelease is **not** a third-party security audit or stable `1.0.0`
certification. Existing hosts keep their explicitly pinned versions.

| Version / channel | Security maintenance |
| --- | --- |
| `0.12.0-next.1` (npm `next`, visually verified 2026-11-02) | Current preview candidate; fixes only via a **new** reviewed/published version, not mutation of the existing artifact |
| `0.11.x` (prior stable release line; npm `latest` was `0.11.0` on 2026-11-02) | Maintenance where practical; no guaranteed backport SLA |
| `0.1.x`–`0.10.x` | Unsupported; upgrade deliberately |
| Current repository `main` | Under CI/review; a source commit is **not** itself a published security release |

Publishing a new package version does not change downstream applications
pinned to an exact version; consuming hosts must opt into any upgrade.
This table describes the repository's support policy, not a certification
or evidence that any particular release is free of vulnerabilities.

## Reporting a vulnerability

Please do **not** open a public issue with exploit details, credentials, private payloads, or reproduction secrets.

Use GitHub's private vulnerability reporting / security advisory flow for this repository when available. If the repository UI does not expose a private reporting option, open a minimal public issue asking the maintainer for a private contact channel **without including vulnerability details**.

Useful reports include:

- affected version/commit;
- impacted endpoint, protocol object, or runtime adapter;
- minimum reproduction;
- security impact;
- whether the issue requires authenticated access;
- suggested mitigation, if known.

## Security boundaries

Event Intelligence is a pre-v1 runtime-neutral SDK with scoped multi-tenant host support. The reviewed library/reference tests do **not** certify security of any independently operated host, OAuth system, transport, or deployed production environment ([#317](https://github.com/sarooo17/event-intelligence/issues/317)).

Important defaults and constraints:

- tenant/workspace isolation is implemented through scoped store partitions; tenant-facing code should receive only the corresponding scoped host view;
- protected standalone control-plane endpoints require `SERVICE_AUTH_TOKEN`;
- GitHub ingress verifies provider HMAC when configured;
- standalone runtime wake packets are HMAC-signed and runtime targets are operator-configured;
- embedded wakes preserve the configured continuation separately from untrusted matched-event evidence;
- event receipt never grants new downstream authorization;
- arbitrary public HTTP wake targets are rejected;
- derived-event lineage is refs-only by default;
- audit records are hash-linked and tamper-evident, not tamper-proof;
- the bundled JSONL store is single-process reference infrastructure and is not safe as a shared multi-replica backend;
- horizontally scaled custom stores must preserve scope isolation and implement wake claim/lease operations atomically;
- explicit shared-worker mode (`EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE=true`) rejects enabled MCP connections without host-generated authority epochs and rejects stores without strict PostgreSQL session fencing; host-managed dynamic registry attachments follow the same rule. This is a pre-v1 compatibility hardening: legacy unfenced MCP connections must use single-process/reference mode, not be silently accepted in shared deployment;
- secrets belong in environment variables / secret managers, never committed files.

See `docs/SECURITY-MODEL.md` for the architectural model.
