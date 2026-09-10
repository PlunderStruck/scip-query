# TypeScript breadth and command accuracy audit

Status: discovery complete within the recorded matrix. Five finding groups remain open in [the report](../benchmarks/2026-09-09-typescript-breadth-audit.md). Production and build hashes remain unchanged. No fixes were made in this discovery turn.

The user asks whether inaccuracies remain and whether audits compare every command with what it should return. Previous command-contract checks and the 686-program TypeScript corpus cover different, finite sets. Neither establishes exhaustive language or command accuracy.

## Work and completion evidence

- [x] Freeze source/build hashes and enumerate current commands from the built help/registry; distinguish public controls from internal protocols.
- [x] Replay the saved command-contract fixture, compare expected facts, and record obsolete probes separately from product defects. Exercise operational commands only in disposable roots.
- [x] Extend discovery beyond the repaired corpus: shared object escapes, mutation primitives, implicit execution, expression evaluation, callable declarations and configuration-sensitive cases. Compile and independently execute every runtime fixture.
- [x] Trace reproduced errors through compiler references, shared graph/value producers and selected public consumers. A successful invocation or agreement between consumers is not an independent accuracy check.
- [x] Include positive controls and supported negative cases. Keep false exact claims, missing evidence, correctly qualified unknowns, and invalid fixtures separate.
- [x] Record each finding with minimal source, expected and actual behavior, affected surface, reproducible command, likely shared cause, and whether already documented. Rebuild corruption is reproduced; its internal cause remains unisolated.
- [x] Publish a command coverage ledger and a bounded verdict, including untested behavior and test-harness limitations. Verify production hashes remain unchanged.

No agent benchmarks, existing-watcher changes, VM installation, commit or push are part of this discovery pass. Historical artifacts and pre-existing working-tree changes remain intact.

## Open repair queue

- [ ] TS-B05: isolate the corrupt rebuild publication transition; require successful SQLite integrity/readability and preservation of the prior accepted generation on failure. Three fresh reproductions and local corrupt snapshots are available.
- [ ] TS-B03: model or qualify nested/eager/implicit writes before reporting complete dependence slices; carry the fix through slice-cohesion/dataflow consumers.
- [ ] TS-B02: preserve value precision through boundary key parts/observations and stop interpreting unknown or numeric expressions as literal string addresses.
- [ ] TS-B01: qualify cross-file mutable object escapes; retain primitive/immutable positive controls and extend cache dependency tracking with the proof.
- [ ] TS-B04: retain qualified constructor evidence through callable filtering; revise the new verification contract without reinstating unjustified exact implementation labels.
- [ ] Turn each reproduced failure into a failing regression, run public-consumer assertions plus existing accuracy/history suites, and only then consider release/install work.
