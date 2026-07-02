---
name: scip-language-playbook
description: Choose language-specific scip-query commands. Use when entering an unfamiliar TypeScript, Python, Java, Scala, Kotlin, Rust, Go, C, C++, Ruby, C#, Visual Basic, Dart, PHP, Clojure, ClojureScript, or Vue codebase and you need high-signal exploration or de-bloat commands first.
commands:
  - template: "scip-query stats"
    when: "Universal first pass: repo-wide size and shape."
  - template: "scip-query files <feature-or-module-name>"
    when: "Universal first pass: locate the files for a feature or module."
  - template: "scip-query outline <file>"
    when: "Universal first pass: symbol tree for a candidate file."
  - template: "scip-query trace <symbol>"
    when: "Universal first pass: definition plus every reference."
  - template: "scip-query code <symbol>"
    when: "Universal first pass: confirm behavior claims with source."
---

# scip-language-playbook

Use this reference to pick the shortest command path from "what is this system doing?" to verified language-specific answers.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query stats` | Show index statistics | Universal first pass: repo-wide size and shape. |
| `scip-query files <feature-or-module-name>` | Find files matching a pattern | Universal first pass: locate the files for a feature or module. |
| `scip-query outline <file>` | Tree view of symbols in a file, with line ranges | Universal first pass: symbol tree for a candidate file. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | Universal first pass: definition plus every reference. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | Universal first pass: confirm behavior claims with source. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Start with the active language row before broader or noisier commands.
2. Pair relationship commands with `code` for behavior claims.
3. For de-bloat, cross-check multiple detector families.
4. When a command is weaker in a language, use the listed fallback.

## Universal First Pass

```bash
scip-query stats
scip-query kind-counts
scip-query files <feature-or-module-name>
scip-query outline <file>
scip-query by-kind function --scope <feature-or-module-name>
scip-query trace <symbol>
scip-query hierarchy <symbol>
scip-query code <symbol>
```

## Language Rows

| Language | Use first | De-bloat set | Fallback note |
| --- | --- | --- | --- |
| TypeScript | `system`, `surface`, `call-graph`, `dataflow`, `change-surface` | `health`, `dead`, `similar`, `convergence`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `unused-imports`, `redundant-reexports` | Strongest verified surface. Vue script blocks use this path too. |
| Python | `outline`, `kind-counts --scope`, `system`, `imports`, `imported-by`, `call-graph` | `dead`, `unused-imports`, `drift`, `similar-signatures`, `complexity`, `complexity-hotspots` | Prefer source-backed fallbacks when call/kind metadata is sparse. |
| Java | `system`, `surface`, `call-graph`, `deps`, `rdeps`, `slice` | `health`, `dead`, `similar-files`, `similar-chains`, `wrapper-candidates`, `stale-abstractions`, `extract-candidates` | Use module/package surfaces to avoid class-only tunnel vision. |
| Scala | `surface`, `trace`, `call-graph`, `imports`, `imported-by` | `dead`, `similar-files`, `similar-chains`, `extract-candidates`, `stale-abstractions`, `unused-imports` | Confirm behavior with `code`. |
| Kotlin | `surface`, `trace`, `call-graph`, `imports`, `imported-by` | `dead`, `similar-files`, `similar-chains`, `extract-candidates`, `stale-abstractions`, `unused-imports` | Confirm behavior with `code`. |
| Rust | `trace`, `call-graph`, `refs`, `methods`, `surface` | `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-signatures`, `redundant-reexports` | Methods and surface are usually high signal. |
| Go | `surface`, `trace`, `call-graph`, `refs`, `fan-in` | `dead`, `wrapper-candidates`, `passthrough-candidates`, `similar-files`, `similar-signatures`, `complexity` | Use package-level surfaces and confirm exported APIs before cleanup. |
| C++ | `trace`, `refs`, `methods`, `surface`, `code` | `dead`, `wrapper-candidates`, `similar-files`, `similar-chains`, `extract-candidates`, `unused-imports` | Try `call-graph` after trace/refs/code. |
| C | `trace`, `call-graph`, `refs`, `outline`, `fan-out` | `dead`, `wrapper-candidates`, `similar-files`, `similar-chains`, `extract-candidates`, `unused-imports` | Skip class/member commands. |
| Ruby | `trace`, `call-graph`, `refs`, `imports`, `imported-by` | `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures` | Confirm dynamic-looking paths with source. |
| C# | `surface`, `call-graph`, `trace`, `methods`, `refs` | `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `extract-candidates` | Use surfaces and methods together. |
| Visual Basic | `surface`, `call-graph`, `trace`, `methods`, `refs` | `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `extract-candidates` | Use surfaces and methods together. |
| Dart | `surface`, `call-graph`, `trace`, `imports`, `imported-by` | `dead`, `wrapper-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures`, `redundant-reexports` | Confirm exported API shape with `surface`. |
| PHP | `trace`, `refs`, `methods`, `surface`, `code` | `dead`, `wrapper-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures`, `extract-candidates` | Try `call-graph` after trace/refs/code. |
| Clojure / ClojureScript | `files`, `outline`, `trace`, `refs`, `call-graph` | `dead`, `similar-files`, `similar-signatures`, `complexity`, `complexity-hotspots` | SCIP indexing comes from `scip-clojure`; no TypeScript-style semantic provider is available. |

## Minimal Workflows

Understand a feature:

```bash
scip-query files <feature>
scip-query outline <file>
scip-query kind-counts --scope <feature>
scip-query fan-out <file>
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
scip-query surface <module>
```

Find DRY and de-bloat wins:

```bash
scip-query health
scip-query dead
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query similar-chains
scip-query similar-signatures
scip-query extract-candidates
```

When recommending a command sequence, name the language and why these commands are highest-signal for it.
