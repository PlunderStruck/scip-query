# scip-query Security Audit

**Date:** 2026-07-26
**Repository revision:** `9203ff8aba7f546175f87e85ccee69dd9e9147bb`
**Package version:** `scip-query@0.19.6`
**Method:** `engineering-lenses` security review, supplemented by `scip-audit`
evidence rules, source inspection, compiler-resolved relationship queries,
dependency scanning, static analysis, and disposable proof-of-concept fixtures.

## Executive summary

scip-query should not yet be described as safe to run automatically against an
untrusted checkout.

The central security boundary in this product is the point where bytes
controlled by a repository gain authority to read host files, execute host
programs, or move and delete host data. The audit found three demonstrably
exploitable high-severity failures at that boundary:

1. A crafted index can make source-backed queries read files outside the
   repository.
2. Repository-local indexers and TLA jars can become host executables without
   an explicit trust decision; installed hooks have the same structural
   problem.
3. A tracked `dbPath` can escape managed cache storage, after which cold-index
   benchmarking can move or delete an unowned directory.

The audit also found:

- automatic installation of mutable, unpinned global tools;
- two high-severity advisory families in the production dependency tree;
- Git option injection through `--base`;
- terminal-output, local-cache-permission, secret-redaction, and resource-limit
  hardening gaps.

No critical-severity finding was assigned. Severity assumes that scip-query is
intended to inspect repositories that are not already fully trusted. If the
product contract is instead limited to repositories whose code, configuration,
dependencies, generated indexes, and local tools are all trusted, the
repository-execution findings become documented authority grants rather than
violations of that contract. That restriction is not presently made explicit,
and automatic agent hooks make it an unsafe default assumption.

## Scope and method

The review covered:

- CLI arguments and subprocess construction;
- language-indexer selection and installation;
- Git, Java/TLA, Rust, TypeScript, and SCIP subprocesses;
- SQLite query construction and database opening;
- index-controlled paths and source-file reads;
- tracked configuration, cache placement, backup, restore, and deletion;
- agent hook generation and persistent command execution;
- downloaded artifacts, hashes, TLS, and release provenance;
- secrets, registry diagnostics, and terminal rendering;
- local daemon, mailbox, and evidence-state authority;
- production dependencies and known advisories;
- denial-of-service and resource-boundary behavior.

The following checks were run read-only:

- current repository `config-validate`;
- scip-query semantic `self-audit`;
- `npm audit --omit=dev`;
- `npm ls` for affected production dependency paths;
- a Semgrep community scan covering 74 JavaScript, TypeScript, and Node rules;
- tracked-secret pattern searches;
- source and compiler-resolved relationship inspection.

Disposable fixtures under `/tmp` were used to test credible exploit chains.
They were removed after the probes. No tracked repository file was edited
during the audit.

## Findings

### SEC-01 — Crafted index paths can disclose arbitrary local files

**Severity:** High
**Confidence:** Proven with a disposable fixture
**Affected boundary:** Repository/index data to host filesystem reads

#### Evidence

Source-backed navigation joins an index-controlled relative path directly to
the project root:

- `src/queries/navigation/code.ts:65`
- `src/queries/navigation/code.ts:110`

The shared source-text primitive repeats the same operation:

- `src/source/primitives/source-text.ts:23`

The relevant operations are equivalent to:

```ts
join(db.config.projectRoot, indexControlledPath);
readFileSync(result, 'utf-8');
```

There is no rejection of:

- absolute paths;
- `..` traversal;
- Windows drive or device paths;
- NUL-containing paths;
- lexical paths that remain inside the root but escape through a symlink;
- real paths outside the canonical project root.

The shared source primitive is used by source-text-driven queries and
per-language semantic helpers, making this a systemic read boundary rather than
an isolated `code` command defect.

#### Validation

A disposable SQLite index declared a document with:

```text
../secret.txt
```

The public `code()` query returned the sibling file's contents:

