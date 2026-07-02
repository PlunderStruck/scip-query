---
name: scip-probe-reachability
description: Prove whether a parser/AST branch is actually reachable by running the real parser on minimal inputs. Use for unreachable or dead node-type/shape branches, wrong node-type strings, tree-sitter grammar mismatches, or any conditional written for an AST or parser output that has never been checked against the real parser.
commands:
  - template: "scip-query outline <file> --signatures"
    when: "Enumerate branches: symbol tree with signatures for the target file."
  - template: "scip-query code <symbol>"
    when: "Enumerate branches: read each branch condition's exact node-type check."
  - template: "scip-query trace <symbol>"
    when: "Enumerate branches: confirm the function's only caller/entry point."
---

# scip-probe-reachability

Use this skill for code that branches on a parser or AST node's type or shape (`node.type === '...'`, a grammar-specific tag, a regex over token shape) where nobody has verified the real parser ever produces that type or shape. A branch written from documentation, memory, or a similar grammar in another language can be permanently dead: it looks correct, compiles, and is never exercised by a single test, because the input that should reach it never reaches it under the actual parser.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query outline <file> --signatures` | Tree view of symbols in a file, with line ranges | Enumerate branches: symbol tree with signatures for the target file. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | Enumerate branches: read each branch condition's exact node-type check. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | Enumerate branches: confirm the function's only caller/entry point. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Never trust a branch condition by reading it; run the real parser on an input constructed to hit it.
2. Write scratch probe scripts only under the session scratchpad, never inside the repository — they are throwaway evidence, not product code.
3. Never create a git worktree and never symlink `node_modules` for this skill's probes; import the parser module directly (from `src/` via a TypeScript runner, or from the built package) in a standalone script that needs no repo-root install step.
4. A branch is a finding whether it is truly unreachable (dead code) or reachable but under a different node-type string than the code checks (a silent misclassification, which is worse than dead code because it fails without raising anything).
5. Completion requires every node-type/shape branch in the target function to have either a reached probe or a filed finding — partial coverage is not done.

## Workflow

### 1. Enumerate branch conditions

```bash
scip-query outline <target-file> --signatures
scip-query code <target-function>
```

List every conditional that tests a node's `type`, tag name, or shape (an `if`/`else if` chain over `node.type === '...'`, a `switch` on a grammar tag, or a regex matched against node text standing in for a type check). Record the exact string or pattern each branch expects.

This step is complete only when every node-type/shape branch in the target function is listed with its file:line and the exact condition text.

### 2. Construct a minimal input per branch

For each branch, write the smallest source snippet in the target language that should, by the language's grammar, produce a node of that type or shape at that point in the tree. Prefer one snippet per branch; note when a single snippet is expected to exercise more than one branch (siblings in a walk).

This step is complete only when every branch has a candidate input snippet.

### 3. Run the real parser

Write one scratch script under the session scratchpad (never in the repo) that imports the actual parser module used by the target code — not a reimplementation, not a mental model of the grammar — and, for each candidate snippet:

1. Parses it.
2. Walks the resulting tree and collects every node type actually produced.
3. Reports whether the branch's expected type/shape appears anywhere in that set.

Run the script (for example `npx vite-node <scratch-script>` from the repo root, or a plain `node` script importing the built package) and record reached/unreached per branch.

This step is complete only when every branch from step 1 has a recorded reached/unreached result from an actual parser run, not an inference.

### 4. File findings for unreached branches

For each unreached branch, determine and record which of these it is:

- **Dead branch**: the grammar never produces this node type/shape anywhere reachable from valid source in this language; the branch is unreachable code. Fix: delete it, or replace it with the branch that actually covers the intended case (found by inspecting the node types the parser did produce for the candidate input).
- **Wrong node-type string**: the intended case is real and common, but the branch checks the wrong string (a rename in the grammar, a typo, or a mismatch borrowed from a different language/version). Fix: correct the string to what step 3 actually observed.

This step is complete only when every unreached branch has one of these two labels and a fix direction.

### 5. Report

```markdown
Target: <file:function>

Branches:
| Branch condition | Candidate input | Reached? | Finding |
| --- | --- | --- | --- |

Findings:
- <branch> — dead branch / wrong node-type string — fix: <direction>
```

Completion requires every branch from step 1 to appear in the table with a reached/unreached result.
