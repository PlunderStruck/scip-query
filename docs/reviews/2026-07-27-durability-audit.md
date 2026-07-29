# scip-query — Durability Audit

Date: 2026-07-27  
Audited revision: `9de38b98ac75fe0fa620d921c83911e7634e255c`  
Audited package version: `0.19.8`  
SCIP generation: `c6d1cde3299e` (fresh when the review began)

Scope: the atomic-file primitives, local SQLite generation publication,
shared-worktree generation publication and hydration, watch refresh requests,
TypeScript and Rust filesystem mailboxes, process locks, cache ownership,
verified binary installation, npm release state, outcome-event records,
rotating JSONL telemetry, output snapshots, and the repository's documented
durability promises.

Method: this was a findings-only production-code review. It applied the
`durability` lens and the `scip-audit` evidence discipline. Compiler-resolved
`scip-query` results established storage and reindex subsystem boundaries,
complete references for the principal publication functions, and transitive
consumers of the atomic writer. Native reads established exact syscall
ordering, tests, and literal contract language. No sub-agents were used. No
production code, tests, configuration, generated command artifacts, or
skills were changed.

This report records **nine findings**:

- **2 high-severity findings:** DUR-01 and DUR-02;
- **5 medium-severity findings:** DUR-03 through DUR-06 and DUR-08;
- **2 low-severity findings:** DUR-07 and DUR-09.

The findings describe behavior permitted by the audited revision. They do not
claim that every failure has occurred on a user's machine. A source-confirmed
filesystem ordering is not mislabeled as an observed power-loss incident.

**Remediation status:** DUR-01 through DUR-09 were implemented after this
snapshot. Section 10 records the replacement mechanisms and executable
evidence while preserving the original findings as the historical baseline.

---

## 1. Outcome

The repository is substantially stronger than a normal cache-oriented CLI.
Its core file replacement sequence is correct when the target's containing
directory already exists on a POSIX host:

1. create a private staging file exclusively;
2. write every byte, including short-write retries;
3. flush the staging file;
4. close it;
5. rename or hard-link it into the public name;
6. flush the containing directory.

Local SQLite generation publication also has the right authority split. It
materializes an immutable artifact directory before switching `state.json`,
and current internal readers follow that pointer rather than assembling a
generation from replaceable compatibility paths. Shared generations carry
artifact hashes and validate them before reuse. Mailbox completion is
published before an inflight claim is removed. Release recovery always
reconciles immutable npm registry identity instead of trusting local history
alone. Telemetry is explicitly rebuildable and repairs incomplete tails.

The remaining problems cluster around four distinctions that the current
implementation partly collapses:

1. **flushing a directory is not the same as durably creating that
   directory;**
2. **recording a checksum is not the same as verifying it at the authority
   boundary;**
3. **requesting durable mode is not the same as achieving directory-entry
   durability;**
4. **throwing at a named callback is not the same as crashing between
   persistence operations.**

The highest-risk consequences are:

- a first accepted watch-refresh request can disappear after a machine crash
  because its newly created directory chain was never durably linked;
- a same-size corrupted local generation can remain the current internal
  authority because readers validate artifact sizes but not the recorded
  SHA-256 digests;
- a shared generation can be reported as published before its artifact files
  or final directory name are durable;
- a pending mailbox request can be durably removed from `pending/` while its
  newly created owner directory is not durably linked from `inflight/`;
- Windows callers can receive and advertise an ordinary “durable” success
  after the primitive explicitly reports that directory sync was unsupported.

---

## 2. Terms, evidence grades, and severity

A **crash-durable state change** is a persistence guarantee attached to an
acknowledged update. Its concrete referents here are an accepted refresh
request, a selected index generation, a release stage, a cache ownership
record, and a completed mailbox response. What distinguishes it from an
ordinary successful write is enforced persistence ordering: recovery after a
process, kernel, or machine failure finds the acknowledged state, or a
provably older committed authority, because both the data and the filesystem
names that reach it were flushed before success.

A **directory entry** is the filesystem record that maps a name in one
directory to a file or child directory. Flushing a file preserves its inode
contents; flushing its containing directory preserves the public name that
reaches that inode. When a containing directory was itself newly created, its
own name is a separate entry in its parent and needs a separate persistence
step.

A **durability frontier** is the latest state that recovery is allowed to
observe after a crash. A correct publication protocol advances that frontier
only after every dependency of the new state is persistent. For example,
`state.json` may name a generation only after the complete generation
directory is beyond the frontier.

An **authoritative record** is persisted state whose value selects later
behavior. `state.json`, a watch-refresh request, a completion receipt, a
health baseline, and a cache ownership proof are authoritative because losing
or changing them can alter which generation, obligation, policy, or
destructive permission the program accepts.

A **rebuildable record** is persisted state whose loss can cost time,
diagnostics, or a retry but cannot make an unverified fact authoritative.
Shared index caches, verified binary caches, telemetry, output snapshots, and
evidence caches can be rebuildable when readers validate identity and fail
closed.

A **torn artifact** is a file whose persisted bytes combine only part of an
intended update with older or unrelated bytes. Atomic rename prevents readers
from seeing the writer's staging file during ordinary execution, but only
flush ordering and read-side integrity checks address post-crash media state.

Evidence grades used below:

- **Source-confirmed ordering:** the current filesystem operations establish
  every step of the failure sequence.
- **Compiler-resolved relationship:** a complete SCIP query established the
  named caller, consumer, or affected-symbol relationship.
- **Existing-test confirmation:** a checked-in test establishes the stated
  behavior.
- **Test-gap confirmation:** the focused suite passes while the relevant
  persistence phase has no seam or assertion.
- **Heuristic documentation signal:** `doc-drift` identified a candidate;
  the report independently verified the literal mismatch before retaining it.

Severity:

- **High** means one acknowledged authoritative state can disappear or one
  corrupted evidence generation can remain authoritative without detection.
- **Medium** means the failure is bounded to recoverable availability, repeat
  work, a platform-specific contract downgrade, or a safety credential whose
  rollback behavior is incomplete.
- **Low** means the main data remains recoverable, but a protection, test
  oracle, or documented guarantee is weaker or less precise than claimed.

---

## 3. Persistence map

