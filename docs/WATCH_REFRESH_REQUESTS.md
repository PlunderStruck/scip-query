# Watch Refresh Requests

## Contract

A watch refresh request is a durable command-side intent to make one project's
index current. Its concrete referents are the records created when a command or
agent hook observes a stale index and asks the live watch service to reindex.
It is a request record distinguished from ordinary watch activity by remaining
authoritative until a corresponding refresh attempt completes or its declared
deadline expires.

Watch activity is a disposable observation that a command recently used the
service. Its concrete referent is `watch-activity.json`; it is a
last-writer-wins timestamp whose only effect is extending the daemon's idle
lifetime. It is not a queue and carries no current refresh authority.

An admission is the successful publication of one complete immutable request
under `watch-refresh-requests/requests/`. Its defining property is that the
stable request path exists before the caller is told the request was accepted.
A claim is an exclusive processing marker for that admitted request. A
completion is a durable receipt proving that the attempt associated with the
claim finished successfully, or that the request expired before execution.

These records provide at-least-once execution for an accepted, unexpired
request. At-least-once execution means a crash after reindex success but before
the completion receipt may repeat the safe reindex operation; it never means an
unacknowledged request can disappear.

## Layout

```text
<project-cache>/
  watch-activity.json
  watch-refresh-requests/
    requests/<request-id>.json
    claims/<request-id>.json
    completions/<request-id>.json
    staging/
```

- `requests/` is the immutable admission log.
- `claims/` contains exclusive, temporary ownership markers.
- `completions/` contains immutable acknowledgements.
- `staging/` contains same-filesystem temporary files used to publish a
  complete record through an exclusive hard-link operation.

The request ID is random unless the caller supplies an idempotency key. An
idempotency key is a caller-chosen logical-operation identity whose hash
becomes the stable request ID; retries with that key observe the first admitted
request instead of appending another one. The first request's detail and
deadline remain authoritative.

## Lifecycle

1. The requester durably writes a complete staging record.
2. It exclusively links that record into `requests/`. A collision is a
   duplicate, not an overwrite.
3. The watch server, while holding the project watch lock, claims pending,
   unexpired requests through exclusive claim records.
4. It deliberately coalesces one claimed batch into one `watch-demand`
   refresh. Requests arriving while the watcher is busy remain pending.
5. A successful corresponding reindex writes every completion receipt before
   removing any claim.
6. A failed reindex removes its claims without writing completion, making the
   requests pending after a bounded retry delay.
7. A successor watch server removes predecessor claims only after acquiring
   the same exclusive watch lock. Completed requests remain completed; all
   other claimed requests become pending.

The default request deadline is ten minutes. An expired request gets an
explicit `expired` completion rather than being silently deleted. Completed
and expired history is retained for seven days; pruning removes only a receipt
and its already-acknowledged request. Pending and claimed requests are never
history-pruned. Idempotency is therefore guaranteed for at least the history
retention window.

## Crash and Concurrency Outcomes

| Boundary | Observable outcome |
| --- | --- |
| Crash before exclusive admission | No request was accepted; only staging may remain |
| Crash after admission before caller sees success | Request remains pending; retrying the same idempotency key returns the admitted request |
| Two callers use one idempotency key | Exactly one immutable request wins |
| Two callers use distinct keys | Both requests remain independently visible and may be coalesced deliberately |
| Crash after claim before reindex | Successor clears the stale claim and retries the request |
| Reindex failure | Claim is released; request remains pending |
| Crash after reindex before completion | Request may execute again; it is never lost |
| Crash after completion before claim removal | Completion prevents replay; successor removes the obsolete claim |
| Activity writer races any row above | Activity changes only `watch-activity.json` and cannot modify request state |

## Compatibility and Diagnostics

Protocol version 5 writers use the request store. During the overlap release,
the watch server still recognizes the former
`refreshRequestedAt`/`refreshDetail` fields if an older client writes them. On
observation it converts that timestamp to a deduplicated durable request before
processing it. New activity writers never place refresh intent in the activity
file.

`scip-query watch --status` reports pending, claimed, completed, expired, and
invalid record counts. A nonzero invalid count means an on-disk record failed
strict validation; the store does not treat malformed bytes as an accepted
request or completion.

This protocol does not promise exactly-once reindex execution. Exactly-once
execution would require atomically committing the index generation and the
request receipt across separate storage authorities. Reindex is safe to
repeat, so the protocol chooses the stronger practical guarantee: accepted
intent is never silently lost, and successful acknowledgement is never
inferred from absence.
