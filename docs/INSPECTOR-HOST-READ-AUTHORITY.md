# Host-owned inspection security boundary — #48

A raw `TriggerInspector` is a low-level *trusted-store* reader, not an
authorization engine. Every remotely exposed inspection must first
validate the caller's principal, tenant, exact trigger identity and
version using the existing `createOwnerReadGuard` host boundary.

The real PostgreSQL 16 test
`test/postgres-inspector-restart.test.mjs` now verifies that host-owned
delegation **never calls the inspector** for a forged same-tenant
principal or a wrong-tenant principal, even when both scoped databases
have exactly the same trigger, version and match IDs. Permitted owners
can inspect only their own source references; raw payload secrets are
omitted and denied errors do not reveal foreign source IDs. An actual
independent pool/inspector restart and bounded history query remain
part of the same test.

The test covers the authorized host boundary, not direct invocation of
a low-level `TriggerInspector` by a caller who already possesses the
trusted store. Hosts must not expose raw storage capabilities to
untrusted agent tools. Independent external host permission testing and
security certification remain gated under #317. No EI-owned OAuth,
permissions or new adapter path is introduced.
