# better-sqlite3 13 and Node 22 compatibility upgrade

Date: 2026-07-29

## Goal

Remove the abandoned `prebuild-install` package from new scip-query
installations by upgrading the maintained SQLite binding to
`better-sqlite3@13.0.2`, while preserving existing index behavior and making
the resulting Node 22 minimum explicit everywhere a user or release process
depends on it.

Done means:

- a clean install resolves no `prebuild-install` package;
- scip-query declares, documents, and tests Node 22 as its minimum runtime;
- the existing `ScipDatabase` public surface and SQLite files remain usable;
- npm lifecycle approval no longer names `better-sqlite3`;
- Node 22, 24, and 26 exercise the real native database boundary in CI;
- a packed scip-query install loads the bundled N-API SQLite binary and runs a
  real query without lifecycle scripts.

## Definitions and invariants

A **runtime-support contract** is a public package promise read by npm,
developers, CI, and downstream automation, distinguished by making the set of
Node runtimes on which installation and execution are supported explicit. Its
referents here are `package.json#engines`, the README prerequisite, the CI
matrix, and the dependency engine constraints.

A **native database boundary** is the process-local adapter between
scip-query's TypeScript storage API and SQLite machine code, distinguished by
being the single place where JavaScript values cross into the compiled
`better-sqlite3` addon. Its referents are the `Database` import and connection
inside `src/storage/db.ts`, together with direct fixture connections in tests
and performance scripts.

A **packed-install proof** is an integration check against the actual npm
tarball and a fresh consumer directory, distinguished from a source-tree test
by resolving only files and dependencies that an npm user receives.

The following invariants must hold:

- I1. The declared Node minimum must equal the minimum supported by every
  required production dependency.
- I2. Existing SQLite generation files must remain readable and writable
  without a schema or format migration.
- I3. `ScipDatabase` must preserve its constructor, read-query port,
  initialization pragmas, statement behavior, and close ownership semantics.
- I4. A clean npm dependency tree must contain no `prebuild-install`.
- I5. The packed artifact must execute a real SQLite query on every supported
  CI runtime without running a `better-sqlite3` install script.
- I6. The Windows SCIP sidecar coordinate and release ordering must remain
  unchanged.

## Premises

- **P1.** `package.json:360-407` currently declares Node `>=18.0.0`,
  `better-sqlite3:^12.9.0`, and an exact `better-sqlite3@12.9.0`
  lifecycle-script approval.

  Source: native read of `package.json`.

- **P2.** A fresh install under the current range resolves the latest 12.x
  line, whose install script is `prebuild-install || node-gyp rebuild
--release`; the local lock currently contains `prebuild-install@7.1.3`.

  Source: `npm view better-sqlite3@12.11.1 dependencies scripts.install
engines --json`; `npm explain prebuild-install`; native lockfile read.

- **P3.** `better-sqlite3@13.0.2` requires Node `>=22`, depends on
  `node-addon-api`, has no install script, and publishes N-API binaries for
  Darwin, Linux, Linux musl, and Windows on x64 and ARM64 inside its npm
  tarball.

  Source: `npm view better-sqlite3@13.0.2`; inspected
  `better-sqlite3-13.0.2.tgz`; upstream v13 release notes.

- **P4.** The README currently promises Node `>=18` and tells script-approval
  users that `better-sqlite3` builds or downloads its native binding through
  an install script.

  Source: `README.md:96-121,538-543`.

- **P5.** `ScipDatabase` owns the `better-sqlite3` connection internally and
  exposes a narrower read-query port. The complete compiler-resolved
  `ScipDatabase` reference set spans the analysis, query, semantic, source,
  storage, symbol, runtime, and TLA subsystems; no consumer directly depends
  on the addon version.

  Source: `scip-query code ScipDatabase`; complete two-page
  `scip-query refs ScipDatabase --full`; bounded
  `scip-query plan-context src/storage/db.ts`.

- **P6.** `tests/storage/db-lifecycle.test.ts` already exercises a real
  `better-sqlite3` database through `ScipDatabase`, including preparation,
  reads, mutation rejection, and closure.

  Source: native read of `tests/storage/db-lifecycle.test.ts`.

- **P7.** The only current GitHub Actions workflow runs a production audit on
  Node 24; it does not exercise the minimum supported Node runtime or the
  native database boundary.

  Source: native read of `.github/workflows/dependency-security.yml`.

- **P8.** Before repository edits, a database created and populated by the
  installed v12 addon was opened, read, and updated by the downloaded v13
  addon; the installed v12 addon then reopened and updated the v13-written
  database.

  Source: executed probes against
  `/tmp/scip-query-better-sqlite3.96Hnwd/compat.db`.

