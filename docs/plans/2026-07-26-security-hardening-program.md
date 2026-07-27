# Security Hardening Program

**Date:** 2026-07-26
**Status:** Pre-approved for implementation
**Finding ledger:** `docs/reviews/2026-07-26-engineering-lenses-security-audit.md`
**Baseline:** `9203ff8aba7f546175f87e85ccee69dd9e9147bb`

## Outcome

Make scip-query safe to run against a checkout whose files, generated index,
configuration, dependencies, and repository-local tools have not already been
trusted.

The program closes all twelve findings in the finding ledger. It preserves the
successful-path UX for ordinary queries, verified cached tools, globally
installed tools, the bundled Windows sidecar, default managed caches, and
normal Git revisions. It intentionally changes the UX at boundaries where
repository-controlled input would otherwise gain host authority:

- project-local executables require `--trust-project-tools`;
- installing missing global tools requires `--install-missing`;
- repository-local TLA jars are no longer selected implicitly;
- unsafe source paths, cache roots, and Git revisions fail with an actionable
  diagnostic;
- oversized inputs report a bounded failure rather than being read without a
  limit.

An authority grant is a user action that permits repository-controlled bytes to
perform an operation with the user's host privileges. Its essential property
is that it is explicit and bound to the exact resource being authorized, so
consent cannot silently transfer to different bytes.

An owned cache is a storage directory created or adopted by scip-query for one
canonical project root and marked with that binding. Its essential property is
that destructive cache operations can prove the target is scip-query state,
not merely a path supplied by repository configuration.

## Premises

1. A checkout, its tracked configuration, its generated SCIP data, its local
   dependency executables, and its symlinks are untrusted until a person grants
   them authority.
2. Command-line options and environment variables are operator-controlled, but
   still require syntactic validation before they become subprocess arguments
   or filesystem targets.
3. A repository-relative path is safe only after both lexical validation and
   canonical filesystem containment have succeeded.
4. Avoiding a shell prevents shell interpolation; it does not make an
   untrusted executable, Java archive, Git option, or terminal byte sequence
   safe.
5. A checksum-verified, version-pinned artifact has a stable identity. A
   project path or mutable package tag does not.
6. A time or output limit on a subprocess does not bound memory consumed by
   an in-process whole-file read.
7. A destructive operation may act only on a target whose ownership and exact
   identity are proven immediately before mutation.
8. Human terminal output and JSON output have different contracts: human
   output must neutralize terminal controls, while JSON must preserve data
   bytes subject to JSON encoding.
9. Public CLI and TypeScript API additions must be additive. Existing safe
   calls retain their meaning; insecure implicit authority is not a
   compatibility guarantee.
10. Every security rejection must identify the refused resource and the safe
    remediation without echoing credentials or other secrets.

## Invariants

These statements must remain true after every slice:

1. No index-controlled source path can cause a read outside the canonical
   project root.
2. No project-local executable or Java archive runs without an explicit grant
   tied to its canonical identity.
3. Installed hooks invoke the reviewed scip-query installation, not a later
   repository-local replacement.
4. No tracked `dbPath` can move, overwrite, or delete an unowned directory.
5. Every Git revision passed to diff plumbing is resolved to an object ID
   before it is reused as an argument or batch input.
6. Automatic indexing never installs mutable global tools unless the user
   explicitly asks, and explicit installers use immutable versions.
7. Untrusted terminal text cannot emit C0, C1, ANSI, or OSC control behavior.
8. Managed cache directories and files are private to the current user where
   the platform supports POSIX modes.
9. Registry errors never reproduce user-info, tokens, or passwords.
10. Source and artifact reads have documented upper bounds and typed failure
    modes.
11. JSON schemas and successful safe workflows remain backward compatible.
12. Security tests include a malicious negative case and a legitimate positive
    control.

## Reuse decisions

The implementation extends existing boundaries instead of introducing
parallel mechanisms:

- `src/domain/path-normalization.ts` owns lexical repository path rules.
- `src/platform/project-files.ts` already proves symlink containment while
  fingerprinting; it becomes the authoritative project-file resolver.
- `src/platform/bounded-child-process.ts` remains the subprocess execution
  boundary.
- `src/platform/verified-binary-fetch.ts` remains the immutable download and
  checksum boundary.
- `src/platform/cache-layout.ts` remains the cache-path authority and gains
  ownership and permission proofs.
