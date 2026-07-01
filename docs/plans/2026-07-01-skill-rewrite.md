# scip-query Skill Rewrite Plan

Date: 2026-07-01

## Goal

Rewrite the bundled scip-query skills so agents run a more predictable process: short model-facing descriptions, ordered steps with checkable completion criteria, shared reference pushed behind explicit pointers, and less repeated command catalog prose. Done means the shipped skills still cover the same workflows, the concrete-plan skill forces testable implementation design, packaged reference files are included in npm output, and the repository gates pass.

## Current State

- The TypeScript index is fresh after `scip-query reindex`.
  - Source: `scip-query status --capabilities`.
- Markdown skill files are not compiler-indexed symbols, so `scip-query plan-context skills/concrete-plan/SKILL.md` returned no match. Code-intelligence evidence applies to package/config changes, while skill text edits are verified as authored Markdown.
  - Source: `scip-query plan-context skills/concrete-plan/SKILL.md`.
- The broad package target `scip-query` resolves to TypeScript config surfaces, not the Markdown skills.
  - Source: `scip-query plan-context scip-query`.
- The npm package currently ships `skills/**/SKILL.md` and `skills/**/agents/*.yaml`, so new skill reference Markdown must be added to the package file list.
  - Source: `package.json` `files` field, inspected during planning.
- Current doc drift is clean and recent duplicate detection reports no findings.
  - Source: `scip-query doc-drift AGENTS.md`; `scip-query recent-duplicates --json --full`.

## Reuse Audit

No new TypeScript symbols are planned. The only new artifact type is shared Markdown reference for scip-query skill mechanics. Existing skills already duplicate freshness rules, lookup tips, post-change checks, and command catalogs, so the reuse target is a shared reference file rather than another copy in every skill.

## Design

### 1. Add shared skill reference

- [x] **File**: `skills/_shared/SKILL.md`
- **Source**: Markdown inventory from `find skills .agents/skills -maxdepth 2 -type f`; package behavior from `package.json`.
- **What**: Freshness checks, lookup tips, common postchecks, and evidence rules are repeated across many skills.
- **Change**: Create one user-invoked shared reference skill with the scip-query evidence contract, lookup mechanics, common command families, and post-change checks.
- **Why**: This applies progressive disclosure without losing shipped reference material.

### 2. Ship shared skill reference files

- [x] **File**: `package.json`, `src/runtime/setup.ts`, `docs/COMMAND_REFERENCE.md`
- **Source**: `package.json` `files` field.
- **What**: The package included `skills/**/SKILL.md` but not sibling reference Markdown, and the installer treats every direct child of `skills/` as an installable skill.
- **Change**: Include `skills/**/*.md`, make `_shared` a user-invoked reference skill, add it to `BUILTIN_SKILLS`, and regenerate `docs/COMMAND_REFERENCE.md`.
- **Why**: A context pointer is only valid if the target exists after install.

### 3. Rewrite bundled skill bodies

- [x] **File**: `skills/*/SKILL.md`
- **Source**: Markdown inventory from `find skills .agents/skills -maxdepth 2 -type f`; writing rules from `/Users/aydansalois/.codex/skills/writing-great-skills/SKILL.md`.
- **What**: Skill bodies carry repeated setup snippets, duplicated trigger prose, long command catalogs, and several vague finish criteria.
- **Change**: Tighten descriptions, keep the leading word for each workflow, rewrite bodies into steps/reference sections, and end each workflow with a checkable completion criterion.
- **Why**: Predictable skill execution comes from a clear information hierarchy and less sediment.

### 4. Update concrete-plan for testable design

- [x] **File**: `skills/concrete-plan/SKILL.md`
- **Source**: user request; existing concrete-plan skill body.
- **What**: Plans currently stress-test engineering risk but do not make testability the primary design shape.
- **Change**: Add a testability gate that plans dependency injection, pure functions, separation of concerns, and loose coupling before implementation steps. Require each behavior-changing step to name the test seam, injected dependency, pure core, side-effect boundary, and validation.
- **Why**: Code is easiest to test when the plan makes dependencies replaceable, logic deterministic, concerns bounded, and collaborators small.

### 5. Lightly align repo-local agent skills

- [x] **File**: `.agents/skills/*/SKILL.md`
- **Source**: Markdown inventory from `find skills .agents/skills -maxdepth 2 -type f`.
- **What**: Repo-local skills are not npm-bundled, but they share the same skill-writing failure modes.
- **Change**: Tighten descriptions and remove obvious duplicated process prose without changing their intended behavior.
- **Why**: Local skills should not drift from the writing standard applied to shipped skills.

## Verification

- [x] Check frontmatter parses for every edited `SKILL.md`.
- [x] Check every relative Markdown pointer resolves.
- [x] Run package checks for JSON validity and package file inclusion.
- [x] Run targeted installer, setup, and CLI contract tests.
- [x] Run `npm run typecheck`.
- [x] Run `scip-query reindex && scip-query diff-gate --json`.
- [x] Run `scip-query doc-drift --json --full` because docs and skill instructions changed.