```text
SCIP_QUERY_PATH_TRAVERSAL_WITNESS
```

The proof did not require shell execution or a race. It followed the ordinary
indexed-document lookup and source-read path.

#### Impact

A malicious or corrupted index can disclose any file readable by the current
user, subject only to the query reaching that indexed document. A symlink
inside the repository can produce the same result even when the stored path
contains no `..`.

Unbounded `readFileSync` also lets this path target a very large file, creating
a memory-exhaustion variant of the same boundary failure.

#### Remediation

Create one authoritative project-file resolver and require all source readers
to use it. The resolver should:

1. accept only normalized repository-relative paths;
2. reject absolute, parent-traversing, NUL, drive, UNC, and device paths;
3. canonicalize the project root;
4. resolve the target's real path, including symlinks;
5. prove that the target remains beneath the canonical root;
6. enforce a configurable file-size limit before reading.

Unsafe document paths should also be rejected during SCIP conversion,
publication, and database opening so callers cannot accidentally treat a
partially unsafe index as trustworthy.

#### Required tests

- direct `../` traversal;
- absolute POSIX path;
- Windows drive and UNC path;
- nested symlink escaping the root;
- in-root symlink remaining in the root;
- missing file;
- oversized file;
- unsafe legacy SQLite index;
- unsafe freshly converted SCIP index;
- coverage across `code`, shared source text, TypeScript/Rust semantic helpers,
  and TLA source consumers.

---

### SEC-02 — Repository-local indexers execute without an explicit trust decision

**Severity:** High
**Confidence:** Proven with a disposable fixture
**Affected boundary:** Repository files to host process execution

#### Evidence

`resolveProjectLocalIndexerBinary` returns the first existing configured
repository path:

- `src/platform/indexer-toolchain.ts:114-129`

Normal reindex preparation checks this path before the installed/bundled
indexer:

- `src/reindex/index.ts:1763-1779`

Configured repository-local executables include:

- `node_modules/.bin/scip-clojure`;
- `vendor/davidrjenni/scip-php/bin/scip-php`;
- `vendor/bin/scip-php`.

These are defined in:

- `src/reindex/indexers.ts:121`
- `src/reindex/indexers.ts:267`

The bounded process runner correctly avoids a shell and constrains time and
output. Those protections prevent shell interpolation and runaway child
output; they do not make an attacker-controlled executable safe.

#### Validation

A disposable repository contained an executable:

```text
node_modules/.bin/scip-clojure
```

The executable wrote a marker and exited with status 17. Running:

```text
scip-query reindex --language clojure --allow-partial --json
```

with automatic installation disabled executed the repository-local binary. The
CLI error identified that binary and the marker contained:

```text
PROJECT_LOCAL_INDEXER_EXECUTED
```

#### Impact

Running reindex in a malicious checkout can execute arbitrary code with the
developer or agent's privileges. When indexing is initiated automatically by
an agent workflow, the person may not make a contemporaneous decision to trust
the repository executable.

#### Remediation

- Use bundled or globally reviewed indexers by default.
- Require an explicit, visible `--trust-project-tools` authority grant before
  selecting a repository executable.
- Display and record the exact canonical executable path and identity.
- Reject symlinked local binaries unless the resolved target is separately
  trusted.
- Revalidate identity immediately before spawn so consent cannot be transferred
  to replacement bytes.
- Prevent automatic hooks from silently granting project-tool trust.

#### Required tests

- repository-local binary is refused by default;
- explicit trust permits the exact reviewed path;
- symlink escape is rejected;
- executable replacement after consent is detected;
- hook-triggered indexing does not imply trust;
- non-executable and malformed local tools fail closed;
- trusted bundled/global fallback remains functional.

---

### SEC-03 — Repository-local TLA jars execute when the verified cache is absent

**Severity:** High
**Confidence:** Proven for fresh or empty cache environments
**Affected boundary:** Repository artifacts to Java class execution

#### Evidence

`resolveTlaToolsJar` searches in this order:

