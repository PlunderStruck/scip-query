# Plan: Fold `symbols` Workflow Into `outline`

Date: 2026-06-09

## Goal

The user wants to know whether `symbols <file>` and `outline <file>` can be combined so a file's definitions appear in a tree while optional details remain available. A symbol is a named indexed program unit, such as a function, type, class, method, variable, or module, whose references can point back to its definition. An outline is a hierarchical view of a file's symbols, where the defining fact is containment: it shows which definitions contain other definitions.

Done means `scip-query outline <file>` keeps the original clean tree with line ranges by default, `scip-query outline <file> --signatures` shows trimmed signatures on demand, and the public `symbols` CLI command is removed. The underlying `symbols()` query can remain as a library/internal helper.

Difficulty: low. `outline` already uses the same definition source as `symbols`, already carries line ranges internally, and already renders line ranges. The missing detail is the signature field.

## Current State

`symbols <file>` is a flat inventory. `src/queries/symbols.ts:15-18` resolves indexed paths and returns `loadFileSymbols(db, paths).map(({ relativePath: _r, ...rest }) => rest)`. Its public row type at `src/queries/symbols.ts:7-13` includes `startLine`, `endLine`, `symbol`, `shortName`, and `signature`. Source: `scip-query code symbols -C 8`, `scip-query code SymbolResult -C 5`.

`outline <file>` is already a symbol tree with line ranges. `src/queries/outline.ts:21-77` resolves indexed paths, calls `loadFileSymbols(db, paths, { sort: true })`, maps each definition to an `OutlineNode`, and builds parent-child relationships from `enclosingSymbol` or geometric containment. `src/queries/outline.ts:6-12` defines `OutlineNode` with `symbol`, `shortName`, `startLine`, `endLine`, and `children`. Source: `scip-query code outline -C 8`, `scip-query code OutlineNode -C 5`.

The current outline renderer already prints ranges. `src/runtime/query-commands/navigation.ts:48-58` calls `queries.outline`, recursively prints each node, and formats each row as `${displayRange(n.startLine, n.endLine)}  ${n.shortName}`. Source: `scip-query code handleOutline -C 10`.

The removed symbols renderer printed the extra signature. `src/runtime/query-commands/navigation.ts` used to register `symbols <file>` and format each row as `displayRange`, `shortName`, plus `signature` when present. Source: `scip-query code src/runtime/query-commands/navigation.ts:120-170`.

The shared definition catalog already has the missing data. `src/symbols/definition-catalog.ts:44-52` defines `FileSymbolResult` with `signature`. `src/symbols/definition-catalog.ts:173-203` builds `FileSymbolResult[]` and sets `signature: cleanSignature(extractSignature(d.documentation))`. Source: `scip-query code FileSymbolResult -C 5`, `scip-query code loadFileSymbols -C 8`.

Runtime proof: `scip-query outline src/runtime/query-command-specs.ts` currently prints hierarchical rows with ranges, while `scip-query symbols src/runtime/query-command-specs.ts` prints flat rows with ranges and signatures. Source: `scip-query outline src/runtime/query-command-specs.ts`, `scip-query symbols src/runtime/query-command-specs.ts`.

Blast radius is small. `src/queries/outline.ts` has four external consumers and medium risk; `OutlineNode` has one consumer. `src/runtime/query-commands/navigation.ts` has two external consumers; `handleOutline` itself has zero external consumers. Sources: `scip-query change-surface src/queries/outline.ts`, `scip-query change-surface src/runtime/query-commands/navigation.ts`, `scip-query refs OutlineNode`, `scip-query refs outline`, `scip-query affected OutlineNode`, `scip-query affected outline`.

## Reuse Audit

