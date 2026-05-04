# AST Migration — Replace All Regex Parsers — 2026-05-04

## Goal

Replace every regex-based language parser in `src/source-analysis.ts` with a tree-sitter AST parser. Eliminates whole classes of bugs (unclosed comments fooling the regex masker, raw strings, format-string interpolation, nested template literals, JSX text nodes, macro-like syntax) and lets each language's actual grammar drive the parse.

## Current state (audit)

`src/ast.ts` already supports 5 languages: `rust | typescript | tsx | javascript | python`. The other 6 indexed languages parse imports/exports with regex.

Even within the AST-supported languages, several call sites still use regex when they have an AST alternative.

## Phases

### Phase A — AST languages still using regex

These languages have tree-sitter parsers loaded but specific code paths still use regex.

#### A.1 — `findIdentifierLines` use AST when available

- [ ] **File**: `src/source-analysis.ts:136-180`
- **What**: Hot path behind `refs`, `dataflow`, `unused-imports`, source-fallback callers. Currently runs `stripCommentsAndStrings` (8 regex passes) + line-by-line `\bIDENT\b` regex on raw source.
- **Change**: For AST-supported languages, delegate to `getIdentifierLineMap(db, relativePath).get(identifier) ?? []` and apply the `excludeStartLine`/`excludeEndLine` filter. Keep current regex implementation as fallback for non-AST languages.
- **Why**: `getIdentifierLineMap` already exists (line 830) and is cached per file. AST avoids the 8-pass strip and correctly handles raw strings, JSX text, format-string interpolation. The `source.indexOf(identifier) === -1` early exit added in the perf fix stays in place to short-circuit before AST lookup.

#### A.2 — `parseRustExports` use AST

- [ ] **File**: `src/source-analysis.ts:990-1023`
- **What**: Rust `pub use ... ` re-exports. The import side already has `parseRustImportsAst` (line 668) using `descendantsOfType('use_declaration')` + `flattenRustUseTree`. The export side is regex-only.
- **Change**: Add `parseRustExportsAst(db, relativePath, tree): ParsedSourceExport[]` that walks `use_declaration` nodes whose visibility modifier is `pub`. Reuse `flattenRustUseTree` for the use-tree shape. Plug into `getSourceExports` dispatch like `parseRustImports` does for the import side.
- **Why**: Rust's macro-friendly comments and raw strings break the regex pass.

#### A.3 — Delete unreachable regex fallbacks for JS / Rust / Python imports

- [ ] **Files**: `src/source-analysis.ts:497-588` (`parseJavaScriptImportStatements`, `parseJavaScriptImportStatement`, `parseImportClause`, `parseImportBinding`, `splitImportClause`, `splitTopLevel`), `src/source-analysis.ts:944-988` (`parseRustUseClause`), `src/source-analysis.ts:1356-1516` (`collectPythonImportStatements`, `parsePythonStatementHeader`, `parsePythonImportStatement`)
- **What**: Each AST parser has a sibling regex fallback that fires when `getAst` returns null. Tree-sitter parsers don't fail on real source — these are dead code in practice.
- **Change**: Make `parseJavaScriptImports` / `parseRustImports` / `parsePythonImports` return `[]` when AST is unavailable, and delete the regex helpers.
- **Why**: ~400 LOC of dead regex code, easier to maintain.

### Phase B — Languages with no AST today

For each, the deliverables are identical:
1. Add the `tree-sitter-<lang>` npm dependency.
2. Add the language to `AstLanguage` in `src/ast.ts`.
3. Extend `LANGUAGE_BY_EXT` and the `loadGrammar` switch.
4. Replace the regex parser with an AST parser using `descendantsOfType('<import_node>')`.
5. Keep the regex code path as a fallback only if `getAst` returns null.

Available packages on npm (verified):
- `tree-sitter-java@0.23.5`
- `tree-sitter-kotlin@0.3.8`
- `tree-sitter-scala@0.24.0`
- `tree-sitter-ruby@0.23.1`
- `tree-sitter-c@0.24.1`
- `tree-sitter-cpp@0.23.4`
- `tree-sitter-c-sharp@0.23.5`
- `tree-sitter-dart@1.0.0`
- `tree-sitter-php@0.24.2`

#### B.1 — Java (`.java`)