| Boundary                     | Authority after success                                            | Current publication rule                                                                   | Recovery behavior                                                                 | Audit result                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Atomic JSON/file replacement | Public target path                                                 | File flush, rename/link, target-directory flush                                            | Old or new complete file when parent already exists on POSIX                      | **Incomplete for newly created parent chains and unsupported directory sync**                                             |
| Local SQLite generation      | `.scipquery-generations/state.json` naming one immutable directory | Flush artifacts and manifest, rename generation, flush generation root, switch pointer     | Internal readers follow pointer; stable mirrors are derived                       | **Ordering is strong after initialization; initial root creation and read-side hash validation are incomplete**           |
| Shared generation            | Content-derived directory plus manifest                            | Copy artifacts, hash them, flush manifest, rename directory                                | Read-side size/hash validation converts damage to cache miss                      | **Fail-closed but not durably published**                                                                                 |
| Watch refresh intent         | Immutable request and completion files                             | Flush staging file, exclusive hard link, flush record directory                            | At-least-once processing and idempotent retry                                     | **Explicit “accepted intent is never lost” promise is not met on first directory creation or unsupported directory sync** |
| TypeScript/Rust mailbox      | Pending, inflight, response, and rejection files                   | Exclusive request/response publication; rename claims; flush source and target directories | Dead-owner reclaim and first-completion authority                                 | **Process-crash recovery is strong; new owner-directory persistence is incomplete**                                       |
| Process lock                 | Exclusive public lock name                                         | Flush candidate, exclusive hard link, flush directory                                      | Dead process or changed birth identity can be reclaimed                           | **Acceptable:** losing a lock across machine restart cannot preserve a live owner                                         |
| Cache ownership              | `.scip-query-cache-owner.json`                                     | Exclusive write, one `writeSync`, file flush                                               | Destructive operations require matching record                                    | **Directory persistence, short-write handling, and failed-adoption rollback are incomplete**                              |
| Verified binary              | Checksum-accepted cache path                                       | Stream/verify, flush file, rename, flush directory                                         | Hash mismatch redownloads                                                         | **Fail-closed and rebuildable; inherits new-parent and unsupported-sync limits**                                          |
| npm release state            | Local coordinate-pair ledger; registry remains external truth      | Durable replacement; registry is freshly reconciled                                        | Immutable npm versions and exact identity prevent duplicate/different publication | **Recovery is safe, but achieved durability is mislabeled on unsupported hosts**                                          |
| Outcome events               | Git-committed independent event files                              | Exclusive local file create; later Git commit supplies repository durability               | Dedupe absorbs duplicate/reordered events                                         | **Acceptable if “durable” means committed history, not immediate local power-loss survival**                              |
| Rotating telemetry           | Two bounded JSONL segments                                         | Process-visible append/rotation                                                            | Partial tail trimmed or ignored                                                   | **Correctly classified rebuildable telemetry**                                                                            |
| Output snapshots             | Temporary immutable output plus descriptor                         | Atomic descriptor; temporary snapshot rename and quotas                                    | Missing/corrupt continuation requires command rerun                               | **Correctly temporary, not authoritative user data**                                                                      |
| Evidence cache               | Rebuildable SQLite WAL                                             | Explicit reduced-sync cache policy                                                         | Cache miss recomputes evidence                                                    | **Correctly classified rebuildable**                                                                                      |

---

## 4. Detailed findings

### DUR-01 — High — “Durable” file publication does not durably establish a missing parent directory

**Evidence:** source-confirmed ordering; compiler-resolved affected set;
test-gap confirmation.

**Contract:**

When a durable writer is allowed to create the target's parent directory, a
successful return must preserve both:

1. the target name inside that directory; and
2. the directory name inside its own parent.

Flushing only the first mapping does not make the complete path durable.

**Code and SCIP relationships:**

- `src/storage/atomic-file.ts:59-60` and `:114-115` call
  `mkdirSync(..., { recursive: true })` through `runtime.makeDirectory`.
- `replaceFileAtomic` flushes only `parentDirectory` at `:74-77`.
- `createFileAtomicExclusive` likewise flushes only `parentDirectory` at
  `:130-133`.
- `syncDirectoryDurable` at `:157-177` opens and flushes exactly the supplied
  directory. It does not recurse and cannot infer which ancestors were newly
  created.
- The complete `scip-query affected replaceFileAtomic --max-depth 8` result
  found **47 affected symbols across 25 files**. The complete
  `affected writeJsonDurable` result found **34 affected symbols across 16
  files**.
- Principal affected authorities include local generation state, shared
  generation manifests and leases, watch state, Rust session state, health
  baselines, mailbox owner/rejection records, output descriptors, and
  revision-aware project configuration.

**Concrete contract violation: watch refresh admission**

- `src/storage/watch-refresh-requests.ts:312-315` recursively creates
  `<root>/staging` and the target record directory.
- It flushes the staging file at `:318`, hard-links the public record at
  `:321`, and flushes the record directory at `:326`.
- It never flushes `root` after creating `requests/`, `claims/`, or
  `completions/`, and it never flushes the parent that newly names `root`.
- `enqueueWatchRefreshRequest` returns `disposition: "accepted"` at `:93-95`.

If `requests/` is new, recovery may therefore observe the removal or absence
of that child-directory entry even though the request file and the contents
of `requests/` were flushed.

**Other affected first-publication paths:**

- `src/reindex/sqlite-generation-store.ts:672-695` creates
  `.scipquery-generations`, flushes artifacts and the generation-root
  contents, but does not flush the cache directory that names the new root.
- `src/reindex/shared-generation-store.ts:267-269` creates the shared
  `generations/` directory without persisting its name in the repository
  cache directory.
- npm release state can create `.scipquery/releases/` through the same atomic
  helper. Registry reconciliation keeps publication safe, but the local
  recovery record can roll back.
- revision-aware setup can create `.scipquery.json`, hook-provider
  directories, and suppression directories under newly created parents.

**Attempted refutation:**

- `fsync(parentDirectory)` is sufficient once that directory already has a
  durable name. The finding is specifically about first creation or a newly
  introduced intermediate directory.
- Recursive `mkdir` returning success establishes process visibility, not a
  power-loss guarantee for every created entry.
- The local generation store fails closed if the entire generation root is
  absent; a rebuild restores it. That reduces consequence but does not make
  the documented crash ordering true for the first publication.
- Registry reconciliation makes a lost npm release record safe to reconstruct.
  It does not preserve the local “durable release state” claim.
- Existing atomic-file tests create the fixture root before invoking the
  writer. Their trace expects one `mkdir` followed by a flush of that already
  existing root at `tests/storage/atomic-file.test.ts:45-64`; no test models a
  newly created parent entry.

