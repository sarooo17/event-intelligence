# Documentation

Documentation for **published Event Intelligence SDK `1.0.0`** (npm stable `latest` and official MCP Registry `io.github.sarooo17/event-intelligence@1.0.0`, released 2026-11-11). Use [v1 compatibility and operator migration guidance](releases/1.0.0-compatibility.md) before upgrading an existing host. npm `next` and older releases are historical channels, not the current stable install recommendation.

- [AI coding agent integration (consumer-focused)](AI-AGENT-INTEGRATION.md)
- [Repo AGENTS.md (for contributing agents)](../AGENTS.md)
- [Portable integration Agent Skill](../.agents/skills/event-intelligence-integration/SKILL.md)
- [LLM discovery index](../llms.txt)
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
- [Published v1.0.0 release notes](releases/v1.0.0.md)
- [Current stable v1.0.0 compatibility / operator migration](releases/1.0.0-compatibility.md)
- [Historical `0.12.0-next.1` preview](releases/v0.12.0-next.1.md)
- [Earlier `0.11.0` release](releases/v0.11.0.md)
- [Release history](releases/)

## Published v1.0.0 release and outstanding production certifications

- [Completed v1.0 milestone and verified release evidence](https://github.com/sarooo17/event-intelligence/issues/41)
- [Machine-readable stable v1 readiness and review procedure](V1-READINESS-LEDGER.md)
- [SDK vs. independent production/enterprise certification](V1-SDK-RELEASE-SCOPE.md)
- [Original v1 engineering plan (historical snapshot)](EI-V1-ROADMAP.md)
- [Original embedded integration design (historical proposal)](EI-INTEGRATION-V1-DESIGN.md)
- [Release and consumer compatibility policy](EI-RELEASE-COMPATIBILITY.md)
- [Published GitHub Release](https://github.com/sarooo17/event-intelligence/releases/tag/v1.0.0)

**Versioning:** the package version, Pattern wire schema (`version: "2"`), internal EI protocol and experimental MCP Events compatibility profiles evolve separately. A v1 roadmap document does not certify v1.0 behavior.

The executable implementation, schemas and tests are authoritative when prose and code disagree.

This is an independent open-source project. It is not an official Model Context Protocol specification and is not affiliated with or endorsed by the MCP maintainers.