- [ ] **Package**: `tree-sitter-java`
- **File**: `src/source-analysis.ts:590-639` (`parseJvmImports`, `parseJvmImportClause`)
- **AST nodes**: `import_declaration` with `scoped_identifier` for the dotted path; static + wildcard markers as adjacent tokens.
- **Note**: `parseJvmImports` currently dispatches by file ext to handle `.java` / `.kt` / `.scala`. Split into `parseJavaImports` (AST), `parseKotlinImports` (B.2), `parseScalaImports` (B.2). Update `getSourceImports` dispatch.

#### B.2 — Kotlin + Scala (`.kt`, `.kts`, `.scala`, `.sc`)

- [ ] **Packages**: `tree-sitter-kotlin`, `tree-sitter-scala`
- **AST nodes (Kotlin)**: `import_header` with `identifier`/`simple_identifier` chains.
- **AST nodes (Scala)**: `import_declaration` / `import_expr`.
- **Note**: Scala 3 quotes brace-imports differently from Scala 2 — parser may emit different node names; handle both.

#### B.3 — Ruby (`.rb`)

- [ ] **Package**: `tree-sitter-ruby`
- **File**: `src/source-analysis.ts:1037-1085` (`parseRubyImports`, `rubyConstantName`)
- **AST nodes**: `call` nodes whose method is `require` / `require_relative` / `load` / `autoload` / `extend` / `include`. The first string argument is the specifier; for `autoload`/`extend`/`include` the constant is the second arg (or method receiver).

#### B.4 — C / C++ (`.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`)

- [ ] **Packages**: `tree-sitter-c`, `tree-sitter-cpp`
- **File**: `src/source-analysis.ts:1087-1109` (`parseCLikeImports`)
- **AST nodes**: `preproc_include` with `string_literal` (quoted form) or `system_lib_string` (angle-bracket form).
- **Note**: `.h` is ambiguous (C or C++); detect by sibling `.cc`/`.cpp` files in the same directory or default to C.

#### B.5 — C# (`.cs`)

- [ ] **Package**: `tree-sitter-c-sharp`
- **File**: `src/source-analysis.ts:1111-1149` (`parseDotNetImports`)
- **AST nodes**: `using_directive` with `identifier_name` / `qualified_name` for the dotted path; `static` / alias modifiers as siblings.

#### B.6 — Dart (`.dart`)

- [ ] **Package**: `tree-sitter-dart`
- **File**: `src/source-analysis.ts:1151-1190` (`parseDartImports`, `parseDartExports`)
- **AST nodes**: `import_or_export` / `library_import` / `library_export` (depending on grammar version) with `uri` / `string_literal` for the specifier; `as` clauses for prefixes; `show` / `hide` combinators for filtered imports.

#### B.7 — PHP (`.php`)

- [ ] **Package**: `tree-sitter-php`
- **File**: `src/source-analysis.ts:1192-1222` (`parsePhpImports`)
- **AST nodes**: `namespace_use_declaration` with `namespace_name` and optional `namespace_use_clause`; `function` / `const` modifiers for sub-namespace imports; group imports `use Foo\{Bar, Baz}` are `namespace_use_group`.

### Phase C — Verification

- [ ] `npm test` — all 119 tests pass.
- [ ] `scip-query reindex` + `scip-query health` on `scip-query` itself — score still 100/100, drift clean.
- [ ] `scip-query reindex --pnpm-workspaces` + smoke on `VegaAssistant` (TS+Rust+Python) — all 51 commands return.
- [ ] Spot-check `scip-query imports <file>` on a sample file in each language fixture under `tests/fixtures/`.
- [ ] `scip-query refs <symbol>` on a multi-language symbol — confirms `findIdentifierLines` AST path works cross-language.
- [ ] Verify dist size hasn't ballooned past expectations (each tree-sitter parser is ~1-3 MB).

## Out of scope

- `stripCommentsAndStrings`: still used by `buildUsageBody` and a few namespace-member scanners on the regex path. After A.1 removes its hot-path use it's still mildly useful as a generic pre-processor; revisit if it shows up in profiles again.
- AST-based call resolution beyond what `getCallSites` already does — that's a separate question.

## Ship order

Phases are independent and individually shippable:
- A.1 first (highest ROI, no new deps).
- A.2 next (small, follows existing pattern).
- A.3 only after A.1 + A.2 are stable.
- B.x can ship in any order; each is a self-contained language addition.
- C runs continuously after every step.
