# Portable tool presentation decision — issue #270

**Decision (candidate for independent review): retain the existing canonical binder and result contracts. Do not ship a second generic tool-adapter or result renderer.** This is a *no-additional-API* closeout, not a claim that an imaginary universal bridge was implemented.

## Duplicated-glue audit

The original proposal identified approximately 76 physical Muffin lines involving eight tool descriptors, result/error formatting, external metadata and native capability registration. The existing public `/embedded` surface already supplies:

- `PortableAgentTool` and `PortableToolResult` (including optional inline/reference projection), plus metadata and modeled input/output schemas.
- `createPortableToolCatalog()`, `integration.toolCatalog`, and `bindEmbeddedRuntimeIntegration({adapt, register, capabilityIds})`. Static exposure filtering and *all* native adaptations execute before the first registration, as verified by #281.
- `projectResult` / `projectError` under the existing host tooling configuration. A host may inline, externalize, annotate or reject a result without EI providing a second result schema.

The #274 `createPortableToolAdapter` trial merely forwarded an `adapt` callback that the binder already accepts. Its extra exported function did not remove ownership or boilerplate and was rejected instead of merged. A new data-only envelope or a generic `toTool()` wrapper would duplicate existing contracts unless *two real independent runtimes* demonstrate repeated non-policy glue.

The added `host-tool-presentation-closeout` regression exercises genuinely different **synthetic** RPC and function-descriptor tool ABIs and a headless host, unknown static capability failures, host tenant and context-size guards, native interruption and denial fidelity. It does **not** claim those synthetic fixtures are third-party integration or make EI responsible for host authorization.

## Source-pinned cost, including proposed kit

The source-pinned #282 report (`docs/HOST-ERGONOMICS-CLOSEOUT.md`, immutable Git blob verification in `host-adapter-ergonomics-report.mjs`) measures entire Muffin adapter revisions, not only the 76-line region:

| Component | Earlier | Canonical candidate | Delta |
| --- | ---: | ---: | ---: |
| Muffin adapter, full physical lines | 398 | 391 | **−7** |
| Muffin adapter, nonblank lines | 365 | 360 | **−5** |
| New generic tool-bridge implementation modules shipped | 0 | 0 | **0** |

**Kit-specific new runtime LOC: 0; consumer-plus-new-bridge LOC: −7 physical, relative to the earlier Muffin candidate.** This is only a 1.8% adapter reduction and is **not** evidence of a meaningful ergonomic improvement. The existing EI embedded core has also evolved with unrelated features; #282 captures its complete original-vs-current source-slice delta rather than charging or hiding it as a host-bridge saving. This audit does not establish project-wide net cost, developer-time ROI, or a second consumer's LOC savings. The changed test/docs files are regression/audit cost, not a production helper relocated into EI. If a generic bridge is reconsidered, it must account for all *new library lines* and the complete app before/after, not only removed adapter lines.

## Semantic and authority invariants

The native host remains responsible for principal/tenant discovery and authorization, schema and permission checks at actual execution, taint labeling of event-derived text, interrupt/approval semantics, result storage, budget/size policy, and tool registration rollback if a native `register()` fails. EI does not treat provider payloads or a `metadata.allowed` field as authorization. Presentation is not an authority grant.

No new EI result schema, host-policy mapping, runtime-specific import, SDK dependency, MCP provider profile, persisted state, scheduler, packaging entry point, or compatibility shim is introduced. Existing ESM/TypeScript `/embedded` exports remain unchanged; package tarball and source/packed clean-room type/export gates must stay green. No npm version is published and no consumer manifests are updated.

## Acceptance interpretation

Issue #270 began as a *conditional proposal* to ship a helper **only where repeated glue proves a meaningful benefit**. The defensible engineering outcome is **rejection of that helper**, not checking its implementation boxes as though it shipped. The parent #269 ROI / portable-bridge acceptance remains open until evidence from separate real host implementations supports an alternative that wins on combined code cost, integration time and security.

Release/security readiness remain gated separately by issues #45, #47 and #50. Independent final-HEAD review and CI evidence must be attached before recording this decision as complete.
