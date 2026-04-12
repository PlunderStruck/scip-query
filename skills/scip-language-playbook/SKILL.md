---
name: scip-language-playbook
description: Pick the highest-signal scip-query commands for the language in front of you so you can understand a system granularly and find DRY or de-bloat opportunities without wandering through low-signal queries first.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [language, playbook, commands, cheat-sheet, understand, granular, flow, dry, debloat, consolidate, similarity, ts, typescript, python, java, scala, kotlin, rust, cpp, c, ruby, csharp, vb, dart, php]
---

# Best scip-query Commands by Language

Use this skill when you want the shortest path from "what is this system doing?" to verified answers, or when you want the fastest way to spot duplication, indirection, and stale structure in a language-specific codebase.

This playbook is grounded in verified fixtures:
- TypeScript and Python are backed by the dedicated regression fixtures in `scip-query/tests`.
- Java, Scala, Kotlin, Rust, C++, C, Ruby, C#, Visual Basic, Dart, and PHP are backed by the cross-language fixture lab in `scip_repos`.

## Hard Rules

1. Start with the commands listed for the active language before reaching for broader or noisier commands.
2. For behavior claims, pair graph commands with source commands: `trace`, `call-graph`, and `refs` tell you the relationships; `code` confirms the actual implementation.
3. For de-bloat work, do not rely on a single command. Cross-check `dead`, `similar*`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `unused-imports`, and `drift`.
4. When a command is weaker in a language, the table below tells you the safer fallback.

## Universal First Pass

Run these in almost every codebase, regardless of language:

```bash
scip-query stats
scip-query files <feature-or-module-name>
scip-query symbols <file>
scip-query trace <symbol>
scip-query code <symbol>
```

Then switch to the language row below.

## Language Playbook

### TypeScript

Use first:
```bash
scip-query system <module>
scip-query surface <module>
scip-query call-graph <symbol>
scip-query dataflow <symbol>
scip-query change-surface <file>
```

Best de-bloat set:
```bash
scip-query health
scip-query dead
scip-query similar <symbol>
scip-query convergence <symbol1> <symbol2>
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query unused-imports <file>
scip-query redundant-reexports
```

Why this row is strong: TypeScript has the broadest verified command surface in the current suite, especially for imports, members, call flow, change risk, and DRY analysis.

### Python

Use first:
```bash
scip-query symbols <file>
scip-query outline <file>
scip-query system <module-or-file>
scip-query imports <file>
scip-query imported-by <symbol>
scip-query call-graph <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query unused-imports <file>
scip-query drift
scip-query similar-signatures
scip-query complexity <symbol>
scip-query complexity-hotspots
```

Fallback note: Python indexes can omit some kind and call metadata, so `symbols`, `outline`, `imports`, and `call-graph` are especially important because the tool already compensates for those gaps with source-backed fallbacks.

### Java

Use first:
```bash
scip-query system <module>
scip-query surface <module>
scip-query call-graph <symbol>
scip-query deps <file>
scip-query rdeps <file>
scip-query slice <symbol>
```

Best de-bloat set:
```bash
scip-query health
scip-query dead
scip-query similar-files
scip-query similar-chains
scip-query wrapper-candidates
scip-query stale-abstractions
scip-query extract-candidates
```

### Scala

Use first:
```bash
scip-query surface <module>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query imports <file>
scip-query imported-by <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query stale-abstractions
scip-query unused-imports <file>
```

### Kotlin

Use first:
```bash
scip-query surface <module>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query imports <file>
scip-query imported-by <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query stale-abstractions
scip-query unused-imports <file>
```

### Rust

Use first:
```bash
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query refs <symbol>
scip-query methods <type>
scip-query surface <module>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query similar-signatures
scip-query redundant-reexports
```

### C++

Use first:
```bash
scip-query trace <symbol>
scip-query refs <symbol>
scip-query methods <class>
scip-query surface <module>
scip-query code <symbol>
```

Then try:
```bash
scip-query call-graph <symbol>
```

Fallback note: `call-graph` is useful here, but `trace`, `refs`, and `code` are the safer first-line tools when you need to be absolutely precise.

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query unused-imports <file>
```

### C

Use first:
```bash
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query refs <symbol>
scip-query symbols <file>
scip-query outline <file>
```

Skip:
```bash
scip-query methods <class>
scip-query members <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query unused-imports <file>
```

### Ruby

Use first:
```bash
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query refs <symbol>
scip-query imports <file>
scip-query imported-by <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query similar-signatures
```

### C#

Use first:
```bash
scip-query surface <module>
scip-query call-graph <symbol>
scip-query trace <symbol>
scip-query methods <class>
scip-query refs <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query extract-candidates
```

### Visual Basic

Use first:
```bash
scip-query surface <module>
scip-query call-graph <symbol>
scip-query trace <symbol>
scip-query methods <class>
scip-query refs <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query extract-candidates
```

### Dart

Use first:
```bash
scip-query surface <module>
scip-query call-graph <symbol>
scip-query trace <symbol>
scip-query imports <file>
scip-query imported-by <symbol>
```

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query similar-signatures
scip-query redundant-reexports
```

### PHP

Use first:
```bash
scip-query trace <symbol>
scip-query refs <symbol>
scip-query methods <class>
scip-query surface <module>
scip-query code <symbol>
```

Then try:
```bash
scip-query call-graph <symbol>
```

Fallback note: as with C++, the graph is useful, but `trace`, `refs`, and `code` are the more reliable first pass when you need a crisp explanation.

Best de-bloat set:
```bash
scip-query dead
scip-query wrapper-candidates
scip-query stale-abstractions
scip-query similar-files
scip-query similar-signatures
scip-query extract-candidates
```

## Minimal Workflows

### Understand a feature quickly

```bash
scip-query files <feature>
scip-query symbols <file>
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
scip-query surface <module>
```

### Find DRY and de-bloat wins quickly

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

## Reporting Rule

When you recommend a command sequence, name the language and explain why those commands are the highest-signal ones for that language. If a command is only sweep-proven rather than strictly source-truth-graded, say so when the distinction matters.