- `src/platform/git-worktree.ts` remains the Git revision authority.
- `src/runtime/render.ts` remains the human-output rendering boundary.
- `src/runtime/revisioned-file.ts` remains the durable publication mechanism
  for small ownership records and state files.

## Slice 1 — Indexed paths and bounded reads

**Findings:** SEC-01, source-read portion of SEC-12

### Change

1. Add a `resolveProjectFile` proof object in
   `src/platform/project-files.ts`. It:
   - rejects empty, absolute, parent-traversing, drive, UNC, device, and
     NUL-containing paths;
   - normalizes separators;
   - canonicalizes the root and target;
   - rejects an escaping symlink;
   - stats the target without following a replacement after validation;
   - returns the canonical path, relative identity, size, and file identity.
2. Add bounded text and buffer readers that accept only the proof object.
3. Move `getSourceText` and `code` onto the new boundary.
4. Move TypeScript, Rust, TLA, and shared semantic source consumers onto the
   same boundary.
5. Reject unsafe paths during SCIP sanitization/publication so a fresh index
   cannot contain a path that every source consumer must reject.
6. Add a typed `UnsafeProjectPathError` and `InputTooLargeError`. Human
   diagnostics include the normalized project-relative identity, never the
   contents of the escaped target.

### Test seams

- lexical path validator with table-driven POSIX and Windows cases;
- filesystem fixture containing in-root and escaping symlinks;
- injected size budget using small files;
- malicious legacy SQLite fixture;
- freshly converted SCIP document with an unsafe path;
- public `code`, shared source-text, TypeScript, Rust, and TLA consumers.

### Adversarial cases

- `../secret`, `/etc/passwd`, `C:\secret`, `\\host\share`, device paths, NUL;
- a safe-looking path through an escaping symlink;
- target replacement between consent and read;
- exact-limit and one-byte-over-limit inputs;
- missing files and in-root symlinks as positive controls.

### Exit gate

Focused tests, typecheck, and a disposable copy of the original traversal proof
must show that the sibling witness cannot be read.

## Slice 2 — Explicit executable and TLA authority

**Findings:** SEC-02, SEC-03, SEC-04

### Change

1. Add additive `--trust-project-tools` support to `reindex` and the public
   reindex options.
2. Discover repository-local indexers without executing them. By default,
   prefer reviewed global, cached, or bundled identities.
3. When trust is granted, canonicalize the exact local executable, reject an
   out-of-root symlink, record its device/inode/size/mtime identity, and
   revalidate immediately before spawn.
4. Remove implicit repository-local candidates from TLA resolution. Preserve
   the explicit `--tla-tools` and `TLA_TOOLS_JAR` grants and the pinned,
   checksum-verified cache.
5. Generate project hooks from the currently running Node executable and CLI
   entry point, with platform-correct argument serialization. Do not select
   `node_modules/.bin/scip-query` from the target project.
6. Hooks never add project-tool trust.

### Test seams

- fake local indexer and replacement-on-spawn fixture;
- symlinked executable escaping the repository;
- explicit TLA option/environment/cache/project candidate matrix;
- hook snapshots with spaces, quotes, and shell metacharacters in paths;
- actual hook execution in a disposable project.

### Adversarial cases

- executable replaced after resolution;
- repository-local jar present while verified cache is absent;
- repository path containing `'`, `"`, `$()`, and spaces;
- hook run after a malicious local `scip-query` is added.

### Exit gate

The existing executable and jar marker proofs remain absent by default, become
reachable only through their explicit grants, and installed hooks still
execute the intended CLI.

## Slice 3 — Owned caches and private storage

**Findings:** SEC-05, SEC-10

### Change

1. Reject tracked `dbPath` values that are absolute, escape the project, name
   the project root itself, or resolve through an escaping symlink.
2. Introduce a versioned cache ownership record binding:
   - canonical project root;
   - canonical cache directory;
   - schema version;
   - creator package version.
3. Create the record only in a new/empty directory or safely adopt a directory
   containing only a recognized legacy cache layout. Refuse arbitrary existing
   data.
4. Require a valid ownership proof immediately before cold-benchmark move,
   restore, overwrite, or recursive removal.
5. Store interrupted-restore records under the private managed cache root,
   keyed by a hash of the canonical cache identity, rather than beside a
   repository-selected path.
6. Validate both the original and backup identities during recovery.
7. Create/chmod managed directories to `0700` and state/index files to `0600`
   on POSIX. Keep executable bits only where required and preserve portable
   behavior on Windows.