**Consequences:**

- A first accepted watch-refresh intent can disappear after a kernel or
  machine crash, violating the explicit at-least-once admission contract.
- A successful first reindex can lose the generation authority and require a
  full rebuild.
- Newly created policy or setup records can roll back despite a successful
  “durable” return.
- The primitive's central name overstates what it guarantees for a path it is
  itself allowed to create.

**Recommended design:**

- Introduce a directory-creation primitive that reports the exact directories
  it created and durably links them from the nearest pre-existing ancestor in
  parent-to-child order.
- Separate `requireExistingParent: true` publication from
  `createParentsDurably: true`; do not let a generic `mkdir -p` silently widen
  the durability contract.
- For protocol roots such as watch requests and local generations, establish
  and flush the complete directory skeleton during initialization before any
  acknowledged record can use it.
- Preserve the Windows limitation as an explicit achieved-guarantee result;
  do not pretend recursive creation can provide a stronger result there.

**Required tests:**

- Trace a target whose parent and grandparent do not exist. Assert each new
  directory's parent is flushed in the required order.
- Inject failure after each new-directory creation and each ancestor flush.
- Verify a failure never returns accepted/durable.
- Cover both replacement and exclusive hard-link publication.
- Add a watch-refresh first-admission test using an injected filesystem
  runtime rather than only a post-publication callback.

**Acceptance condition:** no operation can report full crash durability for a
path unless every newly created directory entry in that path has crossed the
durability frontier.

---

### DUR-02 — High — Local generation readers record SHA-256 digests but authorize artifacts by size alone

**Evidence:** source-confirmed validation path; compiler-resolved reader path;
missing corruption tests.

**Contract:**

An immutable generation manifest is an integrity authority only when the
reader proves that the files it opens still match the recorded identity.
Recording a digest without checking it cannot turn same-size bytes into a
verified generation.

**Code and SCIP relationships:**

- `src/reindex/sqlite-generation-store.ts:716-722` records each artifact's
  size and SHA-256.
- `materializeGeneration` flushes copied files and publishes
  `manifest.json`, then `state.json` names the generation.
- `src/storage/sqlite-generation.ts:337-358` is the internal reader selected
  by `resolveSqliteGeneration`.
- Its `artifactHasRecordedSize` helper at `:398-400` checks only existence,
  regular-file type, and size.
- `validArtifact` at `:415-425` validates only that the manifest's digest has
  SHA-256 syntax. It does not hash the stored file.
- `src/reindex/sqlite-generation-store.ts:524-553` can report the store
  current through `stableMirrorsMatch`; that helper checks file identity,
  sizes, and metadata equivalence, not the immutable artifacts' digests.
- `src/storage/db.ts:339-350` opens the selected immutable database directly.
  Initialization applies read-only/query pragmas and validates indexed
  document paths, but performs neither a manifest hash check nor an SQLite
  integrity check.
- The complete SCIP reference result for `readImmutableGeneration` has one
  caller, the `resolveSqliteGeneration` authority path. The complete result
  for `resolveSqliteGeneration` reaches `ScipDatabase` construction.

**Failure sequence:**

1. `state.json` names generation G.
2. An artifact under G is torn, externally changed in place, or restored with
   different bytes but the same byte length.
3. The manifest still parses and the file still has its recorded size.
4. `readImmutableGeneration` returns G as the current handle.
5. `ScipDatabase` opens the database, while semantic consumers can also read
   the generation's SCIP and metadata paths.
6. SQLite may fail loudly for some corruptions, but a structurally readable
   same-size alteration is not rejected by the generation boundary itself.

**Attempted refutation:**

- The writer flushes artifact files before publication. That is necessary,
  but it does not make read-side checksums redundant for media faults,
  external same-user writes, restoration errors, or a filesystem/device that
  violates the expected persistence result.
- Files are chmodded `0444`. POSIX mode bits are advisory against the same
  user and do not authenticate bytes. DUR-07 also shows the mode change occurs
  after the final artifact fsync.
- The content-derived directory identity does not validate itself. The
  reader trusts the directory name supplied by `state.json`.
- `storedArtifactMatches` does perform a hash when publication collides with
  an already existing generation. That protects a later publisher, not every
  reader after publication.
- Shared generations provide the positive comparison:
  `readSharedGeneration` verifies both size and SHA-256 before returning a
  manifest.
- Existing local-generation tests cover a missing directory and injected
  control-flow failures. They do not mutate an immutable artifact to
  different same-size bytes and reopen it.

**Consequences:**

- A corrupted local database can remain the internal source of code
  intelligence instead of becoming a stale/missing index.
- A same-size corrupted SCIP artifact can affect semantic navigation without
  invalidating the generation handle.
- The manifest's digest fields and content-derived identity imply a stronger
  guarantee than the authority path enforces.

**Recommended design:**

- Validate the database, SCIP, and metadata digests before a generation is
  first accepted in each process.
- Cache a successful validation by generation identity plus stable file
  identity so ordinary commands do not rehash multi-gigabyte artifacts.
- Invalidate the validation cache when device/inode/size/mtime/ctime evidence
  changes. Treat an unverifiable file as invalid, not as a cache hit.
- For the SQLite artifact, consider a bounded `quick_check` or equivalent in
  addition to the manifest digest if logical SQLite validity is required.
- Keep stable compatibility mirrors outside this authority; they remain
  derived and repairable.

**Required tests:**

- Change each immutable artifact to different bytes of the same size and
  assert resolution fails closed before queries use it.
- Validate corruption after a prior successful open to prove the integrity
  cache invalidates correctly.
- Test database, SCIP, and metadata independently.
- Test a corrupt current generation with a valid previous generation and
  state the chosen recovery rule explicitly.

**Acceptance condition:** an immutable generation becomes an internal read
authority only after its persisted artifacts have been proven to match the
manifest identity.

---

### DUR-03 — Medium — Shared generation publication flushes the manifest but not the artifact set or final directory name

**Evidence:** source-confirmed ordering; compiler-resolved publication
callers; existing read-side corruption test.

**Contract:**

A published generation directory is one multi-file snapshot. Before success,
every artifact must be durable, the manifest must describe those exact
durable bytes, and the final generation name must be durable in
`generations/`.

**Code and SCIP relationships:**

- `src/reindex/shared-generation-store.ts:267-285` creates a staging
  directory, copies each shareable artifact, and computes size/hash records.
- `cloneArtifactFile` at `:772-779` uses `copyFileSync`, with reflink fallback,
  but never opens or flushes the destination.
