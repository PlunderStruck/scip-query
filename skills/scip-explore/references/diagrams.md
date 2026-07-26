# Diagrams

Use this for code flow diagrams, architecture diagrams, data-flow maps, dependency maps, blast-radius visuals, module maps, or any HTML artifact that explains a system — built from `scip-query` evidence. A code diagram is an HTML artifact that turns source units, calls, dependencies, data flow, or blast radius into a visual map. Every node and edge must trace to `scip-query` evidence — gather it before drawing.

## Workflow

**1. Pick the diagram type.** Map the user's intent to a diagram type:

| Intent | Diagram type |
|---|---|
| Feature flow | Call flow |
| Value origin or mutation | Data flow |
| Who depends on this | Blast radius |
| Module architecture | Dependency map |
| Why this is hard to change | Change surface / bottleneck map |
| Classes or ownership | Hierarchy and surface map |

Done when: the diagram's node and edge types are chosen.

**2. Collect evidence.** Use only the commands the chosen diagram type needs, from:

- `system <module>` — module map (file paths, exported symbols with line ranges, internal/reverse deps) for a dependency or architecture diagram.
- `trace <symbol>` — definition sites plus all references, for a call-flow diagram.
- `call-graph <symbol>` — incoming callers and outgoing callees, for a call-flow diagram.
- `dataflow <symbol>` — definition sites, usage sites, producer symbols, consumer symbols, for a data-flow diagram.
- `affected <symbol> --json` — transitive closure of symbols that could break if this symbol changes, for blast-radius nodes and edges.
- `change-surface <file> --json --full` — exports, external consumer counts, and risk levels, for a change-surface map.
- Also available as needed: `surface`, `outline`, `code`, `slice`, `slice --forward`, `deps`, `rdeps`, `hierarchy --json`, `fan-out --json`.

Done when: every planned node and edge has a source command behind it.

**3. Build the artifact.** Write it to `docs/scip-query/diagrams/YYYY-MM-DD-<scope>.html`. It must include: title, scope, summary, the visual diagram, a legend, an evidence table (which command produced which nodes/edges — command provenance lives inside the artifact, not just in your chat reply), omitted/collapsed nodes, and unavailable capabilities. Use inline CSS and semantic HTML or inline SVG: stable dimensions, wrapping labels, accessible colors, and distinct edge styles for calls, data, dependencies, and risk. Scope large graphs into clusters instead of rendering a hairball.

Done when: the HTML contains both the visual diagram and the provenance/evidence table.

**4. Verify.** Open the diagram file locally, or use a browser/screenshot tool when available. Confirm: the diagram is nonblank, labels don't overlap badly, and major nodes/edges trace to evidence. If the diagram is part of a docs/code change, invoke `scip-verify`.

End the deliverable with the file path and a statement of what the diagram proves.

Load shared mechanics from `../_shared/SKILL.md` — use this skill's own command shortlist first and open `_shared` only when it's insufficient.