### Test seams

- tracked config with escape, root, symlink, empty safe dir, known legacy dir,
  and arbitrary non-cache dir;
- ownership-record tampering and project mismatch;
- crash points before move, after move, before restore, and after restore;
- mode assertions skipped only where the filesystem lacks POSIX modes.

### Adversarial cases

- `dbPath: ..`, `.`, a sibling, and a symlink to a sibling;
- forged restore record targeting an arbitrary directory;
- backup swapped before deletion;
- concurrent process creating a file during adoption.

### Exit gate

The original external-directory proof cannot create, move, or delete the
witness. A normal default cache and a recognized legacy cache still open and
recover.

## Slice 4 — Git revision validation

**Finding:** SEC-06

### Change

1. Add a Git revision resolver that rejects NUL/newline and option-like input,
   calls `git rev-parse --verify --end-of-options <revision>^{commit}`, and
   accepts only a full hexadecimal object ID.
2. Pass only the resolved object ID to `git diff`, `git show`, and
   `git cat-file` paths.
3. Preserve the user-facing base label for diagnostics while keeping it out of
   subprocess argument authority.

### Test seams

- valid branch, tag, abbreviated hash, full hash, and `HEAD~1`;
- unknown revision;
- leading-dash output/file/config options;
- newline and NUL;
- paths whose names resemble options.

### Exit gate

The original `--output` proof cannot create or truncate a file, and ordinary
diff-impact results are unchanged.

## Slice 5 — Explicit, immutable tool installation

**Finding:** SEC-07

### Change

1. Add additive `--install-missing` support. Normal `reindex` detects missing
   tools and reports a copy-pasteable setup command without installing.
2. Keep the existing `skipAutoInstall` library option as a compatibility
   override; explicit false does not restore implicit authority.
3. Make the interactive/setup flow pass the explicit installation grant only
   after the user-selected install action.
4. Replace `latest` and unversioned package identities with audited exact
   versions, including SCIP CLI `v0.8.1`.
5. Route downloadable binaries through the existing checksum-verified fetcher
   where an official immutable artifact exists.
6. Report the exact package/version, destination, and executable identity
   before running an installer.

### Test seams

- missing tool with normal reindex, explicit install, and skip override;
- exact installer argument snapshots;
- install failure leaves no tool reported as ready;
- already-installed and bundled positive controls.

### Adversarial cases

- registry metadata changes after discovery;
- PATH replacement after installation;
- unsupported platform with no immutable installer;
- hook-triggered reindex with a missing tool.

### Exit gate

No normal reindex or hook performs a package-manager mutation. Every automated
installer request contains an immutable identity.

## Slice 6 — Production dependency remediation

**Finding:** SEC-08

### Change

1. Update the lockfile so production paths resolve to fixed
   `brace-expansion` and `postcss` releases.
2. Prefer direct compatible upgrades or package-manager overrides over
   unrelated dependency churn.
3. Record the dependency paths and advisory resolution in the finding ledger.

### Test seams and exit gate

- `npm audit --omit=dev` has no known high-severity production advisory;
- `npm ls brace-expansion postcss` shows only fixed production versions;
- build, API report, package smoke tests, and full tests remain green.

## Slice 7 — Safe human output and secret diagnostics

**Findings:** SEC-09, SEC-11

### Change

1. Add one terminal-text neutralizer to `src/runtime/render.ts`.
2. Apply it to every repository/index-controlled string in human rendering,
   including paths, symbols, snippets, diagnostics, TLA output, and child
   failure summaries.
3. Preserve newlines/tabs only in deliberate multiline rendering; neutralize
   C0, C1, ESC, CSI, and OSC initiation bytes.
4. Leave JSON values structurally unchanged.
5. Redact registry URLs with `URL` parsing: remove user-info and redact
   credential-bearing query parameters before any error interpolation.
6. Use the same redactor for nested causes and release-state diagnostics.

### Test seams

- ANSI color, cursor movement, OSC title, OSC 52 clipboard, C0/C1, bidi-like
  printable text, tabs, and newlines;
- credential in URL user-info, query, percent encoding, and malformed URLs;
- human and JSON snapshot comparison.

### Exit gate

Captured human output contains no active control byte and no registry secret.
JSON remains parseable and preserves the original printable content.

## Slice 8 — Artifact budgets, documentation, and final verification