- `writeJsonDurable` at `:316-319` flushes only the manifest file and its
  staging directory.
- `renameSync(stagingDir, targetDir)` at `:327` publishes the generation.
- No subsequent call flushes `generationsDir`.
- `publishSharedGeneration` returns the manifest at `:333`.
- Complete SCIP references show production publication from
  `src/reindex/index.ts` and peer import/publication inside the shared store.

**Attempted refutation:**

- Hashing a destination proves what was readable before return. It does not
  force those bytes to stable media.
- Flushing `manifest.json` and the staging directory does not flush sibling
  artifact inodes.
- Renaming a directory atomically changes visibility, but without flushing
  `generationsDir`, the new public name is not crash-durable.
- `readSharedGeneration` rehashes every artifact. This is strong: a torn or
  partial generation is rejected rather than used.
- `tests/reindex/shared-generation-store.test.ts:81-107` confirms corruption
  becomes `null`. That limits this finding to availability and repeated work,
  not silent wrong evidence.
- A later worktree lease cannot make a non-durable generation durable merely
  by naming it.

**Consequences:**

- Reindex can report “Published shared generation” and let waiting worktrees
  proceed even though a machine crash can lose or damage that generation.
- Recovery safely rebuilds, but the expensive work and sharing benefit are
  lost.
- A durable worktree lease can temporarily name a generation whose
  publication never crossed its own durability frontier.

**Recommended design:**

- Reuse one artifact-clone primitive that copies/reflinks, sets final mode,
  flushes the destination, and closes it.
- Flush the complete staging directory after all artifact names and the
  manifest are present.
- Rename staging to the content-derived target.
- Flush `generationsDir` before returning publication success.
- Establish `generationsDir` durably first, as required by DUR-01.

**Required tests:**

- Trace every artifact flush before manifest/final publication.
- Inject failure while flushing one artifact, the staging directory, the
  final rename, and `generationsDir`.
- Assert no failed publication is returned or leased as current.
- Preserve and rerun the existing corruption-to-cache-miss tests.

**Acceptance condition:** every successful shared-generation publication has
durable artifact bytes and a durable final directory entry, or returns an
explicit bounded/unsupported outcome instead of “published.”

---

### DUR-04 — Medium — A new mailbox owner directory can be lost after the pending request removal is durable

**Evidence:** source-confirmed ordering; compiler-resolved mailbox consumers;
test-gap confirmation.

**Contract:**

Claiming a request transfers one durable name from `pending/` to
`inflight/<owner>/`. The source removal must not become durable before every
directory entry needed to reach the destination is durable.

**Code and SCIP relationships:**

- `src/storage/bounded-mailbox.ts:188-197` recursively creates the mailbox
  directory skeleton without flushing the created entries.
- `claimBoundedMailboxRequestsUnlocked` creates a dynamic owner directory at
  `:360-372`.
- `ensureMailboxOwnerRecord` durably writes inside that owner directory.
- The request is renamed from pending to the owner directory at `:385-386`.
- The code then flushes the pending directory and the owner directory at
  `:392-393`.
- It never flushes `paths.inflightDir` after creating the new owner-directory
  entry.
- Complete SCIP references for `initializeBoundedMailbox` reach the
  TypeScript index service, TypeScript semantic service, and Rust durable
  session server.

**Failure sequence:**

1. `inflight/<owner>/` does not yet exist.
2. The service creates it and writes/flushed `owner.json` inside it.
3. The service renames `pending/request.json` into the new directory.
4. It flushes `pending/`, making the source removal durable.
5. It flushes `<owner>/`, making the claim contents durable.
6. A machine crash occurs before `inflight/` ever persists the child
   `<owner>` name.
7. Recovery can lose the reachable owner directory while retaining the
   pending removal.

**Attempted refutation:**

- A process-only crash leaves the kernel's directory cache and filesystem
  state intact, so current dead-owner recovery works. This finding is
  specifically about kernel/machine failure and the stronger file-flush
  contract the code chose.
- The mailbox carries read-only or rebuildable analysis work. After a full
  machine restart, the original synchronous caller may also be gone. That
  reduces user-data severity.
- The response-before-claim-delete ordering is correct and not challenged.
- Existing mailbox tests exercise owner death, expiry, duplicate completion,
  and injected completion failure. They do not model loss of a newly created
  directory entry after source-directory fsync.

**Consequences:**

- An admitted request can be absent from pending, inflight, and completed
  state after recovery.
- The protocol's strong fsync choreography creates a durability expectation
  that the dynamic-directory edge does not meet.
- A service can report a claim while the persistent namespace still lacks the
  path that owns it.

**Recommended design:**

- Create and durably link the owner directory before writing owner metadata or
  moving any request into it.
- Flush `inflight/` immediately after a new owner-directory creation.
- Reuse the durable directory initializer from DUR-01 for the fixed mailbox
  skeleton.
- Preserve the existing order: destination hierarchy durable, claim rename,
  source and destination directory flushes, response publication, claim
  deletion.

**Required tests:**

- Trace first-owner and existing-owner claims separately.
- Inject a crash at directory creation, owner-record publication, request
  rename, source flush, and destination flush.
- Assert recovery always finds the request in exactly one reclaimable or
  completed state.

**Acceptance condition:** a durable source removal can never outrun the
durable destination path that replaces it.

---

### DUR-05 — Medium — Requested durability is reported as achieved durability, and callers erase the unsupported result

**Evidence:** source-confirmed return types and call sites; compiler-resolved
affected set; existing primitive-level Windows test.

**Contract:**

A durability result must describe what the host actually achieved. An input
mode is a request; it is not evidence that the directory entry was flushed.

**Code and SCIP relationships:**

- `AtomicFileWriteResult` exposes:
  - `durability: "visibility" | "durable"`;
  - `directorySync: "not-requested" | "synced" | "unsupported"`.
- In durable mode, the first field is always `"durable"`, even when the
  second says `"unsupported"`.
- `docs/DURABILITY.md:51-56` correctly explains that unsupported means
  flushed file contents plus visibility, not the full directory-entry
  guarantee.
- Every production `writeJsonDurable` call discards its returned result.
  Affected authorities include health baselines, reindex metadata,
  generation state, shared manifests and leases, watch service state, Rust
  session discovery, mailbox records, and watch-refresh records.
- `src/storage/watch-refresh-requests.ts:318` discards the staging write
  result; `:326` also discards `syncDirectoryDurable(parent)`.
