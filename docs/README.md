# Documentation

Documentation for the current source and pre-v1 SDK preview (`mcp-event-intelligence@0.12.0-next.1`, maintainer-reported npm publication; verify the npm registry before installation). The unqualified npm `latest` tag and the MCP Registry listing are separate release channels:

- [Quickstart](QUICKSTART.md)
- [Embedded runtime integration](embedded-runtime-integration.md)
- [Architecture](ARCHITECTURE.md)
- [Storage and shared state](STORAGE.md)
- [Pattern AST evidence harness](EVIDENCE.md)
- [Host conformance](../conformance/README.md)
- [Security model](SECURITY-MODEL.md)
- [Internal protocol](PROTOCOL.md)
- [MCP Registry](MCP-REGISTRY.md)
- [Release-gate example](examples/release-gate.md)
- [Current `0.12.0-next.1` preview release notes](releases/v0.12.0-next.1.md)
- [Preview compatibility / host migration](releases/0.12.0-next.1-compatibility.md)
- [Earlier `0.11.0` stable release notes](releases/v0.11.0.md)
- [Release history](releases/)

## Stable v1 release readiness (implementation largely complete, approval pending)

- [Current authoritative v1 status and required/optional gate boundary](https://github.com/sarooo17/event-intelligence/issues/41)
- [Machine-readable stable v1 readiness and review procedure](V1-READINESS-LEDGER.md)
- [SDK vs. independent production/enterprise certification](V1-SDK-RELEASE-SCOPE.md)
- [Original v1 engineering plan (historical snapshot)](EI-V1-ROADMAP.md)
- [Original embedded integration design (historical proposal)](EI-INTEGRATION-V1-DESIGN.md)
- [Release and consumer compatibility policy](EI-RELEASE-COMPATIBILITY.md)
- [GitHub tracking epic](https://github.com/sarooo17/event-intelligence/issues/41)

**Versioning:** the package version, Pattern wire schema (`version: "2"`), internal EI protocol and experimental MCP Events compatibility profiles evolve separately. A v1 roadmap document does not certify v1.0 behavior.

The executable implementation, schemas and tests are authoritative when prose and code disagree.

This is an independent open-source project. It is not an official Model Context Protocol specification and is not affiliated with or endorsed by the MCP maintainers.
