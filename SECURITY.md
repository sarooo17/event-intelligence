# Security Policy

## Supported versions

The public package is pre-1.0. Security fixes are supported on the current 0.4.x line.

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| < 0.4 | No |

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

Event Intelligence 0.4.x is an experimental reference implementation with scoped multi-tenant host support. It is not a turnkey hardened hosted service.

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
- secrets belong in environment variables / secret managers, never committed files.

See `docs/SECURITY-MODEL.md` for the architectural model.
