# Contributing

Thanks for helping improve MCP Event Intelligence.

This project is an experimental reference implementation for durable event-driven agent continuations. Contributions should preserve the separation between:

```text
event transport
→ durable correlation / temporal reasoning
→ derived semantic events
→ runtime execution
```

## Before opening a PR

1. Check whether the change belongs in Event Intelligence rather than in a provider adapter or agent runtime.
2. Do not introduce a proprietary replacement for MCP Events transport when compatibility or upstream feedback would solve the problem.
3. Add deterministic tests for protocol/lifecycle changes.
4. Preserve refs-first provenance and fail-closed validation.
5. Update public documentation when behavior changes.

## Development

Requirements:

- Node.js 22+

```bash
npm ci
npm run check
npm run pack:check
```

For changes to the public release surface, also run:

```bash
docker build -t mcp-event-intelligence:dev .
```

## Pull requests

A useful PR explains:

- the problem;
- the protocol/runtime invariant being changed;
- compatibility impact;
- tests/evidence;
- known limitations.

Avoid broad refactors mixed with protocol semantics unless they are required for the change.

## Areas where contributions are especially useful

- MCP Events compatibility and field reports;
- additional provider ingress adapters;
- runtime adapters;
- late/out-of-order event semantics;
- reliability / chaos / load benchmarks;
- transactional production storage;
- security review;
- inspector / observability improvements;
- reproducible examples.

## Protocol changes

The current trigger protocol and schema are `0.2.0` / `trigger.v0.2`, with canonical Pattern AST `version: "2"`; the internal persisted compatibility markers are separate from npm releases. The current source package is `0.12.0-next.1` (pre-v1), not `0.5.x`. Review [the version-specific compatibility matrix](docs/releases/0.12.0-next.1-compatibility.md) before changing public or durable contracts. The contracts are experimental but versioned.

Changes that alter trigger semantics, derived-event contracts, wake lifecycle, or persistence compatibility need:

- an explicit compatibility note;
- tests for old and new behavior;
- a schema/protocol version decision.

## Security

Do not include vulnerability details in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under Apache-2.0.
