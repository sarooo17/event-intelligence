# Reference Host A — headless event-to-job integration

This is an **EI-maintained, executable example**, not a new EI SDK entrypoint
and not an independently authored external production integration. It uses the
public package path `mcp-event-intelligence/embedded` directly.

`examples/host-adapter/headless-job-host.mjs` embeds EI once at the host
boundary. The host supplies its authorized already-open MCP Events connection
registry, a deterministic host-owned receipt namespace, a current authorized
job lookup, a durable host receipt read and an atomic host enqueue.

A minimal application supplies:

```js
import {createHeadlessJobExample}
  from './examples/host-adapter/headless-job-host.mjs';

const app=await createHeadlessJobExample({
  store:yourEiStore,
  receiptNamespace:'your-validated-tenant-workspace',
  listConnections:()=>yourHost.mcpEventsConnections(),
  resolveLiveJob:(target,activation)=>yourHost.authorizedJob(target,activation),
  readReceipt:receiptId=>yourHost.outbox.read(receiptId),
  enqueueAtomic:({receiptId,target,activation})=>
    yourHost.outbox.enqueueAuthorizedAndDedupInOneTransaction({
      receiptId,target,activation,
    }),
});
try{
  // app.host exposes EI scoped trigger planning and lifecycle;
  // your host remains owner of source credentials, job queue and auth.
}finally{
  await app.close();
}
```

`enqueueAtomic()` **must** validate CURRENT host target/tenant permissions,
lock the relevant authority rows and commit a unique outbox+receipt in the
same durable DB transaction. It must return
`{receiptId,durable:true,duplicate:boolean}`. A function returning this
shape without the actual atomic transaction does **not** make a deployment
safe. `hasReceipt()` alone cannot exclude concurrent workers. Revocation
between target resolution and enqueue must be checked inside the durable
host transaction, not only in the example's earlier preflight.

No model-facing agent tools, prompt, workflow graph, runtime SDK or separate
MCP credential store are required. Test fixture Map storage demonstrates
a single-process contract only; `test/host-adapter-headless-reference.test.mjs`
executes a genuine EI Pattern v2 match -> wake -> host queue and hostile
wake/replay / revoked target probes against the same public facade.
It is *not* a real out-of-process job scheduler, an external event provider,
or an HA receipt demonstration. The independent PG16 host example and
multi-user scope controls are tracked separately under #352.

The adapter itself does not add any new EI production helper, package
export, dependency or runtime topology; count its complete host-owned code
when calculating net integration ROI rather than claiming it is all generic
kit glue.