1. explicit option;
2. `TLA_TOOLS_JAR`;
3. verified global cache;
4. `<projectRoot>/tla2tools.jar`;
5. `<projectRoot>/tools/tla2tools.jar`.

See:

- `src/tla/tool-runner.ts:208-218`

The selected jar is placed on Java's classpath and asked to execute
`tla2sany.SANY` or `tlc2.TLC`:

- `src/tla/tool-runner.ts:165-198`

The TLA query workflow also invokes SANY fact extraction before the requested
checker run:

- `src/runtime/query-commands/tla.ts:398-407`

#### Validation

The first probe found the verified cached jar and did not execute the
repository jar. That condition was correctly treated as a refutation of the
candidate for warm-cache environments.

A second probe used a fresh empty `SCIP_QUERY_CACHE_DIR`. A disposable
repository jar defined `tla2sany.SANY` and wrote a marker when loaded. The
resolver selected the repository jar, Java executed it, and the marker
contained:

```text
PROJECT_LOCAL_TLA_JAR_EXECUTED
```

#### Impact

A fresh installation, cleared cache, alternate cache, or new machine can
execute a repository-controlled jar during TLA analysis.

#### Remediation

- Remove implicit repository-local jar candidates.
- Use only the pinned, hash-verified cache by default.
- Preserve an explicit `--tla-tools` or environment override as a deliberate
  authority grant, accompanied by a clear warning.
- If local discovery remains, require explicit trust and verify an expected
  digest before execution.

#### Required tests

- empty cache ignores repository jars;
- verified cached jar wins;
- malformed or digest-mismatched jar is rejected;
- explicit trusted override works;
- SANY preflight cannot bypass the same policy;
- no-cache behavior reports a safe remediation command instead of executing
  repository bytes.

---

### SEC-04 — Agent hooks persist a project-controlled executable identity

**Severity:** High
**Confidence:** Source-confirmed; no execution proof required for classification
**Affected boundary:** Setup-time repository state to future automatic execution

#### Evidence

Hook installation selects:

```text
<projectRoot>/node_modules/.bin/scip-query
```

whenever that path exists:

- `src/runtime/agent-hooks.ts:624-626`

The selected path is interpolated without shell quoting into command strings
for:

- `SessionStart`;
- `UserPromptSubmit`;
- `PostCompact`;
- `PreToolUse`;
- `Stop`.

See:

- `src/runtime/agent-hooks.ts:556-619`

This creates two related defects:

1. a repository-controlled executable becomes a persistent automatic hook;
2. a repository path containing spaces or shell metacharacters is embedded in
   a command string without platform-safe quoting.

#### Impact

After hook setup, future agent events can execute repository-controlled or
subsequently replaced bytes. The execution occurs at a different time from the
setup decision and may no longer be visible to the user.

#### Remediation

- Never select the project-local package binary by default.
- Pin the exact trusted scip-query executable or package identity that performed
  setup.
- Prefer structured executable-and-argument hook configuration.
- Where only command strings are supported, use reviewed POSIX and Windows
  quoting routines rather than interpolation.
- Revalidate executable identity before each hook execution or route hooks
  through a trusted stable launcher.
- Treat executable replacement as a conflict requiring renewed consent.

#### Required tests

- project paths containing spaces;
- `$()`, semicolon, quotes, backticks, and newline characters;
- malicious pre-existing project-local binary;
- binary replacement after hook installation;
- missing pinned binary;
- Codex and Claude provider formats on macOS, Linux, and Windows.

---

### SEC-05 — Tracked `dbPath` escapes managed storage and reaches destructive cache operations

**Severity:** High
**Confidence:** External directory creation proven; destructive chain
source-confirmed
**Affected boundary:** Repository configuration to host directory ownership

#### Evidence

Tracked configuration is resolved without containment:

- `src/platform/cache-layout.ts:15-26`

The relevant operation is:

```ts
ensureDir(resolve(projectRoot, config.dbPath));
```