- `scripts/npm-release.ts:405-419` logs the returned directory status while
  advancing in-memory state.
- The final success line at `scripts/npm-release.ts:166` unconditionally says
  `Durable release state`, including after an `"unsupported"` result.
- `tests/storage/atomic-file.test.ts:162-183` proves the primitive returns
  `{ durability: "durable", directorySync: "unsupported" }` on the injected
  Windows path. No higher-level test requires a caller to propagate or
  downgrade that result.

**Attempted refutation:**

- POSIX directory-sync errors other than a recognized unsupported condition
  throw, so ordinary POSIX callers do not silently ignore an I/O error.
- Many affected files are rebuildable or conservative when lost. That limits
  consequence but does not make the achieved guarantee equal the requested
  one.
- npm release remains safe because every run freshly reconciles exact
  registry identities. The issue there is false local-state labeling, not
  duplicate publication.
- Windows may lack an equivalent Node directory-handle primitive. A platform
  limitation can be an honest bounded contract; it cannot be called full
  durability without qualification.

**Consequences:**

- Higher-level protocols cannot distinguish full directory durability from a
  file-flushed visibility result.
- Watch refresh can return `accepted` under a platform outcome that its
  “accepted intent is never lost” documentation excludes.
- Operators receive “Durable release state” when the coordinator has already
  observed that it could not establish that guarantee.
- The result type makes the optimistic field easier to consume than the
  limiting field.

**Recommended design:**

- Replace the echo field with a discriminated achieved result, for example:
  `visibility`, `file-flushed`, or `directory-durable`.
- Require every authoritative caller to choose a policy:
  - require full directory durability and fail before acknowledgement;
  - accept a bounded platform guarantee and propagate it;
  - classify the record rebuildable and stop naming it durable.
- Make watch-refresh admission and completion return/record the achieved
  guarantee, or fail closed when their protocol requires the stronger state.
- Make npm release output say exactly what was achieved. Registry
  reconciliation can remain the ultimate safety authority.

**Required tests:**

- Inject unsupported directory handles at each authoritative higher-level
  publisher, not only the primitive.
- Assert the operation either fails before acknowledgement or returns a
  bounded result visible to its caller.
- Assert no log line contains unqualified “durable” for an unsupported
  outcome.

**Acceptance condition:** no public or protocol-level success can imply
directory-entry durability unless the achieved result is `directory-durable`.

---

### DUR-06 — Medium — Cache ownership publication and rollback do not preserve the destructive-safety credential

**Evidence:** source-confirmed ordering; missing fault-injection seam.

**Contract:**

The cache ownership record is a destructive-safety credential: later cleanup
may remove a cache tree only because this record binds that physical path to
the project. Publication must therefore be complete and durable, and failed
adoption must durably remove the credential before returning.

**Code:**

- `src/platform/cache-layout.ts:135-173` creates or adopts a cache, writes the
  ownership record, revalidates the cache contents, hardens the tree, and
  removes the record if that second validation/hardening fails.
- `writeNewPrivateFile` at `:365-373`:
  - calls `writeSync` exactly once and ignores its returned byte count;
  - flushes the file;
  - never flushes the containing directory.
- `mkdirPrivate` at `:360-363` recursively creates the cache path without
  durable ancestor publication.
- The failure rollback at `:169-171` unlinks the owner file but does not flush
  the cache directory.

**Failure modes:**

1. A short `writeSync` can publish and flush a truncated ownership record
   while `ensureOwnedCacheDir` continues without rereading it.
2. A successful complete record can disappear after power loss because its
   directory entry was never flushed.
3. If a concurrent change makes the second adoption check or hardening fail,
   the code unlinks the credential and throws. Without directory fsync, a
   crash can resurrect that valid credential alongside a tree that failed the
   adoption/hardening step.
4. On the next run, the presence of a valid matching credential skips the
   adoptable-layout check and establishes ownership for destructive cache
   operations.

**Attempted refutation:**

- A truncated record normally fails closed on the next read. It still means
  the function reported successful ownership before publishing a readable
  credential.
- The second adoption failure requires a race or host error between the two
  checks. It is not the common path, but that second check exists precisely to
  protect the boundary from such a change.
- Recursive removal of symlinks does not normally traverse the symlink
  target. The credential still authorizes deleting arbitrary newly introduced
  entries inside the physical cache tree, which the adoption rule intended to
  reject.
- Existing cache-ownership tests cover safe creation, recognized legacy
  adoption, mode hardening, arbitrary existing data, copied records, and
  malformed records. They do not inject short writes, directory-sync failure,
  or a crash after rollback unlink.

**Consequences:**

- A successful setup can leave a cache that later fails ownership validation.
- A failed adoption can leave a persistent authorization record that the
  function attempted to revoke.
- The safety proof has weaker durability than many rebuildable cache records
  it authorizes cleanup to delete.

**Recommended design:**

- Use `writeFileCompletely` for the ownership descriptor.
- Stage and validate the complete ownership transition, including tree
  hardening, before exclusively publishing the public credential where
  possible.
- Flush the cache directory after credential publication and after rollback
  deletion.
- Durably establish the cache directory chain through DUR-01's initializer.
- Add a runtime seam for deterministic write, flush, link, unlink, and
  directory-flush fault injection.

**Required tests:**

- Force repeated one-byte short writes and prove complete output.
- Return zero progress and prove explicit failure with no public credential.
- Fail the second adoption/hardening phase, inject a crash model after unlink,
  and prove recovery cannot observe ownership.
- Inject unsupported and failed directory sync and assert the achieved result
  is not silently upgraded.

**Acceptance condition:** a matching ownership credential is reachable after
recovery if and only if the complete adoption and hardening transaction
committed.

---

### DUR-07 — Low — Immutable artifact mode is changed after the final file flush

**Evidence:** source-confirmed ordering; missing mode-durability test.

**Contract:**

If read-only mode is part of what makes a published generation immutable, the
mode change must occur before the artifact's final metadata flush.

**Code:**

- `src/reindex/sqlite-generation-store.ts:750-759` copies an artifact, opens
  it, calls `fsyncSync`, closes it, and only then calls
  `chmodSync(target, 0o444)`.
- No later artifact fsync follows the mode change.
- `docs/INDEX_GENERATIONS.md:37-41` states that files inside a named
  generation directory are immutable.
- The reader does not verify mode when resolving a generation.

**Attempted refutation:**

