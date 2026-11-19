# Security Policy

## Supported versions

**Current published stable release:** `mcp-event-intelligence@1.0.0`. The [manual npm publication](https://github.com/sarooo17/event-intelligence/actions/runs/43035988681) on **2026-11-11** used npm `latest`; the [release workflow](https://github.com/sarooo17/event-intelligence/actions/runs/43036379159) published MCP Registry `io.github.sarooo17/event-intelligence@1.0.0` and tag `v1.0.0`. Security maintenance is **best-effort**; no guaranteed vulnerability response, backport SLA or independently certified host-security posture is promised.

| Version / channel | Security maintenance |
| --- | --- |
| `1.0.0` (published stable; npm `latest` at release) | Current supported version; fixes require a newly reviewed version, never a mutation of an existing npm artifact |
| `0.12.0-next.1` (historical npm `next` prerelease) | Superseded preview; upgrade deliberately using v1 migration guidance |
| `0.11.x` (older release line) | Legacy; no guaranteed backport SLA or ongoing maintenance |
| `0.1.x`–`0.10.x` | Unsupported |
| Repository `main` after `v1.0.0` | Development/documentation; not a replacement for the immutable published package or a security release |

Updating an npm package does not change downstream hosts pinned to an exact version and does **not** migrate persisted triggers, event records or host receipts. Consult the [1.0.0 compatibility and operator upgrade matrix](docs/releases/1.0.0-compatibility.md) before deploying a new version. A published stable SDK is **not** a third-party penetration test, production HA certification or evidence that a particular version is vulnerability-free.

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

Event Intelligence 1.0.0 is a published runtime-neutral SDK with scoped multi-tenant host support. The reviewed library/reference tests do **not** certify security of any independently operated host, OAuth system, transport, or deployed production environment ([#317](https://github.com/sarooo17/event-intelligence/issues/317)).

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
- explicit shared-worker mode (`EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE=true`) rejects enabled MCP connections without host-generated authority epochs and rejects stores without strict PostgreSQL session fencing; host-managed dynamic registry attachments follow the same rule. This is a v1 safety boundary: legacy unfenced MCP connections must use single-process/reference mode, not be silently accepted in a shared deployment;
- secrets belong in environment variables / secret managers, never committed files.

See `docs/SECURITY-MODEL.md` for the architectural model.