- Reuse `loadFileSymbols`, not a new query. It already supplies the source-corrected ranges and signatures both commands need. Source: `scip-query code loadFileSymbols -C 8`.
- Reuse the underlying signature data, but keep signature rendering opt-in and trimmed because variable signatures can be noisy. Source: `scip-query code src/runtime/query-commands/navigation.ts:120-170`.
- Reuse `outline` tree construction; do not build a second tree command. Source: `scip-query code outline -C 8`.
- Similarity confirms these commands are already close siblings: `scip-query similar symbols` reports `symbols()` and `outline()` as 76% similar because both call `resolveIndexedPaths()` and `loadFileSymbols()`, while `outline()` additionally calls `isAncestorSymbol()` for containment fallback. Source: `scip-query similar symbols`.
- `scip-query similar-files src/queries/outline.ts` found no similar file pairs, so the implementation should extend the existing file rather than create a new module. Source: `scip-query similar-files src/queries/outline.ts`.

## Design Phases

### Phase 1 — Carry Signatures Through the Outline Tree

Deployable independently: yes.

#### 1.1 — Add `signature` to `OutlineNode`

- [x] **File**: `src/queries/outline.ts:6-12`
- **Source**: `scip-query code OutlineNode -C 5`; `scip-query code FileSymbolResult -C 5`.
- **What**: `OutlineNode` currently has symbol identity, line range, and children, but not the signature already present on `FileSymbolResult`.
- **Change**: Add `signature: string | null` to `OutlineNode`.
- **Why**: This makes `outline()` capable of returning the same per-symbol signature detail that `symbols()` returns.

#### 1.2 — Populate `signature` from `loadFileSymbols`

- [x] **File**: `src/queries/outline.ts:26-32`
- **Source**: `scip-query code outline -C 8`; `scip-query code loadFileSymbols -C 8`.
- **What**: `outline()` maps each `FileSymbolResult` into a node but drops `d.signature`.
- **Change**: Add `signature: d.signature` to the node object.
- **Why**: No new data lookup is needed; the existing catalog row already contains the cleaned signature.

### Phase 2 — Render Outline Rows With Symbol Detail

Deployable independently: yes, after Phase 1.

#### 2.1 — Append signatures only when requested

- [x] **File**: `src/runtime/query-commands/navigation.ts:48-58`
- **Source**: `scip-query code handleOutline -C 10`; `scip-query code src/runtime/query-commands/navigation.ts:120-170`.
- **What**: `handleOutline` currently prints `range + shortName`. `symbols` prints `range + shortName + signature`.
- **Change**: In `printTree`, compute the signature suffix only when `--signatures` is present, trim long signatures, and print `${prefix}${displayRange(n.startLine, n.endLine)}  ${n.shortName}${sig}`.
- **Why**: This preserves the original clean outline by default while keeping deeper compiler detail available on demand.

#### 2.2 — Remove the public `symbols` command

- [x] **File**: `src/runtime/query-commands/navigation.ts:129-139`
- **Source**: `scip-query code src/runtime/query-commands/navigation.ts:120-170`; `scip-query trace symbols`.
- **What**: `symbols` is a flat command with high overlap against `outline`.
- **Change**: Remove `symbols` from the public CLI descriptors and command order, while keeping the query module available for library/internal use.
- **Why**: The default human workflow should have one file-structure command; flat symbol inventory was not earning its public command surface.

### Phase 3 — Docs and Validation

Deployable independently: yes, after Phase 2.

#### 3.1 — Update command docs if wording should mention signatures

- [x] **File**: `src/runtime/query-commands/navigation.ts:227-232`
- **Source**: `scip-query code src/runtime/query-commands/navigation.ts:220-235`; `scip-query code handleOutline -C 10`.
- **What**: The `outline` descriptor says it is a tree view of symbols using nesting hierarchy.
- **Change**: Change the description to `Tree view of symbols in a file, with line ranges` and add `--signatures`.
- **Why**: The generated docs should advertise that outline now combines hierarchy with symbol detail.

#### 3.2 — Regenerate command reference