- The mode change is visible during ordinary execution.
- Directory fsync after the generation rename persists the directory entry;
  it is not a substitute for flushing the child inode metadata modified by
  `chmod`.
- Read-only mode is defense in depth, not cryptographic immutability. DUR-02's
  checksum enforcement would remain necessary even after fixing this order.
- No current test asserts the stored generation files' mode or its place in
  the persistence sequence.

**Consequences:**

- After a crash, artifact bytes can be durable while the read-only protection
  is not.
- The on-disk state can be weaker than the documented immutable layout even
  though generation publication succeeded.

**Recommended design:**

- Apply the final mode before the final artifact fsync.
- Treat permission hardening failure as publication failure before the
  generation pointer can advance.
- On supported POSIX hosts, validate expected mode when reusing an existing
  generation and repair it before acceptance if policy permits.

**Required tests:**

- Assert `copy -> chmod -> fsync -> close` ordering.
- Inject chmod and post-chmod fsync failure.
- Assert published POSIX generation artifacts are read-only.

**Acceptance condition:** every successfully published immutable artifact has
durable final bytes and durable final protection metadata.

---

### DUR-08 — Medium — Recovery tests inject control-flow failures but do not model the filesystem durability frontier

**Evidence:** test-gap confirmation; focused suite result.

**Contract:**

A durability test must distinguish process visibility from persisted state.
Throwing an exception after a callback proves recovery from a stopped
algorithm; it does not prove which file and directory operations survived a
kernel or machine crash.

**Current coverage:**

- `tests/storage/atomic-file.test.ts` has a useful syscall trace and injected
  file/directory sync failures. Its roots already exist, so it cannot expose
  DUR-01.
- `tests/storage/watch-refresh-requests.test.ts:97-158` throws after logical
  claim, completion, and publication callbacks. It does not inject or record
  directory creation, hard-link persistence, or unsupported sync.
- `tests/reindex/sqlite-generation-store.test.ts:27-90` throws at named
  publication stages while the process and filesystem remain live.
- `tests/reindex/shared-generation-store.test.ts` tests ordinary publication,
  content corruption, and in-process hydration rollback, with no artifact
  flush or directory-rename runtime.
- `tests/scripts/npm-release.test.ts:276-299` models “crash” by throwing from
  an in-memory runtime whose `writeReleaseState` returns `"synced"`.
- Cache ownership has no injectable filesystem runtime.

**Focused baseline:**

The following nine files passed during the audit:

- atomic file;
- watch refresh requests;
- bounded mailbox;
- SQLite generation store;
- shared generation store;
- verified binary fetch;
- cache ownership;
- npm release;
- rotating JSONL.

Result: **9/9 files and 138/138 tests passed**.

That green result is valuable for ordinary semantics, but DUR-01, DUR-03,
DUR-04, DUR-05, DUR-06, and DUR-07 remain source-confirmed because their
missing persistence phases are outside the current test models.

**Attempted refutation:**

- Unit tests cannot force a real power failure portably. They can still model
  the durability frontier by recording which writes, file flushes, renames,
  links, unlinks, directory creations, and directory flushes have committed.
- `kill -9` child-process tests cover process crashes but not kernel page-cache
  loss. Both are useful, and neither should be mislabeled as the other.
- Production filesystems and devices vary. That makes the syscall contract
  and honest platform bounds more important, not less.

**Recommended design:**

- Define one injectable filesystem publication port shared by durability
  protocols, or small boundary-specific ports with the same phase vocabulary.
- Build a deterministic persisted-state model:
  - writes change volatile file contents;
  - file fsync advances persisted inode contents/metadata;
  - rename/link/unlink changes volatile namespace;
  - directory fsync advances persisted namespace;
  - crash discards changes beyond the frontier.
- Replay recovery after every phase and assert the protocol invariant.
- Add child-process termination tests for process-crash claims.
- Keep actual filesystem integration tests narrow and platform-gated; use the
  model for exhaustive phase enumeration.

**Required test matrix:**

| Protocol           | Required crash points                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Atomic replacement | parent creation, staged write, file flush, rename/link, target-dir flush, ancestor flush     |
| Local generation   | each artifact, mode change, manifest, staging rename, generation-root flush, pointer write   |
| Shared generation  | each artifact flush, manifest, staging-dir flush, rename, generations-dir flush              |
| Watch refresh      | request/claim/completion staging, hard link, parent and ancestor flush, claim removal        |
| Mailbox            | skeleton creation, owner-dir publication, claim rename, response publication, claim deletion |
| Cache ownership    | short write, file flush, public link/name, hardening, rollback unlink, directory flush       |
| Release state      | synced, unsupported, and failed directory publication before and after registry mutation     |

**Acceptance condition:** every documented crash outcome is held by an
executable oracle that distinguishes volatile visibility from persisted
recovery state.

---

### DUR-09 — Low — The durability documentation has drifted from both implementation and platform bounds

**Evidence:** literal source/doc comparison; heuristic doc-drift signal.

**Confirmed mismatches:**

1. `docs/DURABILITY.md:89` classifies TypeScript/Rust request and response
   mailboxes as visibility-atomic, but current request and completion
   publication uses `createFileAtomicExclusive(..., { durability:
"durable" })`, and owner/rejection records use `writeJsonDurable`.
2. The durability API table says the durable helper flushes the parent
   directory, but neither the table nor failure outcomes state that a newly
   created parent needs its own parent flushed.
3. `docs/WATCH_REFRESH_REQUESTS.md` says an acknowledged request can never
   disappear and successful acknowledgement is never inferred from absence.
   It does not bound that promise for first-created directory chains or
   unsupported directory handles.
4. `docs/INDEX_GENERATIONS.md:57-70` gives a correct steady-state publication
   order but assumes the generation root already has a durable name.
5. Runtime and release messages can use unqualified “durable” after the
   primitive reports unsupported directory sync.

`scip-query doc-drift docs/DURABILITY.md --full` independently reported
staleness 6 after changes in reindex, watch service, and shared generation
code. That detector is heuristic; the five literal mismatches above are the
retained evidence.

**Attempted refutation:**

- “Durable” can informally mean retained across process restarts or committed
  to Git. This repository already defines the stronger file-and-directory
  flush meaning in `docs/DURABILITY.md`, so the same word cannot safely carry
  a weaker meaning at adjacent call sites without a qualifier.
- The mailbox implementation being stronger than its table row is not itself
  a correctness failure. It is still contract drift that obscures the
  owner-directory gap in DUR-04.