`validateProjectConfig` does not reject absolute, parent-traversing, or
symlink-escaping `dbPath` values. Ordinary commands resolve storage regardless
of whether the user separately ran advisory validation.

Cold-index benchmarking then:

1. obtains the configured cache directory;
2. restores any marker it finds;
3. renames the entire directory to a backup;
4. recreates/indexes into the original path;
5. recursively deletes the backup on success.

See:

- `src/runtime/commands/command-handlers.ts:488-510`
- `src/runtime/commands/command-handlers.ts:543-590`

The restore marker contains arbitrary `originalPath` and `backupPath` strings
and is not bound to the expected cache identity.

#### Validation

A disposable project used an absolute path outside the repository as
`dbPath`.

- `config-validate --json` returned no diagnostics.
- `status --json` created the external configured directory.

The move/delete behavior was confirmed from the direct cold-index call path and
its exported cache helpers. The audit did not run the destructive half against
real data.

#### Impact

A malicious tracked config can cause scip-query to create directories outside
its managed area. `bench --cold-index` can then move and delete all prior
contents of the selected directory. Crafted recovery-marker paths create
additional arbitrary rename risk.

#### Remediation

- Separate tracked project configuration from trusted operator overrides.
- Require tracked `dbPath` to remain beneath a managed cache root or a safe
  repository-contained location.
- Reject absolute paths, `..`, and realpath/symlink escapes.
- Enforce the rule during configuration decoding for every command, not only in
  `config-validate`.
- Place an unforgeable ownership record in every managed cache and bind it to
  the canonical project and cache paths.
- Refuse recursive rename or deletion without a valid ownership record and
  expected layout.
- Bind restore markers to the exact derived original and backup paths and store
  them in a managed directory.

#### Required tests

- absolute configured path;
- `../` escape;
- symlink escape;
- external directory containing a sentinel file;
- cold bench cannot move or delete an unowned directory;
- forged restore marker;
- stale restore marker from another project;
- canonical managed cache still supports cold benchmarking and recovery.

---

### SEC-06 — Git `--base` permits downstream option injection

**Severity:** Medium
**Confidence:** Proven with a disposable fixture
**Affected boundary:** CLI input to Git's option parser

#### Evidence

`getGitDiffSnapshot` passes the raw base value to five Git invocations before
an end-of-options marker:

- `src/queries/impact/diff-impact.ts:263-302`

Using `execFileSync` with an argument array prevents shell injection. Git still
parses each array element according to Git's own command-line grammar, so a
base beginning with `-` becomes a Git option.

The shared path affects commands that accept a diff base, including
`diff-impact`, `diff-gate`, and incomplete-migration analysis.

#### Validation

Running a disposable command with:

```text
--base=--output=<writable-path>
```

returned successfully and caused Git to create or truncate the selected path.

#### Impact

An attacker who can influence the base string passed by a user or agent can
activate supported `git diff` options. The proven impact is arbitrary
user-writable file creation or truncation.

#### Remediation

Resolve and validate the revision before using it:

```text
git rev-parse --verify --end-of-options <base>^{commit}
```

Require exactly one valid hexadecimal commit identity, reject leading `-`, and
pass only the resolved identity to subsequent commands with the appropriate
end-of-options or revision/path separator.

#### Required tests

- `--output=...`;
- other valid `git diff` options;
- valid branch, tag, hash, and `HEAD~N`;
- ambiguous revision/path names;
- nonexistent and multi-result revisions;
- staged and unstaged diff paths across every affected public command.

---

### SEC-07 — Automatic tool installation uses mutable package identities

**Severity:** High design risk
**Confidence:** Source-confirmed
**Affected boundary:** Network package state to global host execution

#### Evidence

Normal setup/reindex installation descriptors include:

