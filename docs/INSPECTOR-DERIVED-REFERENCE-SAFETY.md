# Inspector derived-reference safety (v1 security slice)

Tracking [#45](https://github.com/sarooo17/event-intelligence/issues/45)
and [#48](https://github.com/sarooo17/event-intelligence/issues/48).

The trigger inspector's reference-only output must **not** forward arbitrary
provider-controlled `event.data._derived` objects as `contractVersion` or
`schemaFingerprint`. In particular, a malformed/older host store could
otherwise return a nested data object or execute an accessor when projecting
a lineage reference.

The inspector now projects these labels using **own data descriptors** without
calling accessor getters, and emits `null` for malformed provenance:

- `contractVersion`: nonempty string of at most 50 characters (the canonical
  wire label maximum).
- `schemaFingerprint`: lowercase 64-hex-character SHA-256 fingerprint.
- Any object, array, accessor property, or invalid value: `null`.
- A proxy-backed payload object or nested `_derived` object is rejected **before**
  descriptor reflection, avoiding invocation of proxy traps.

This applies to both raw source-event refs and the
`lineage.derivedOutputs` projection. Valid canonical scalar metadata is
preserved. The tests cover nested object and secret projection, malicious
getter access, malformed hash and valid version/hash preservation.

This is defense in depth against malformed stored provenance, **not** a
substitute for MCP Events input checking, host-owner authorization,
tenant/scope separation, or prompt-injection/taint handling.