- [x] **File**: `docs/COMMAND_REFERENCE.md` generated command table
- **Source**: `scip-query trace renderCommandReferenceMarkdown`; `scip-query code renderCommandReferenceMarkdown -C 8`.
- **What**: The command reference is generated from descriptors.
- **Change**: Run the existing docs generation path after descriptor wording changes and update the generated section.
- **Why**: The docs should match descriptor-owned CLI syntax and descriptions.

#### 3.3 — Add or update command-output coverage

- [x] **File**: `tests/command-accuracy.test.ts`
- **Source**: `scip-query trace outline`; `scip-query code tests/cli-contract.test.ts:1-120` previously returned `Symbol not found or file unreadable.`
- **What**: SCIP verifies `outline()` is used by runtime navigation, but the indexed graph does not expose the test file body.
- **Change**: In the nearest existing command accuracy test, assert `outline()` carries the same range and signature data as `symbols()` for matching definitions.
- **Why**: The behavior change is output formatting, so a command-output assertion is more useful than only typechecking.

#### 3.4 — Run manual checks

- [x] **File**: no file edit
- **Source**: `scip-query outline src/runtime/query-command-specs.ts`; `scip-query symbols src/runtime/query-command-specs.ts`; `scip-query code handleOutline -C 10`.
- **What**: Default `outline` should show ranges but not signatures; `outline --signatures` should show trimmed signatures.
- **Change**: After implementation, run:

  ```bash
  npm run typecheck
  npm test
  npm run lint
  npm run build
  node dist/cli.js reindex
  node dist/cli.js outline src/runtime/query-command-specs.ts
  node dist/cli.js outline src/runtime/query-command-specs.ts --signatures
  ```

- **Why**: These checks prove the outline tree still nests correctly, now includes signature detail, and does not regress the flat command.

## Stress-Test Findings

1. Understand before touch: `outline` already builds a tree from `loadFileSymbols`; `symbols` already exposes the flat rows. Source: `scip-query code outline -C 8`, `scip-query code symbols -C 8`.
2. Blast radius: `OutlineNode` has one external consumer and no affected-symbol output; this is low-risk additive typing plus rendering. Source: `scip-query refs OutlineNode`, `scip-query affected OutlineNode`.
3. Valid intermediate states: Adding nullable `signature` to `OutlineNode` and populating it is backward-compatible for existing consumers. Source: `scip-query refs OutlineNode`.
4. Reversibility: Rollback removes the new `signature` field and renderer suffix; no data or schema changes.
5. Failure design: Missing signatures should render nothing extra, matching `symbols`. Source: `scip-query code src/runtime/query-commands/navigation.ts:120-170`.
6. Concurrency: No writes or shared mutable state are introduced; this is read-only query/render output.
7. Boundaries: User input remains the same `outline <file>` file pattern; no new trust boundary.
8. Data integrity: No database schema writes or migrations.
9. Observability: CLI output becomes more explanatory because each tree row can show a signature.
10. Human experience: This reduces the need to run both `outline` and `symbols` when planning a file edit.
11. Reuse over reimplement: The change reuses `loadFileSymbols` and the existing `outline` tree; no new command is needed. Source: `scip-query similar symbols`, `scip-query similar-files src/queries/outline.ts`.

## Execution Order

1. Add `signature` to `OutlineNode`.
2. Populate `signature` in the `definitions.map` inside `outline()`.
3. Render signatures in `handleOutline` only behind `--signatures`.
4. Remove the public `symbols` CLI command.
5. Update descriptor/docs wording.
6. Add/update output tests.
7. Run typecheck, tests, build, reindex, and manual `outline` checks.

## Ship Order

Ship as one small CLI-surface change. There are no schema changes. The visible behavior change is that `outline` returns to clean default output, signatures are opt-in, and the flat `symbols` command is removed from the public CLI.

## Summary

Files to modify:

- `src/queries/outline.ts`
- `src/runtime/query-commands/navigation.ts`
- `docs/COMMAND_REFERENCE.md`
- nearest command-output test file

Files to create/delete: none.

Estimated net code delta: about 10-25 lines, plus a small test/doc update.