- `npm install -g @sourcegraph/scip-typescript`;
- `npm install -g scip-python-plus`;
- `go install github.com/sourcegraph/scip-go@latest`;
- `dotnet tool install --global scip-dotnet`;
- `dart pub global activate scip_dart`;
- `go install github.com/sourcegraph/scip/cmd/scip@latest`.

See:

- `src/reindex/indexers.ts:27`
- `src/reindex/indexers.ts:43`
- `src/reindex/indexers.ts:113`
- `src/reindex/indexers.ts:163`
- `src/reindex/indexers.ts:216`
- `src/reindex/indexers.ts:243`
- `src/reindex/indexers.ts:259`
- `src/platform/scip-cli.ts:218`

`tryInstallIndexer` is reachable from ordinary reindex and project setup:

- `src/reindex/install.ts:11-56`
- `src/reindex/index.ts:1765-1779`

The mutable identifiers are resolved at installation time and the resulting
programs execute with the user's privileges.

#### Impact

Compromise, accidental breakage, or incompatible publication of a mutable
upstream version can become code execution during a routine local operation.
The installed version can also differ across machines while appearing to be
the same scip-query workflow.

#### Remediation

- Put exact reviewed versions or immutable commits in one descriptor.
- Reject `latest` and unversioned production install specifications in tests.
- Require explicit user consent before modifying global tool state.
- Prefer pinned, digest-verified downloads where upstream artifacts permit it.
- Generate status, documentation, and release checks from the same descriptor.
- Record the installed version and provenance in health output.

---

### SEC-08 — Production dependency tree contains fixable high-severity advisories

**Severity:** High according to upstream advisories; application reachability
not fully proven
**Confidence:** Confirmed installed versions and advisory ranges
**Affected boundary:** Published transitive dependencies

#### Evidence

`npm audit --omit=dev` reported two high-severity vulnerable package nodes.

Installed production paths include:

```text
ts-morph
└─ @ts-morph/common
   └─ minimatch
      └─ brace-expansion@5.0.5

scip-python-plus
└─ glob
   └─ minimatch
      └─ brace-expansion@1.1.14

@vue/compiler-sfc
└─ postcss@8.5.15
```

Affected advisories:

- `brace-expansion` exponential-time denial of service:
  <https://github.com/advisories/GHSA-3jxr-9vmj-r5cp>
- `brace-expansion` unbounded expansion and out-of-memory crash:
  <https://github.com/advisories/GHSA-mh99-v99m-4gvg>
- `brace-expansion` numeric-range protection bypass:
  <https://github.com/advisories/GHSA-jxxr-4gwj-5jf2>
- PostCSS previous-source-map path traversal:
  <https://github.com/advisories/GHSA-r28c-9q8g-f849>

Patched targets are:

- nested `brace-expansion` 1.1.16 or later;
- current-line `brace-expansion` 5.0.8 or later;
- PostCSS 8.5.18 or later.

Current source inspection found scip-query calling the Vue compiler's `parse`
operation, not the PostCSS-backed style compilation path implicated by the
advisory. A specific public-input exploit through scip-query was therefore not
proven. The vulnerable package versions are nevertheless shipped in the
production tree.

#### Remediation

- Refresh compatible transitive dependencies or use narrow overrides.
- Run the complete test/API/package matrix after the lockfile change.
- Add `npm audit --omit=dev` to CI and release preflight.
- Add automated dependency-update proposals.
- If public pattern or CSS-processing behavior expands, add adversarial
  reachability tests rather than assuming the advisories remain unreachable.

#### Resolution — 2026-07-26

Resolved in the dependency-security slice:

- `scip-python-plus@0.7.5` removes the vulnerable legacy
  `glob`/`minimatch`/`brace-expansion` production path;
- the remaining production tree resolves `brace-expansion@5.0.8` and
  `postcss@8.5.23`;
- Vue compiler minimums are now 3.5.40 and Vitest's minimum is 3.2.7;
- `npm run audit:prod` is a release preflight and a pull-request/main-branch
  GitHub Actions gate;
- Dependabot proposes npm and GitHub Actions updates, while workflow actions
  are pinned to full commit identities.

