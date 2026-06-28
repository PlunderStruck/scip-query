---
name: scip-query-setup
description: Set up or refresh scip-query in a repository so agents can use compiler-resolved code intelligence effectively. Use when adopting scip-query in a repo, running the robust `scip-query setup` bootstrap, fixing stale setup, adding AGENTS.md guidance, checking capability coverage, generating the health dossier, configuring .scipquery.json, or calibrating locality architectural boundaries.
---

# scip-query Setup

Use this skill when a repository needs to become a reliable scip-query workspace, not merely a repo where the binary happens to run.

A scip-query workspace is a source repository with a current SCIP index, project config, and agent guidance that make code references compiler-resolved instead of guessed from text search. Its defining trait is that agents can answer "where is this defined, who uses it, and what changes with it?" from the index before editing.

A setup pass is the bounded workflow that installs or verifies the tool, creates the project index, writes agent instructions, and records repo-specific calibration. Its defining trait is that it turns one-off local success into a repeatable operating surface for future agents.

## Setup Workflow

1. Confirm the project root.

```bash
pwd
git rev-parse --show-toplevel
```

2. Verify the command is available.

```bash
scip-query --version
scip-query doctor
```

If the command is missing, install or link it using the repo's package manager, then rerun this step.

3. Ensure bundled skills are available and project-local lifecycle hooks are configured.

```bash
scip-query install-skills
scip-query setup-hooks --json
```

The setup command also installs skills and configures project-local hooks, but running `install-skills` directly is useful when refreshing a user-level Codex, Claude Code, or shared agents skill root. Use `setup-hooks` when the user wants to repair the current repository's reviewable `.codex/hooks.json` and `.claude/settings.json` files without rerunning the full setup pass.

4. Run the robust local setup pass.

```bash
scip-query setup --json
```

This pass installs bundled skills, configures project-local hooks, checks indexer readiness, attempts configured indexer remediation, refreshes or reuses the index, verifies capabilities, smoke-tests representative command families, writes `docs/scip-query/health-dossier.md` and `docs/scip-query/health-dossier.json`, and seeds agent guidance.

If setup reports `blocked`, run:

```bash
scip-query check-deps
scip-query capability-matrix --json
```

Fix the reported missing indexer, toolchain, language, or config problem before continuing. Do not call a missing capability "clean"; record it as unavailable or blocked.

5. Initialize minimal config only when the project needs one.

```bash
scip-query init
scip-query config-validate
```

Keep `.scipquery.json` minimal. Add settings only when they are justified by observed repo facts, reviewed false positives, declared coupling, or explicit suppressions.

For TypeScript monorepos with multiple discovered project shards, prefer persistent `indexer.typescript.projectMode: "workspace"`. Add `indexerConcurrency` only when the repo has enough CPU/memory or measured cold-index timing justifies a project-specific worker cap.

6. Inspect freshness and refresh only when setup repairs anything or the index is not fresh.

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query capabilities --json
scip-query stats
```

If an upstream indexer skipped source files that should still be searchable or visible to agents, run:

```bash
scip-query augment-sources
```

Project hooks auto-refresh stale indexes for agent sessions unless `.scipquery.json` sets `watch.autoRefresh: false`. Use `scip-query watch` only when a human explicitly wants a long-running live watcher in a terminal.

7. Confirm health signals before cleanup.

Invoke `scip-health-audit` after setup when the user wants cleanup, a post-setup follow-through, or a perfect-code pass. The agent must tell the user the health score and list confirmed items before changing application code.

```bash
scip-query health --json --full
scip-query diff-gate --json
```

8. Calibrate project config.

Open or create `.scipquery.json`. Keep config minimal and tied to observed repo facts.

```json
{
  "languages": ["typescript"],
  "locality": {
    "architecturalBoundarySegments": ["effect", "errors", "policies", "workflows"]
  }
}
```

An architectural boundary segment is a folder name that marks a code ownership boundary, such as `effect`, `errors`, `policies`, `routes`, `schemas`, or `workflows`. Its defining trait is that broad use of code inside that folder can mean the boundary is central and intentional, so `locality-candidates` should not invent a generic `shared` destination for it.

Before writing `locality.architecturalBoundarySegments`, classify boundary maturity:

- Mature boundary: folder names recur as intentional ownership units in code, tests, docs, route/workflow conventions, or agent standards. Add only the repo-specific segment names not already built in.
- Emerging boundary: folder names look meaningful, but ownership is inconsistent or only visible in one area. Do not configure yet; record candidates and rerun after a few reviewed locality results prove the boundary.
- No reliable boundary: the repo is mostly flat, mixed, generated, or ad hoc. Leave locality config absent or empty. Do not invent architecture; use `locality-candidates` as a discovery report and ask for human ownership decisions.

Treat boundary maturity as an evidence question. A segment needs at least two independent signals before it belongs in config: directory structure plus a project standard, repeated import convention, test organization, package boundary, route family, workflow family, or reviewed locality false positive. If the same folder name means different things in different parts of the repo, do not add it globally.

For an unstructured repo, setup runs in discovery mode. Discovery mode means the tool records candidate ownership clusters and uncertain folders, but does not write `locality.architecturalBoundarySegments`. The setup note should say which paths need a human architecture decision and should keep `locality-candidates` recommendations as suggestions to inspect, not moves to trust.

Use `locality.architecturalBoundarySegments` only when validation finds a repo-specific mature boundary that is not already in the built-in list. Add folder names, not paths.

9. Validate directory-organization signals when setup touches locality.

```bash
scip-query locality-candidates --json --full
```

Review rows with non-null `suggestedHome`. Keep exact destinations only when the path already exists, stays inside the source root, and matches the repo's ownership model. When a generic `shared` destination is wrong because the current folder is a real boundary, add that folder name to `.scipquery.json` and rerun.

Validate both suppression and emission. Suppression means a bad generic home was withheld because the source already lives in a real boundary. Emission means a useful `suggestedHome` is still shown for code that genuinely lacks a home. A config that suppresses every row is acceptable only when manual review confirms there were no useful destinations to emit.

If the repo has no mature boundaries, the correct setup result is a note, not a config guess: "locality boundaries not configured; repo needs architecture ownership decisions first." A slop codebase is a codebase whose files are arranged by accident, convenience, or recent edits rather than by stable ownership rules. Its defining trait is that directory names do not reliably predict where code should live, so the setup skill must not make `locality-candidates` appear more certain than the repo itself.

10. Finish with the standard gate.

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-gate --json
```

Fix findings or state the explicit acceptance reason.

Do not run `scip-query setup-ci` as part of this setup workflow. CI setup is intentionally deferred until that command has a mature validation path.

## Suppressions

Prefer fixing findings. Use suppressions only for intentional design, compatibility shims, framework entry points, or accepted false positives with a specific reason.

```bash
scip-query suppress <id> --reason "<specific reason>"
scip-query config-validate
```

A suppression is a durable acceptance record. It should explain why the code should remain as-is, not merely silence a noisy report.

## Handoff Notes

When setup changes are complete, record:

- repository path and revision;
- index command and result;
- capability matrix limitations;
- `.scipquery.json` changes and why each setting exists;
- validation commands and raw-output locations;
- final `diff-gate` result.

Do not add broad analyzer config in advance. Each setting should be justified by a reviewed false positive, false negative, capability gap, or repo convention.
