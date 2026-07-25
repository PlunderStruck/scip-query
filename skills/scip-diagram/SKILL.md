---
name: scip-diagram
description: Diagram code with scip-query evidence. Use for code flow diagrams, architecture diagrams, data-flow maps, dependency maps, blast-radius visuals, module maps, or HTML artifacts explaining a system.
commands:
  - template: 'scip-query system <module>'
    when: 'Collect evidence: module map for a dependency or architecture diagram.'
  - template: 'scip-query trace <symbol>'
    when: 'Collect evidence: definition plus references for a call-flow diagram.'
  - template: 'scip-query call-graph <symbol>'
    when: 'Collect evidence: callers/callees for a call-flow diagram.'
  - template: 'scip-query dataflow <symbol>'
    when: 'Collect evidence: producers/consumers for a data-flow diagram.'
  - template: 'scip-query affected <symbol> --json'
    when: 'Collect evidence: blast-radius nodes and edges.'
  - template: 'scip-query change-surface <file> --json --full'
    when: 'Collect evidence: exports and consumers for a change-surface map.'
---

# scip-diagram

Use this skill to build a visual explanation from compiler-resolved facts. A code diagram is an HTML artifact that turns source units, calls, dependencies, data flow, or blast radius into a visual map; every node and edge must trace to scip-query evidence.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query system <module>` | Full module map: files, symbols, deps in/out | module file paths; exported symbols with line ranges; internal dependencies; reverse dependencies | `complete` | Collect evidence: module map for a dependency or architecture diagram. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | definition sites with source and signature; referencing files with line numbers | `bounded` | Collect evidence: definition plus references for a call-flow diagram. |
| `scip-query call-graph <symbol>` | Show incoming callers and outgoing callees for a symbol | caller and callee symbol identities with files | `bounded` | Collect evidence: callers/callees for a call-flow diagram. |
| `scip-query dataflow <symbol>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | definition sites, usage sites, producer symbols, and consumer symbols | `bounded` | Collect evidence: producers/consumers for a data-flow diagram. |
| `scip-query affected <symbol> --json` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Collect evidence: blast-radius nodes and edges. |
| `scip-query change-surface <file> --json --full` | Pre-change briefing: exports, consumers, and blast-radius risk | defined symbols, external consumer counts, and risk levels | `bounded` | Collect evidence: exports and consumers for a change-surface map. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Run evidence before drawing.
2. Default to a self-contained HTML file.
3. Include command provenance in the artifact.
4. Scope large graphs into clusters instead of rendering a hairball.
5. Verify the HTML opens and the diagram is nonblank.

## Workflow

### 1. Pick diagram type

| User wants                 | Diagram                          |
| -------------------------- | -------------------------------- |
| Feature flow               | Call flow                        |
| Value origin or mutation   | Data flow                        |
| Dependents                 | Blast radius                     |
| Module architecture        | Dependency map                   |
| Hard-to-change explanation | Change surface or bottleneck map |
| Classes or ownership       | Hierarchy and surface map        |

This step is complete only when the diagram's node and edge types are chosen.

### 2. Collect evidence

Use only commands needed for the chosen diagram:

```bash
scip-query system <module>
scip-query surface <module>
scip-query outline <file>
scip-query trace <symbol>
scip-query code <symbol>
scip-query call-graph <symbol>
scip-query dataflow <symbol>
scip-query slice <symbol>
scip-query slice <symbol> --forward
scip-query deps <file>
scip-query rdeps <file>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
scip-query hierarchy <symbol> --json
scip-query fan-out <file> --json
```

This step is complete only when every planned node and edge has a source command.

### 3. Build the artifact

Write to:

```text
docs/scip-query/diagrams/YYYY-MM-DD-<scope>.html
```

Include title, scope, summary, visual diagram, legend, evidence table, omitted/collapsed nodes, and unavailable capabilities.

Use inline CSS and semantic HTML or inline SVG. Give stable dimensions, wrapping labels, accessible colors, and distinct edge styles for calls, data, dependencies, and risk.

This step is complete only when the HTML contains the visual and provenance table.

### 4. Verify

Open the file locally or use a browser/screenshot tool when available. Confirm:

- diagram is nonblank;
- labels do not overlap badly;
- major nodes and edges trace to evidence;
- `scip-verify` has been invoked when this is part of a docs/code change.

End with the file path and what the diagram proves.