`npm audit --omit=dev` reports zero vulnerabilities after the refresh. The
complete development tree retains one low-severity `esbuild@0.27.7` advisory
about serving attacker-controlled pages from its development server on
Windows. scip-query does not run an esbuild development server, and forcing
`0.28.x` would exceed `tsup@8.5.1`'s declared compatibility range, so this
non-production advisory is recorded rather than hidden with an incompatible
override.

---

### SEC-09 — Human terminal output accepts control sequences from untrusted fields

**Severity:** Medium hardening gap
**Confidence:** Source-confirmed
**Affected boundary:** Repository/index content to terminal control channel

#### Evidence

Human rendering writes titles, explanations, rows, snippets, paths, source,
documentation, and errors directly to `console.log`:

- `src/runtime/render.ts:36-130`

`displaySnippet` normalizes whitespace but does not remove ESC, C0, C1, OSC, or
other terminal-control sequences.

#### Impact

A malicious filename, symbol, docstring, source line, or indexer error can
alter terminal presentation. Depending on terminal support, this can spoof
results, create deceptive hyperlinks, change titles, or request clipboard
operations. JSON output is naturally escaped and is not affected in the same
way.

#### Remediation

- Sanitize untrusted strings at the human-rendering boundary.
- Remove C0/C1 and ESC-driven sequences while preserving only the deliberate
  newline/tab behavior required by each renderer.
- Keep structured JSON values unchanged.
- Apply the sanitizer to child-process diagnostics as well as query rows.

#### Required tests

- CSI color/control sequences;
- OSC 8 hyperlink;
- OSC 52 clipboard request;
- embedded carriage return, backspace, and newline;
- malicious path, symbol, documentation, source, and indexer stderr;
- JSON round-trip retains the original data.

#### Resolution — 2026-07-26

Resolved by a shared terminal-output boundary. Complete CSI, OSC, DCS, SOS,
PM, and APC sequences are removed; remaining C0/C1 and bidirectional
formatting controls are made visible and inert. The real CLI installs the
sanitizer once for console and Commander output, while row renderers reject
embedded newline/tab structure. Child diagnostics and the watch progress row
sanitize untrusted fields without removing scip-query's own progress control
prefix. Structured JSON is serialized first and round-trips unchanged.

---

### SEC-10 — Managed cache permissions expose code metadata to other local users

**Severity:** Low to Medium, depending on host account/group policy
**Confidence:** Observed on the audited installation
**Affected boundary:** Private project metadata to local operating-system users

#### Evidence

Observed modes were:

```text
~/.cache/scip-query                         0755
~/.cache/scip-query/projects               0755
project cache directories                  0755
index.db and evidence.db                    0644
some retained generation index databases   0444
```

The audited home directory was group-traversable. The databases contain project
identities, file paths, symbols, signatures, documentation, evidence records,
and semantic relationships. The current index did not embed full document text,
but private code metadata remains present.

The cache layout uses default `mkdir` and database creation modes rather than
declaring a private managed-storage policy:

- `src/platform/cache-layout.ts`

#### Remediation

- Create managed cache directories as `0700`.
- Create databases, mailboxes, state, and artifacts as `0600`.
- Repair insecure existing managed-cache modes when safely opening them.
- Do not change permissions on an explicit user-owned external path without
  consent.
- Test under a permissive known umask.

---

### SEC-11 — Registry-validation errors can disclose URL credentials

**Severity:** Low
**Confidence:** Source-confirmed
**Affected boundary:** Secret-bearing configuration to logs

#### Evidence

The npm release script correctly rejects a registry URL containing a username or
password, but the error includes the original value:

- `scripts/npm-release.ts:270-285`

The message serializes `observed`, which may contain the credential-bearing
URL.

#### Impact

An unusual npm configuration using URL userinfo could leak credentials into a
terminal transcript or CI log. Common npm token configuration stores
authentication separately, so the exposure is limited but real.

