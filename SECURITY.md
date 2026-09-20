# Security Policy

## Supported versions

The public reference implementation is currently pre-1.0.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

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

Event Intelligence v0.1 is a reference implementation, not a hardened multi-tenant hosted service.

Important defaults and constraints:

- protected control-plane endpoints require `SERVICE_AUTH_TOKEN`;
- GitHub ingress verifies provider HMAC when configured;
- runtime wake packets are HMAC-signed and runtime targets are operator-configured;
- arbitrary public HTTP wake targets are rejected;
- derived-event lineage is refs-only by default;
- audit records are hash-linked and tamper-evident, not tamper-proof;
- the JSONL store is single-writer and not safe for horizontal multi-replica deployment;
- secrets belong in environment variables / secret managers, never committed files.

See `docs/SECURITY-MODEL.md` for the architectural model.