- Documentation should not be updated to promise the intended fixed state
  before the code and tests establish it.

**Recommended design:**

- After DUR-01 through DUR-08, regenerate the call-site matrix from a
  descriptor owned by each persistence boundary where practical.
- Distinguish:
  - visibility-atomic;
  - process-crash recoverable;
  - file-flushed;
  - directory-durable;
  - rebuildable and integrity-checked;
  - Git-durable after commit.
- Add the newly-created-parent and achieved-platform outcome to the failure
  table.
- Keep watch refresh and index generation docs synchronized with executable
  crash-oracle cases.

**Acceptance condition:** every use of “durable” identifies the same
enforceable guarantee, its platform bound, and the recovery oracle that holds
it.

---

## 5. Refuted or bounded concerns

The review explicitly attempted to refute problems rather than treating every
plain write as a defect.

### 5.1 Stable SQLite mirrors are not the internal generation authority

`promoteReindexArtifacts` replaces `index.scip`, `index.db`, and `meta.json`
after the immutable pointer switches. Those replacements are not individually
flushed. This initially resembles a multi-file crash bug.

The concern is bounded because:

- current internal database consumers resolve `state.json` once and open one
  immutable generation;
- stable mirrors are documented as compatibility paths;
- their identities are recorded for drift diagnosis;
- freshness/status can report drift and a later refresh repairs it.

This review therefore does not claim mixed stable mirrors corrupt current
internal `ScipDatabase` readers. External tools that read those mirrors remain
subject to the documented compatibility-repair window.

### 5.2 Evidence cache reduced synchronization is deliberate and fail-safe

The evidence SQLite database uses WAL and reduced per-commit synchronization.
Source comments identify it as rebuildable, and a cache miss recomputes
evidence. It does not select the accepted index generation. Losing recent
cache rows after power loss costs work but does not authorize unverified
facts.

### 5.3 Rotating JSONL is process-visible telemetry, not acknowledged authority

The two-segment telemetry writer does not fsync every append or rotation.
That is consistent with its documented contract. It repairs or ignores an
incomplete tail, retains earlier complete rows, bounds segment sizes, and
never changes the authoritative reindex result when telemetry fails.

### 5.4 Output snapshots are temporary continuation state

Output pagination snapshots are bounded temporary files with descriptor and
content checks. A crash can make a continuation unavailable; the command can
be rerun. They are not committed user data and do not select future program
behavior beyond that continuation.

### 5.5 Process locks need not survive a machine crash

A lock represents a live process instance. After a machine restart the owner
cannot remain live, so losing the lock does not permit two surviving owners.
The more relevant guarantees are complete public records during ordinary
execution, PID-birth identity, token-checked release, and conservative
reclamation; the current common lock protocol provides those.

### 5.6 npm publication safety does not depend solely on local state

The local release ledger improves recovery and diagnostics, but every run
reconciles exact immutable registry identities before acting. Losing the
latest local stage does not cause a different tarball to occupy an existing
npm version. DUR-05 therefore targets the false durability label and
platform-result propagation, not the coordinator's registry safety.

### 5.7 Outcome events become repository-durable through Git

Outcome events are created as independent local files and are explicitly
expected to be committed with the change. Before commit, a machine crash can
lose an event; after commit, Git supplies the shared historical authority.
The source comment's phrase “durable, team-shared” should be read as
Git-committed durability. DUR-09 recommends making that qualifier explicit,
but this review does not require fsync on every diff-gate event.

---

## 6. SCIP evidence used

The review used scip-query only where compiler-resolved identity or subsystem
relationships mattered:

- `status --capabilities` once at the start: fresh generation
  `c6d1cde3299e`;
- complete `outline` results for atomic file, bounded mailbox, local
  generation store, and shared generation store;
- complete `refs --full` results for:
  - `replaceFileAtomic`;
  - `writeJsonDurable`;
  - `cloneArtifactFile`;
  - `initializeBoundedMailbox`;
  - `promoteReindexArtifacts`;
  - `enqueueWatchRefreshRequest`;
  - `publishSharedGeneration`;
  - `appendOutcomeEvents`;
  - `readImmutableGeneration`;
  - `resolveSqliteGeneration`;
  - `readSharedGeneration`;
- `affected replaceFileAtomic --max-depth 8`: 47 affected symbols across 25
  files;
- `affected writeJsonDurable --max-depth 8`: 34 affected symbols across 16
  files;
- fully retrieved paginated `system src/storage` and `system src/reindex`
  subsystem maps;
- `decorative-checkers --full` for storage and reindex: no candidates;
- `not-implemented --full` for storage: no reachable placeholder stubs;
- `doc-drift docs/DURABILITY.md --full`: heuristic staleness candidate,
  retained only after literal verification.

Native source reads were used for exact filesystem ordering and test
assertions. No scip-query output page was used as evidence until all emitted
continuations reported `complete: true`.

---

## 7. Verification performed

Focused suite:

```text
tests/storage/atomic-file.test.ts
tests/storage/watch-refresh-requests.test.ts
tests/storage/bounded-mailbox.test.ts
tests/reindex/sqlite-generation-store.test.ts
tests/reindex/shared-generation-store.test.ts
tests/platform/verified-binary-fetch.test.ts
tests/platform/cache-ownership.test.ts
tests/scripts/npm-release.test.ts
tests/reindex/rotating-jsonl.test.ts
```

Result:

```text
Test Files  9 passed (9)
Tests       138 passed (138)
```

The suite establishes the current ordinary and process-exception baseline. It
does not refute the persistence-order findings because the missing directory,
checksum, and achieved-guarantee phases are not represented in those tests.

---

## 8. Recommended remediation sequence

The slices below are independently reviewable, but the arrows identify real
dependencies.

### Slice 1 — Establish an achieved-durability model

Addresses DUR-05.

- Replace requested/achieved ambiguity with a discriminated result.
- Classify every authoritative caller as required, bounded, or rebuildable.
- Make unsupported outcomes observable at the protocol boundary.

This should land first because later slices need a truthful result type.

### Slice 2 — Durably create directory chains

Addresses DUR-01.

- Add durable directory initialization.
- Use it for watch refresh, local generations, shared generations, release
  state, setup/config, and other authoritative first-publication paths.
- Add ancestor-order fault tests.

Dependency: Slice 1 → Slice 2, because directory creation must return an
achieved guarantee.

### Slice 3 — Close watch and mailbox namespace gaps