#### Remediation

Parse the URL, replace username/password with a fixed redaction marker, and
only then construct the diagnostic. Add a regression test asserting that the
original credential never appears in thrown errors or captured output.

#### Resolution — 2026-07-26

Resolved. Invalid registry syntax is no longer echoed, and parseable rejected
URLs replace username, password, query, and fragment data before constructing
the diagnostic. The release regression test proves the original password is
absent from the thrown error.

---

### SEC-12 — In-process artifact and source reads lack consistent resource budgets

**Severity:** Medium denial-of-service hardening gap
**Confidence:** Source-confirmed; no destructive stress test run
**Affected boundary:** Repository artifacts to process memory and CPU

#### Evidence

Several paths synchronously read complete source or index artifacts before
applying a size budget. Source-backed queries split complete file contents into
line arrays. SCIP deserialization and some parser/detector workflows similarly
operate on complete attacker-controlled inputs.

Child-process output is bounded, but in-process repository artifacts do not
share an equivalent central size policy.

#### Impact

An exceptionally large or crafted file/index can exhaust memory, trigger long
garbage-collection pauses, or monopolize synchronous CPU. SEC-01 increases the
reachable input set by allowing a crafted index to select a large file outside
the repository.

#### Remediation

- Define per-artifact and per-source-file size limits.
- Inspect file metadata before reading where possible.
- Stream conversions and parsers that do not require random access.
- Bound row counts, regex input sizes, and accumulated diagnostic payloads.
- Return typed incomplete/oversized coverage rather than silently truncating.

## Positive controls and refuted candidates

### Shell and subprocess construction

The common child runner uses shell-less argument arrays, process identities,
timeouts, stdout/stderr limits, termination escalation, and process reaping:

- `src/platform/bounded-process.ts:121`

No ordinary shell-command injection path was confirmed. The Git finding is
downstream option injection, and the local-indexer/TLA findings execute the
selected program itself; neither is prevented by shell-less spawning.

`tryInstallIndexer` uses a shell only for fixed Windows installation
configurations. The arguments in those configurations are descriptor literals,
not direct user input.

### SQLite

`ScipDatabase` opens SQLite read-only and enables `query_only`:

- `src/storage/db.ts:45-61`

User and index values in reviewed query paths are parameterized. Dynamic
table/schema fragments used by incremental publication were fixed internal
contracts rather than externally supplied identifiers. No credible SQL
injection finding survived review.

### Downloaded artifacts

The verified fetch path includes:

- HTTPS;
- expected SHA-256;
- streamed size ceilings;
- `Content-Length` checks;
- timeout and abort handling;
- tokenized locking;
- random private staging;
- flushing and atomic rename;
- failure cleanup.

The default TLA download is pinned to a fixed version and SHA-256:

- `src/tla/tool-runner.ts:77-78`

The Windows SCIP sidecar also has pinned provenance and release identity
checks. These are effective controls. SEC-03 exists because repository-local
fallback bypasses the verified-download trust decision when the cache is
absent.

### Secrets

Pattern searches found only deliberate test fixtures. No credible committed
credential, private key, or production token was identified.

### Web identity and access

scip-query is a local CLI/tooling package, not a web application. It has no
cookie-authenticated request surface, login/session lifecycle, password reset,
CSRF boundary, or multi-tenant authorization model in the reviewed code.
Applying web-authentication rules to those nonexistent referents would produce
false findings.

### Rust semantic path setting

The configured `semantic.rust.rustAnalyzerPath` appeared initially to be an
execution candidate. Relationship and source inspection showed that the
current status path does not use the configured value. This is configuration
drift or a misleading option, not a proven execution vulnerability.

### Static analysis

Semgrep scanned 398 tracked files with 74 community JavaScript, TypeScript, and
Node rules and reported zero findings. It had a few partial-parse warnings and
taint fixed-point timeouts. The result is useful corroboration for conventional
patterns, but it did not detect the manually proven boundary failures and
cannot be treated as a clean security verdict.