No shared application state gains a new writer or reader. The only persistent
state involved is the existing SQLite file, whose state-authority set remains
the complete `ScipDatabase` consumer graph in P5 and whose format
compatibility was attacked directly in P8.

## Current state

The public package claims a Node floor below the floor of the native database
package it actually resolves (P1, P2), violating I1. Global installation still
succeeds on current Node releases, but npm reports the abandoned transitive
installer. The README describes that obsolete installer as intentional (P4).

The application boundary itself is already appropriately compressed:
`ScipDatabase` owns connection initialization and lifecycle while consumers
use its stable port (P5). Replacing that wrapper or migrating to another
database API would enlarge the change without contributing to I4. The upstream
v13 release replaces only the addon distribution mechanism, and the
bidirectional database probe establishes a rollback-compatible file boundary
(P3, P8).

## Consumer dispositions

| Consumer                                                          | Kind                   | Disposition                                                                                         |
| ----------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `src/storage/db.ts` and the complete `ScipDatabase` reference set | direct/transitive code | Unchanged-safe: preserve the existing TypeScript API and validate through its real integration test |
| Direct `better-sqlite3` imports in tests and performance scripts  | direct code/test       | Unchanged-safe: compile and execute against v13                                                     |
| npm and downstream installers                                     | external               | Breaking coordinated change: declare Node 22 and release as `0.20.0`                                |
| README/install-script users                                       | documentation          | Update the prerequisite and remove obsolete addon-script approval                                   |
| GitHub Actions                                                    | CI                     | Add Node 22/24/26 native-runtime coverage                                                           |
| npm release coordinator and Windows sidecar                       | release                | Preserve sidecar `0.13.1`; rerun release/pack identity tests                                        |
| CLI JSON examples and exact-version tests                         | docs/test              | Update producer/package version to `0.20.0`                                                         |

## Reuse audit

No new production helper, wrapper, adapter, option, or config field is
justified. The existing `ScipDatabase` boundary is the reuse point (P5), the
existing lifecycle test is the real-database seam (P6), the existing
dependency-security workflow is the CI home (P7), and npm's package metadata
is the authoritative runtime contract.

A new database library or a local fork of `prebuild-install` is rejected:
either would replace a maintained upstream migration with a larger
scip-query-owned surface. A permanent binary SQLite fixture is also rejected;
the executed cross-version probe establishes file compatibility, while the
ongoing test obligation is API and packed-runtime compatibility.

## Testability design

- **Pure contract seam:** a focused test reads `package.json`,
  `package-lock.json`, README, and the workflow to assert one coherent Node
  floor and the absence of `prebuild-install`.
- **Managed dependency seam:** `tests/storage/db-lifecycle.test.ts` uses a
  real temporary SQLite database through `ScipDatabase`; no database mock is
  introduced.
- **Side-effect shell:** a fresh temporary consumer installs the packed
  tarball with lifecycle scripts disabled, then runs the installed CLI and a
  real SQLite query.
- **Cross-runtime seam:** GitHub Actions runs the focused contract and
  database lifecycle tests on Node 22, 24, and 26.
- **Release seam:** existing release tests and `npm pack --dry-run` prove the
  main/sidecar packaging contract remains intact.

## Design phases

### Phase 1 — Make the package contract truthful

Deployable: no, member of the single `node22-napi` release group.

- **What:** P1 and P2 bind the current package to the abandoned installer and
  an inaccurate Node floor.
- **Change:** update `package.json` and `package-lock.json` to
  `scip-query@0.20.0`, Node `>=22.0.0`, and
  `better-sqlite3:^13.0.2`; explicitly deny npm's unnecessary inferred
  `node-gyp rebuild` fallback and remove every `prebuild-install` lock entry.
- **Test seam:** package-contract test plus `npm ls prebuild-install --all`.
- **Validation:** focused contract test, `npm ci`, typecheck, production
  audit.
- **Premises/invariants:** P1-P3; I1, I4.

### Phase 2 — Preserve the native database behavior

Deployable: no, member of the single `node22-napi` release group.

- **What:** P5 and P6 show a broad consumer graph behind one stable wrapper.
- **Change:** do not edit the wrapper; run its real lifecycle test against
  v13 and retain the P8 bidirectional file-compatibility probe in the
  completion record.
- **Test seam:** `tests/storage/db-lifecycle.test.ts`.
- **Validation:** focused storage tests, complete suite, typecheck, API
  compatibility and downstream consumer compilation.
- **Premises/invariants:** P5, P6, P8; I2, I3.

### Phase 3 — Evolve documentation and CI together

