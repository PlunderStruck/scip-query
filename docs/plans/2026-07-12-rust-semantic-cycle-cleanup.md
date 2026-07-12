# Rust Semantic Cycle Cleanup

Date: 2026-07-12
Status: Complete

## Goal

Remove the four graph-confirmed Rust semantic dependency cycles and consolidate
the two exact duplicate infrastructure helpers without changing semantic
answers, fallback behavior, or durable-session protocol payloads.

## Current State and Reuse Audit

- `scip-query cycles --json` reports four real cycles, all through
  `lsp-session.ts` and its provider, import-usage, or durable-session peers.
- `scip-query duplicate-bodies --json --full` reports identical
  `completeReferenceMap()` and `configuredBatchTimeoutMs()` implementations in
  the direct-provider and session paths.
- `scip-query change-surface src/semantic/rust/lsp-session.ts --json --full`
  classifies the file as medium risk with seven external file consumers.
- The existing `lsp-types.ts` owns wire-level LSP structures, not scip-query's
  semantic resolver contracts. A small dependency-free semantic contract module
  is therefore preferable to broadening the LSP protocol module.

## Testability Design

| Behavior | Test seam | Pure core | Side-effect boundary | Contract |
| --- | --- | --- | --- | --- |
| Complete maps | shared helper unit tests and existing provider/session suites | definition filtering | none | incomplete IDs are omitted; missing answers become empty arrays |
| Timeout budget | shared helper unit tests and existing timeout suites | wave calculation | environment read | configured positive value wins; otherwise preserve formula |
| Cycle removal | `scip-query cycles --json` | import graph | reindex | zero Rust semantic cycles |
| Semantic parity | existing Rust provider/session/durable suites | unchanged resolvers | worker/LSP fixtures | reference, callee, signature, and import payloads unchanged |

## Checklist

- [x] Add `src/semantic/rust/semantic-resolution.ts` containing shared resolver
      contracts, import-definition payloads, complete-map logic, and timeout
      calculation.
- [x] Re-export public types from their former modules where compatibility is
      useful, while changing internal imports to the shared module.
- [x] Delete the duplicate local helpers and update all consumers.
- [x] Run Rust semantic suites, typecheck, duplicate-bodies, cycles, reindex,
      diff-gate, and the uncapped health report.

## Result

All four Rust semantic dependency cycles were removed. Exact duplicate-body
groups fell from six to four, and the uncapped health score rose from 80 to
86.25 (risk 97) while all 151 focused Rust semantic tests passed.

## Safety

This is a two-way internal dependency refactor. No JSON schema, protocol version,
environment variable, public package export, or algorithm changes. Reverting the
single commit restores the prior module placement.
