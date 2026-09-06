# Dispatch Desk

A small reservation and order service with web, administrative, and scheduled-job entry points.

Run `npm test` for the original smoke checks and any added `test/*.test.mjs` tests. Use Node's built-in test and assertion modules for added tests. Only the original `test/smoke.test.mjs` is frozen; tests added for a changed requirement may be updated when that requirement changes again. Public operations are exported from `src/index.ts`.

Responsibilities:

- `domain` defines shared records and shipping calculations. It receives configuration from callers and must not import adapters.
- `reservations` owns cancellation eligibility and the transition that records a cancellation. All channels must enforce the same eligibility rule.
- `pricing` owns quote calculations. Card charges and refunds have independently changing fee policies; sharing arithmetic must preserve that independence.
- `notifications` owns receipt construction and writes to a caller-supplied receipt store. Store lifetime belongs to the caller.
- `adapters` translates incoming requests and supplies configuration. It must not contain a competing implementation of a business rule.

The `.scipquery.json` dependency policy is fixed for this exercise. Existing public operation names and their result shapes are contracts unless a task explicitly extends them. Some inherited implementations do not yet satisfy the responsibilities above; address the requested area without unrelated rewrites.