Deployable: no, member of the single `node22-napi` release group.

- **What:** P4 and P7 leave users and CI on the old contract.
- **Change:** update README prerequisites and install-script guidance,
  changelog, CLI producer examples, exact-version tests, and add a
  Node-22/24/26 runtime matrix to the existing workflow.
- **Test seam:** package-contract and documentation tests; workflow literal
  contract.
- **Validation:** focused docs/security tests, formatting, link checks,
  `scip-query doc-drift --full`.
- **Premises/invariants:** P3, P4, P7; I1, I5, I6.

### Phase 4 — Prove the artifact users receive

Deployable: yes, as the completed `0.20.0` release candidate.

- **What:** source tests cannot prove npm tarball contents or fresh dependency
  resolution.
- **Change:** no production code; pack scip-query, install it into a fresh
  temporary consumer with scripts disabled, assert no `prebuild-install`,
  run the installed CLI, and execute a real SQLite query.
- **Test seam:** packed-install consumer.
- **Validation:** full release dry-run when publication is requested;
  otherwise `npm pack --dry-run` plus the local packed-install smoke.
- **Premises/invariants:** P2, P3, P6; I4-I6.

## Attack record

### A1 — Old Node runtime reaches the new release

Invariant/lens: I1; human experience and compatibility.

Attack: a Node 18 or 20 user installs `scip-query@latest` after `0.20.0`.

Outcome: **HOLE — repaired by phases 1 and 3.** The prior declaration
incorrectly admitted those runtimes. The release changes the major
pre-1.0 compatibility line, npm receives `engines.node >=22`, and the README
and changelog announce the floor.

### A2 — Existing database becomes unreadable

Invariant/lens: I2; data integrity and rollback.

Attack: create a database with v12, open and update it with v13, then roll
back and reopen it with v12.

Outcome: **HELD by P8 and phase 2.** Both directions executed successfully
before edits.

### A3 — Type-compatible code hides a native runtime failure

Invariant/lens: I3 and I5; boundary/testability.

Attack: TypeScript compiles while the `.node` binary is absent or cannot load.

Outcome: **HELD by phases 2 and 4.** The real lifecycle test constructs the
addon; the packed consumer repeats that proof outside the source tree.

### A4 — Deprecated installer remains through another dependency

Invariant/lens: I4; supply chain.

Attack: upgrading `better-sqlite3` removes its edge, but another dependency
still resolves `prebuild-install`.

Outcome: **HELD by phases 1 and 4.** Both the lockfile contract and fresh
packed consumer run `npm ls prebuild-install --all`.

### A5 — Script-approval hardening blocks the new addon

Invariant/lens: I5; valid intermediate state.

Attack: denying `better-sqlite3` in `allowScripts` prevents its binary from
appearing or causes a clean install to report an unresolved script decision.

Outcome: **HELD by P3 and phase 4.** v13 ships binaries in its tarball and
declares no install script. npm still infers a default `node-gyp rebuild` from
the included source metadata, so the repository records an explicit
name-scoped denial. Clean and packed consumers install with lifecycle scripts
disabled and still execute SQLite.

### A6 — CI never exercises the minimum runtime

Invariant/lens: I1 and I5; observability.

Attack: development on Node 26 passes while Node 22 fails to load or compile.

Outcome: **HOLE — repaired by phase 3.** The existing workflow tests only
Node 24 (P7); the runtime matrix adds 22, 24, and 26.

### A7 — Documentation keeps prescribing obsolete approval

Invariant/lens: I1 and I5; human experience.

Attack: a user follows the README and approves an addon script that no longer
exists, confusing the tree-sitter approval flow with SQLite installation.

Outcome: **HOLE — repaired by phase 3.** The README will distinguish bundled
SQLite binaries from the remaining parser lifecycle scripts.

### A8 — Main-package change accidentally alters the sidecar

Invariant/lens: I6; release boundary.

Attack: package/version rewrites change the Windows sidecar coordinate or
release order.

Outcome: **HELD by phase 3 and existing release tests.** The sidecar remains
`0.13.1`; exact tests and the coordinator's pack identities cover it.

### Coverage matrix

| Surface/lens                  | Attack                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node runtime contract         | A1, A6                                                                                                                                                                |
| Existing SQLite files         | A2                                                                                                                                                                    |
| `ScipDatabase` consumer graph | A3                                                                                                                                                                    |
| Dependency tree               | A4                                                                                                                                                                    |
| Lifecycle-script policy       | A5                                                                                                                                                                    |
| User documentation            | A7                                                                                                                                                                    |
| Windows/release packaging     | A8                                                                                                                                                                    |
| Reversibility                 | A2                                                                                                                                                                    |
| Efficiency                    | Accepted: v13 downloads a larger dependency tarball because it bundles eight platform binaries; eliminating runtime download/build machinery is the upstream tradeoff |
| Security                      | A4, A5                                                                                                                                                                |