Addresses the watch-specific part of DUR-01 and DUR-04.

- Precreate/flush watch request protocol directories.
- Flush new mailbox owner-directory entries before moving requests.
- Add recovery invariants at every phase.

Dependency: Slice 2 → Slice 3.

### Slice 4 — Enforce local generation integrity

Addresses DUR-02.

- Verify manifest hashes before first process acceptance.
- Cache verified generation identity safely.
- Add same-size corruption tests and define previous-generation recovery.

This can proceed in parallel with Slices 1-3.

### Slice 5 — Complete shared generation publication

Addresses DUR-03.

- Flush artifact files and final modes.
- Flush the staging and publication directories.
- Preserve read-side hash validation and cache-miss recovery.

Dependency: Slice 2 → Slice 5 for durable `generations/` creation.

### Slice 6 — Make cache ownership one durable safety transaction

Addresses DUR-06.

- Handle short writes.
- Publish/revoke the credential durably.
- Prevent failed adoption from resurrecting authority.

Dependency: Slice 1 → Slice 6 for achieved-result handling; the durable
directory helper from Slice 2 should be reused.

### Slice 7 — Put protection metadata before the final artifact flush

Addresses DUR-07.

- Reorder chmod and fsync.
- Add mode and failure tests.

This can land with Slice 4 or Slice 5 if the shared clone primitive is
unified.

### Slice 8 — Add the persistence-frontier oracle

Addresses DUR-08.

- Model volatile versus persisted data and namespace operations.
- Apply the crash matrix to every authority.
- Add process-kill tests where process recovery, rather than power recovery,
  is the actual promise.

The test harness can begin in parallel, but closure follows Slices 1-7.

### Slice 9 — Reconcile durability documentation

Addresses DUR-09.

- Update the call-site matrix, crash tables, Windows bounds, watch contract,
  mailbox classification, generation initialization, and release wording.
- Bind documented cases to executable recovery tests.

Dependency: Slices 1-8 → Slice 9. Documentation should describe the shipped
guarantee, not the intended one.

---

## 9. Closure criteria

The durability program is complete only when all of the following are true:

- no durable publisher creates an unflushed parent directory chain;
- every acknowledged authority reports the achieved platform guarantee;
- an accepted watch-refresh request cannot disappear under any modeled crash
  point within its supported platform contract;
- a mailbox claim cannot durably leave pending before its complete inflight
  path is durable;
- local generation readers reject same-size content corruption before using
  it as code intelligence;
- shared generation success follows artifact flush and publication-directory
  flush;
- cache ownership publication and revocation are complete, short-write-safe,
  and crash-consistent;
- immutable artifact protection metadata precedes the final file flush;
- the persistence-frontier test oracle covers every documented crash row;
- docs, logs, and result types use “durable” only for one precise,
  enforceable guarantee.

---

## 10. Remediation record

| Finding | Status   | Replacement mechanism                                                                                                                                                                                                                                                                                                  | Executable evidence                                                                                                           |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| DUR-01  | Resolved | `ensureDirectoryDurable` creates each missing component from the nearest existing ancestor and synchronizes the directory that names it. Atomic file publication, local/shared generation roots, watch protocol roots, mailbox skeletons, and new cache roots reuse it.                                                | `durable-path.test.ts`; `atomic-file-crash.test.ts`; atomic/watch/mailbox/generation focused suites                           |
| DUR-02  | Resolved | `readImmutableGeneration` authenticates database, SCIP, and metadata bytes against manifest SHA-256 values. Its bounded cache includes manifest digest plus device, inode, size, nanosecond mtime, and nanosecond ctime and rechecks identity after hashing. Corrupt current fails closed even when previous is valid. | Same-size post-cache corruption cases for all artifact classes in `sqlite-generation-store.test.ts`                           |
| DUR-03  | Resolved | Shared publication durably clones every artifact with final mode, flushes the manifest and staging namespace, renames the directory, then synchronizes `generations/`. The rename race catch is limited to rename itself, so a post-rename failure cannot be converted into success.                                   | `durable-file.test.ts`; shared publication stage matrix and corruption cases in `shared-generation-store.test.ts`             |
| DUR-04  | Resolved | A mailbox owner directory is durably named from `inflight/` before its owner record or any pending-to-inflight rename. Source and destination directories are synchronized separately after transfer.                                                                                                                  | Five-stage claim crash/recovery matrix in `bounded-mailbox.test.ts`                                                           |
| DUR-05  | Resolved | Atomic results distinguish requested from achieved durability. Watch admission, mailbox admission/claim, shared publication, detailed cache ownership, and npm release logs preserve `directory-durable` versus `file-flushed`/`unsupported`.                                                                          | POSIX/Windows atomic tests, ownership unsupported/failure tests, watch/mailbox assertions, npm release logging tests          |
| DUR-06  | Resolved | Cache adoption hardens and revalidates the legacy tree before publishing authority. A short-write-safe private candidate is flushed and hard-linked exclusively as the final credential, then its directory is synchronized. No unsafe post-publication rollback remains.                                              | One-byte writes, zero-progress, symlink hardening, unsupported sync, and real sync failure cases in `cache-ownership.test.ts` |
| DUR-07  | Resolved | `cloneFileDurable` performs copy/reflink, final `chmod`, file synchronization, close, and namespace synchronization in that order. Local and shared immutable publishers reuse it.                                                                                                                                     | Exact order and injected chmod/file-sync failures in `durable-file.test.ts`; POSIX `0444` generation assertion                |
| DUR-08  | Resolved | `PersistenceFrontierRuntime` separates volatile contents/names from persisted inode and directory state, discards the former on modeled power loss, and replays atomic replacement, exclusive creation, ancestor creation, and artifact clone phases. Protocol-stage matrices hold the composition order.              | `atomic-file-crash.test.ts` plus local/shared generation, watch, mailbox, ownership, and release-state focused suites         |
| DUR-09  | Resolved | Durability, generation, watch, mailbox, Windows release, and README wording now names full path creation, exact platform bounds, hash enforcement, claim ordering, and Git-qualified outcome-event durability.                                                                                                         | Prettier, documentation-link validation, terminology search, and SCIP `doc-drift`/`diff-gate`                                 |

The result intentionally preserves two bounds. A Windows host that rejects
directory synchronization receives `file-flushed` rather than a false
machine-crash guarantee. A failure after a public rename or link can leave a
complete value visible even though the operation throws; retry and
content/identity validation reconcile that state without pretending the
failed call acknowledged it.