**Finding:** remaining artifact portion of SEC-12 and program integration

### Change

1. Add documented byte budgets to SCIP, augmentation, fragment, config, and
   imported artifact reads that currently materialize an entire file.
2. Stat before allocation and enforce streaming counters where the parser
   supports streams.
3. Return typed bounded/incomplete metadata where a query can remain useful;
   otherwise fail explicitly with the limit, observed size, and remediation.
4. Document:
   - the untrusted-checkout security model;
   - new authority flags;
   - cache ownership and migration;
   - input budgets;
   - terminal/JSON distinction;
   - exact tool installation identities.
5. Regenerate command reference and API contracts.
6. Re-run the audit proofs and append disposition/evidence to every SEC item.

### Final gates

- focused security tests;
- `npm run format:check`;
- `npm run typecheck`;
- `npm run test`;
- `npm run lint`;
- `npm audit --omit=dev`;
- `npm run build`;
- `npm run api:check`;
- package smoke tests;
- `scip-query reindex`;
- `scip-query diff-gate --json --compact`;
- clean `git diff --check`;
- no unexplained finding left open.

### Implemented disposition

Implemented end to end:

- one typed bounded-file owner covers small records, source/fragments, SCIP
  indexes, profiles/JSONL, open descriptors, streams, and pseudo-files;
- production artifact readers use explicit limits, while hashing and
  fingerprinting stream rather than materialize large artifacts;
- repository regular-expression patterns and generated TLA traces have
  explicit parser/retention budgets;
- a static contract test prevents future raw production materialization from
  bypassing the owners;
- every CLI command has stable rendered-output pagination with an exact
  continuation command, output hash, invocation binding, private immutable
  snapshot, expiry/restart behavior, and a published JSON schema;
- ordinary JSON remains byte-compatible unless paging is explicitly selected;
- human blind truncation is blocked by the Claude hook for every pageable
  command, and generated agent instructions require following the emitted
  continuation until complete;
- transport pagination now has explicit per-snapshot and aggregate ceilings.
  Memory remains bounded to one page, immutable page ranges make continuation
  I/O linear, transient disk snapshots expire after one hour, and
  command-owned logical result budgets and coverage metadata remain the
  CPU/row authority.

The final documentation lives in `docs/SECURITY_MODEL.md` and
`docs/CLI_JSON_OUTPUT.md`. SEC-01 through SEC-12 have explicit final
dispositions in the audit ledger.

## Dependency graph

The slices are independently revertible, but they are not all linearly
dependent:

- Slice 1 must precede the artifact-budget integration in Slice 8.
- Slice 3 must precede destructive cache recovery tests in Slice 8.
- Slice 5 must precede dependency/package verification in Slice 6.
- Slices 2, 3, 4, and 7 can otherwise proceed independently.
- Documentation and the final audit disposition wait for all implementation
  slices.

## Compatibility and UX ledger

| Workflow                                                  | Result                                                  |
| --------------------------------------------------------- | ------------------------------------------------------- |
| Query a normal in-repository indexed source file          | Unchanged                                               |
| Reindex with an installed/global/bundled reviewed indexer | Unchanged                                               |
| Reindex using `node_modules`/`vendor` executable          | Requires `--trust-project-tools`                        |
| Reindex when no indexer is installed                      | Reports setup; `--install-missing` performs the install |
| TLA using pinned verified cache                           | Unchanged                                               |
| TLA using a repository-local jar                          | Must use explicit `--tla-tools` after review            |
| Hooks in ordinary project                                 | Same commands; trusted CLI identity is pinned           |
| Default managed cache                                     | Unchanged except private permissions/ownership record   |
| Safe legacy cache                                         | Adopted once, then unchanged                            |
| Unsafe or arbitrary tracked `dbPath`                      | Rejected with remediation                               |
| Valid Git `--base`                                        | Same diff result                                        |
| Option-like/invalid Git `--base`                          | Rejected before Git plumbing                            |
| Human output containing control bytes                     | Controls displayed inertly                              |
| JSON output                                               | Data preserved through JSON encoding                    |
| Oversized source/artifact                                 | Explicit bounded failure or incomplete coverage         |

## Completion rule

A finding is complete only when its exploit proof fails for the intended
reason, its positive control succeeds, the production call path uses the new
boundary, and the finding ledger records the exact test and commit. A green
unit test that exercises only a helper is insufficient.
