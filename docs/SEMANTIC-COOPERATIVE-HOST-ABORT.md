# Cooperative semantic provider cancellation — host-neutral contract

`SemanticEvaluator.evaluate(request, options?)` accepts an **optional**
second argument `{signal?:AbortSignal}`. Existing evaluator implementations
taking only `request` remain source-compatible, and the first argument
remains exactly `{instruction,input}`: no provider SDK and no raw event
payload leak into a new control channel.

The canonical Pattern v2 evaluator creates an AbortController per external
semantic call, passes its signal through `SemanticConditionEngine`, and
aborts when either the existing node timeout or the optional cumulative
batch elapsed budget fires. Timeout settlement is queued **before** the
abort notification so a cooperative adapter's immediate `AbortError`
cannot override EI's stable node-timeout error or batch
`truncated:true` contract. The independent provider mock regression
checks both paths.

This is **cooperative, not a hard provider cancellation guarantee**:
an adapter that ignores AbortSignal or a provider that has already begun
billable inference may still use tokens after EI stops awaiting it.
Pre-call PostgreSQL admission from #328/#329 conservatively reserves
the host-estimated upper-bound tokens/cost even if a call times out.
Never issue a credit/retry that would bypass the durable reservation
after cancellation or a crash.

To certify actual provider-billed token and cost limits, connect a real
provider that both applies server-side max-output-token limits and
honors request cancellation, and reconcile signed/trusted usage receipts
against reserved cost. That signoff is outside EI's generic runtime
and remains an explicit residual for #49 acceptance #3.