## Remediation program

The findings should be implemented as independently reviewable slices.

### Slice 1 — Safe project-file authority

Addresses SEC-01 and part of SEC-12.

- Add the canonical project-file resolver.
- Validate index document paths during conversion/publication/open.
- Route all source readers through the resolver.
- Add file-size budgets and typed oversized outcomes.
- Add traversal and symlink test matrices.

**Release significance:** block claims that untrusted indexes are safe until
this lands.

### Slice 2 — Trusted executable policy

Addresses SEC-02, SEC-03, and SEC-04.

- Define a shared executable trust decision.
- Remove implicit repository-local TLA fallback.
- Require explicit trust for project indexers.
- Pin hook execution to a trusted identity.
- Add platform-safe structured hook arguments or quoting.
- Document when analysis can execute repository tools.

**Release significance:** block automatic indexing/hook execution in untrusted
checkouts until this lands.

### Slice 3 — Managed cache ownership and containment

Addresses SEC-05 and SEC-10.

- Validate tracked cache paths before any command uses them.
- Separate operator override authority from repository config.
- Add cache ownership identities.
- Bind cold-bench backups and recovery markers to the expected cache.
- Refuse destructive operations on unowned storage.
- Use private default modes.

**Release significance:** block cold-index benchmarking against untrusted
tracked configuration until this lands.

### Slice 4 — Git revision validation

Addresses SEC-06.

- Resolve base strings to verified commits.
- reject option-like and ambiguous values;
- add all public-command regression cases.

### Slice 5 — Immutable toolchain supply chain

Addresses SEC-07.

- Pin every automatic installer.
- require explicit global-mutation consent;
- generate status/docs/tests from one descriptor;
- reject mutable identities mechanically.

### Slice 6 — Dependency refresh and continuous advisory gate

Addresses SEC-08.

- Update `brace-expansion` and PostCSS transitively.
- Run complete package/API/downstream/Windows tests.
- Add production-only audit to CI and release preflight.
- Add automated update proposals.

### Slice 7 — Output and diagnostic hygiene

Addresses SEC-09 and SEC-11.

- Centralize terminal sanitization for human output.
- Preserve JSON fidelity.
- Redact credential-bearing URLs and similar diagnostic values.
- Add terminal-control and no-secret-log tests.

### Slice 8 — Resource budgets

Completes SEC-12.

- Set artifact, file, row, regex-input, and accumulated-output limits.
- Report completeness and omitted units explicitly.
- Add adversarial large-input tests that remain bounded in time and memory.

## Verification performed

- The three disposable exploit classes produced the expected witnesses:
  - out-of-root source disclosure;
  - repository-local indexer execution;
  - repository-local TLA jar execution with an empty cache.
- Git option injection created/truncated the disposable requested path.
- External `dbPath` passed validation and was created by an ordinary status
  operation.
- `npm audit --omit=dev` reported two high-severity vulnerable package nodes.
- The repository's current `config-validate` reported no diagnostics.
- The semantic `self-audit` was available and reported complete oracle coverage
  for its sample; that command measures query evidence quality, not host
  security.
- No tracked file was changed by audit probes.
- The tracked worktree was clean at audit completion.

## Exit criteria

scip-query can reasonably claim safe analysis of an untrusted checkout only
when:

1. every repository/index-controlled file read proves canonical containment;
2. no repository-controlled executable or jar runs without an explicit,
   identity-bound trust grant;
3. tracked configuration cannot name storage outside an owned boundary;
4. destructive cache operations require verifiable ownership;
5. revision-like CLI values cannot become downstream options;
6. automatically installed tools have immutable reviewed identities;
7. production dependency advisories are either fixed or accompanied by a
   documented, tested non-reachability argument;
8. human output cannot emit repository-controlled terminal commands;
9. private cache state is private by default;
10. untrusted artifacts have explicit memory, CPU, and output budgets.
