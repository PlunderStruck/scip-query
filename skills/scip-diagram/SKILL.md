---
name: scip-diagram
description: Create evidence-backed HTML diagrams of how code works using scip-query. Use when the user asks for a code flow diagram, architecture diagram, data-flow diagram, dependency map, blast-radius visualization, module map, or an HTML artifact that explains a system.
---

# SCIP Diagram

Use this skill to build a visual explanation from compiler-resolved code facts. A code diagram is an HTML artifact that turns source units, calls, dependencies, data flow, or blast radius into a visual map. Its defining trait is that every node and edge comes from scip-query evidence, not from guessed folder structure.

## Rules

1. Run scip-query evidence first, then draw. Do not invent nodes or arrows.
2. Make a self-contained HTML file unless the user asks for another format.
3. Include command provenance in the HTML so readers can see which scip-query commands produced the diagram.
4. Keep diagrams scoped. If the graph is huge, summarize clusters and link to detailed evidence rather than rendering a hairball.
5. Verify the HTML opens cleanly and contains the expected diagram content.

## Pick the Diagram Type

| User wants | Use |
|---|---|
| "How does this feature work?" | Call-flow diagram |
| "Where does this value come from?" | Data-flow diagram |
| "What depends on this?" | Blast-radius diagram |
| "What is this module's architecture?" | Module/dependency diagram |
| "Why is this hard to change?" | Change-surface or bottleneck diagram |
| "Show classes or ownership" | Hierarchy and surface diagram |

## Evidence Commands

Start with current graph facts:

```bash
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
```

Collect only the commands needed for the diagram:

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
scip-query bottlenecks
scip-query cycles
```

Use `scip-query kind-counts --scope <scope>` and `scip-query by-kind <kind> --scope <scope>` when the diagram needs an inventory of symbols.

## Build the HTML

Write the artifact under:

```text
docs/scip-query/diagrams/YYYY-MM-DD-<scope>.html
```

If the repo has a different reports convention, follow it. The file should include:

- title and scope;
- short textual summary;
- the visual diagram;
- legend for node colors, edge styles, and risk labels;
- evidence table listing every scip-query command used;
- notes for omitted nodes, collapsed clusters, or unavailable capabilities.

Implementation guidance:

- Use inline CSS and either semantic HTML layout or inline SVG.
- Use stable dimensions and labels that wrap cleanly.
- Use one visual encoding per meaning: call edges, data edges, dependency edges, and risk edges should look different.
- Keep colors accessible and avoid relying on color alone; include labels or edge styles.
- For large graphs, group by module, ownership, lifecycle phase, or public surface.

## Diagram Recipes

### Call Flow

```bash
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
```

Render entry point -> major callees -> side effects or terminal outputs. Label each edge with the call or branch reason when `code` proves it.

### Data Flow

```bash
scip-query dataflow <value-symbol>
scip-query slice <value-symbol>
scip-query slice <value-symbol> --forward
```

Render producers, transformations, validators, storage, and consumers. Mark inferred or unavailable parts explicitly.

### Dependency or Module Map

```bash
scip-query system <module>
scip-query deps <file>
scip-query rdeps <file>
scip-query surface <module>
```

Render internal files, imported modules, reverse consumers, and public surfaces. Distinguish internal dependencies from external consumers.

### Blast Radius

```bash
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
```

Render the changed symbol, direct consumers, transitive consumers, and high-risk surfaces. Show depth so the user can see how far the change travels.

## Verification

After writing the HTML:

1. Open it locally or use a browser/screenshot tool when available.
2. Confirm the diagram is nonblank and labels do not overlap badly.
3. Confirm every major node and edge is traceable to the evidence table.
4. Run `scip-query diff-gate --json` if the diagram is part of a code or docs change.

End by giving the file path and a short summary of what the diagram proves.
