# MCP Events Beta boundary — 2026-11-22 source alignment

> **Review scope:** source branch for [#424](https://github.com/sarooo17/event-intelligence/issues/424). This is **not** a publication, upstream conformance certification, production security assessment or a retroactive change to the immutable `mcp-event-intelligence@1.0.0` package.

## Authoritative target

- [Official MCP Events Beta specification](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx) (inspected 2026-11-22); extension `io.modelcontextprotocol/events`, [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md) Final.
- [Official Events overview](https://modelcontextprotocol.io/extensions/events/overview).
- Events requires **MCP protocol revision `2026-07-28` or later**. In that revision, the host retrieves server capabilities via `server/discover`. This is **not** a request for EI to resurrect the removed *legacy pre-v1 experimental* `server/discover` adapter: the host's normal core MCP implementation owns discovery, connection lifecycle, authentication and transports.

Beta is a lifecycle stage, not a claim that all deployed servers or SDKs support the extension. The specification can still evolve; rerun contract verification before any release.

## Explicit compatibility profile

| Source behavior | EI main / proposed #424 branch |
| --- | --- |
| Published npm `1.0.0` | Historical `experimental-extension-2026-09-25` compatibility; unchanged |
| Source default `auto` before a new versioned release | Still `experimental-extension-2026-09-25`, preserving v1.0 release ABI checks |
| Source-only opt-in | `compatibilityProfile: 'beta-extension-2026-11-22'` |
| Beta profile minimum MCP protocol revision | `2026-07-28`; **host must enforce** (EI does not independently negotiate a transport revision) |
| Extension key | `capabilities.extensions['io.modelcontextprotocol/events']` |
| Wire methods used by EI's built-in poll client | `events/list` and `events/poll` |

Example for a connected host client on a compatible MCP revision:

```js
import { createHostMcpEventsConnection } from 'mcp-event-intelligence/host';

const connection = createHostMcpEventsConnection({
  connectionId: 'upstream-mcp',
  client: hostOwnedMcpClient,
  compatibilityProfile: 'beta-extension-2026-11-22',
});
```

The host must supply server capabilities from the currently authorized **core** `server/discover` result through `getCapabilities()`, `getServerCapabilities()` or `capabilities`. EI checks the advertised extension before issuing `events/*`; it does not call `server/discover` itself. The example applies to updated branch source, **not** the published npm v1.0.0 tarball.

## Boundary review matrix

| Beta requirement | Responsibility / current evidence |
| --- | --- |
| `events/list`, optional pagination, descriptors and `resultType: "complete"` | EI provider + reference server local checks; discovery pagination implemented in provider/client; reference server supplies a complete single page |
| `events/poll`, maxEvents, resultType, `-32023..-32027` family, typed cursors, truncated/hasMore | EI provider + reference server checks; existing #166 wire and adversarial tests |
| `maxAgeMs` integer milliseconds | **Fixed in this branch**: both provider and reference server reject fractional, negative, non-number and unsafe integers before callback/store side effects |
| Normal poll floor, backlog cap, resume and source-gap-safe negative CEP | Already implemented under #166; no engine redesign |
| Dynamic event types: `notifications/events/list_changed`, `subscriptions/listen` filter `eventsListChanged` | Native host MCP subscription behavior; EI's static provider truthfully advertises `listChanged:false`. A host must refresh EI's registry when its discovery changes. No claim of automatic live notification integration |
| `events/stream` push lifecycle, heartbeat, unsubscribe/cancellation | Host-owned stream transport; EI accepts already-validated callback deliveries through `openEventStream()`. The poll-backed provider MUST NOT advertise native push-only implementation |
| `events/subscribe`/`events/unsubscribe`, signed webhook callbacks, endpoint verification, TTL, retry and revocation | Host-owned server/client/webhook gateway; EI accepts normalized deliveries through `createWebhookSubscription()`. **Not implemented by the EI provider** |
| Streamable HTTP `Mcp-Name` on `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe` | **Mandatory for the host's HTTP transport**; `events/list` has no `Mcp-Name`. EI's abstract `request(method, params)` has no HTTP header surface |
| `x-mcp-header` inputSchema annotation and matching `Mcp-Param-*` HTTP headers | **Mandatory for Streamable HTTP clients** that support the annotated event type; host transport must enforce with current descriptors and reject/rediscover invalid schemas |
| Per-request `io.modelcontextprotocol/clientCapabilities` opt-in, required protocol revision, authorization/session fencing | Host/official MCP SDK; EI trusts a validated, host-owned connection and never grants action authority from event receipt |
| Omitted/null wire cursor | **Beta: absent is null everywhere on the wire**; poll provider/client already normalize missing to null. Host-owned push/webhook callbacks are currently **not raw wire frames** and intentionally treat callback omission as 'no cursor update'. Until the separately reviewed mapping is implemented, a host adapter MUST translate an omitted **native wire cursor** to **explicit `cursor:null`** before handing it to EI's `onEvent`/`onActive` or delivery handle. Never silently claim raw Beta callback conformance |
| Provider stream/webhook end-to-end, upstream conformance server/client suites | **NOT TESTED** in #424; the local tests are not independent external conformance evidence |

### Cursor adapter safety

The normative Beta specification treats absent `cursor` as equivalent to `null` on request/response/wire payloads. EI's host callback interface historically reserves *absence of the field* to mean 'no state patch', whereas *explicit null* means 'reset cursor'. This difference is intentional **internal** API behavior for already-integrated hosts, but **not** compliant if a host forwards native wire bodies without normalizing them. Do not change existing persisted resume cursors silently. Track an independently reviewed adapter contract/test before claiming complete Beta push/webhook ingestion.

### Release and conformance gates

1. Run this branch's dedicated unit tests and complete CI on the exact reviewed HEAD. Tests in `test/mcp-events-beta-contract.test.mjs` assert local semantics only.
2. Separately run the **official upstream conformance server/client suites** against an actual Beta-capable MCP host/provider with HTTP routing, headers and, where relevant, native stream/webhook. **Until run, report NOT TESTED**, never PASS.
3. Review native host adapter cursor conversion, server discovery refresh and access revocation. Defer any change of the default compatibility profile to a **versioned, reviewed release** with updated release matrix and an explicit user publication decision.
4. Keep npm, MCP Registry, release tag, deployed services and downstream Muffin/Artemis dependencies unchanged by this PR.

Related: [#166](https://github.com/sarooo17/event-intelligence/issues/166) (draft SEP A/B/C corrections, already closed), [#317](https://github.com/sarooo17/event-intelligence/issues/317) and [#376](https://github.com/sarooo17/event-intelligence/issues/376) (optional external production evidence).