## Execution and ship order

Phases 1-3 land together because package metadata, docs, and CI describe one
public contract. Phase 4 gates publication. The one-way door is publishing
`0.20.0` with the Node 22 floor; before publication the commit is ordinarily
revertible, and the P8 probe shows the database bytes remain rollback-safe.

## Verdict

A plan is PLANNED-COMPLETE iff the coverage matrix has no blank rows, every
attack ends in HELD with cited phases and premises or an accepted hole with a
written reason, and no premise failed reverification.

Result: **PLANNED-COMPLETE — 8 attacks, 3 holes repaired, 0 accepted holes,
0 unresolved premises.**

## Files

Create:

- `tests/scripts/runtime-support-contract.test.ts`

Edit:

- `package.json`
- `package-lock.json`
- `tsup.config.ts`
- `src/runtime/setup.ts`
- `README.md`
- `CHANGELOG.md`
- `docs/CLI_JSON_OUTPUT.md`
- `.github/workflows/dependency-security.yml`
- `tests/scripts/dependency-security.test.ts`
- `tests/platform/scip-cli.test.ts`
- `tests/scripts/windows-sidecar-doc.test.ts`

Verify without intended source edits:

- `src/storage/db.ts`
- `tests/storage/db-lifecycle.test.ts`
- `scripts/release-npm.ts`
- `packages/scip-windows/package.json`

## Completion record — 2026-07-29

Result: **IMPLEMENTED-COMPLETE.** The published-package contract is now
`scip-query@0.20.0`, Node.js `>=22.0.0`, `better-sqlite3:^13.0.2`, and a
Node.js 22 build target. Node.js 24 LTS is the user-facing recommendation;
the README and packed postinstall artifact both distinguish that
recommendation from the Node.js 22 minimum.

Verification evidence:

- `npm ci` completed from the updated lockfile without an unresolved
  `better-sqlite3` script decision. The repository explicitly denies npm's
  inferred `node-gyp rebuild` fallback while retaining the bundled binary.
- `npm run audit:prod` reported zero production vulnerabilities.
- Focused runtime and database tests passed under Node.js 22.23.1,
  24.18.0, and 26.5.0. The source-tree focused set passed 34/34 tests.
- `npm run typecheck`, `npm run lint`, the public API compatibility check,
  and downstream public-consumer compilation passed. The public API remained
  unchanged across 72 package paths.
- The complete unsandboxed suite passed 268/268 files and 2,128/2,128 tests.
- A v12-created SQLite database was read and updated by v13, then reopened
  and updated by v12, preserving rollback compatibility for the exercised
  database format.
- The final packed tarball was 1,194,598 bytes with SHA-512
  `4c3c832151a20f7cce5ddda9650c86adad775baa0d7261566ec68148ae3e19f499daaac68e27080ec5fbdd7ebe0b955e9445ae20eed3a1a8fb2c88ddf3bf30b6`.
- A fresh consumer installed that tarball with lifecycle scripts disabled.
  `npm query '#prebuild-install'` returned an empty set; the packed CLI
  reported `0.20.0`; real SQLite queries succeeded under Node.js 22 and 24;
  and the packed postinstall entry printed
  `Node.js 24 LTS recommended; minimum Node.js 22`.

SCIP postcheck evidence:

- `scip-query doctor` reported a fresh, healthy index with all configured
  capabilities available. The active watcher rebuilt after the source edit;
  no competing manual reindex was started.
- `scip-query diff-impact` found one changed source symbol, `postinstall`,
  with its expected consumer in `src/runtime/postinstall.ts`.
- Full co-change and documentation-drift output was paginated to completion.
  The current README, changelog, runtime contract, and JSON producer version
  were updated; no command name, option, descriptor, or result shape changed.
- `scip-query health --baseline` reported 132 findings against an old
  repository-wide baseline. They are pre-existing findings across unrelated
  source surfaces rather than findings introduced by this dependency and
  runtime-contract change, so this slice does not rewrite the shared baseline.
- `scip-query diff-gate` reported two heuristic co-change candidates:
  `src/runtime/setup.ts` with `docs/COMMAND_REFERENCE.md`, and the same source
  file with `skills/_shared/SKILL.md`. Both are knowingly accepted. The only
  source edit changes the npm postinstall notice; it does not change a command
  contract or the conditions under which agents should use scip-query.
  Editing either coupled document would therefore assert a relationship this
  change does not have.
