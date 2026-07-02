# Regex Policy

Regular expressions are pattern matchers over text. In this codebase, they are appropriate when the input is a flat machine-generated string whose structure is fully represented by local characters, and inappropriate when an available parser can expose the structure that gives the text its meaning.

Use parsers for structured inputs when the parser is available:

- Source code: use tree-sitter, ts-morph, Vue compiler APIs, or language-specific source readers before scanning syntax with regex.
- TLA modules: use SANY-derived facts when the tools are available; regex model parsing is a disclosed fallback only.
- Checker diagnostics: use each checker's structured output or documented diagnostic shape before falling back to generic line matching.
- Markdown citations: use the existing citation context and citation-kind classifiers rather than broad path regexes alone.

Regex remains the right tool for flat machine-generated strings:

- SCIP symbol encodings in `src/symbols/symbol-parser.ts`.
- SCIP row and descriptor filters in storage/query SQL when the pattern is static.
- Path fragments and glob prefilters, followed by segment-aware matching when slash semantics matter.
- Signature normalization in `src/queries/cleanup/similar-signatures.ts`.
- Import path and source-text stripping helpers where the input is already a known lexical fragment.
- Framework and file classifiers that match names, extensions, and conventional path segments.

Retired or downgraded load-bearing regexes in the round-2 remediation:

- Complexity branch counting now uses AST nodes when parsing succeeds; source regex counting is labeled `regex-fallback`.
- `complexity-hotspots` uses the same branch estimate and no longer relies on size and fan metrics alone.
- Scope filters in SQL queries now bind parameters instead of interpolating user text into `LIKE`.
- `files` keeps SQL `LIKE` only as a prefilter and applies segment-aware glob matching in code.
- Drift policy no longer turns an unlisted `src/*` layer into an explicit layer violation.
- Cycles output discloses when DFS depth truncates the search.

Future work already identified:

- Health's fix-commit signal intentionally remains a subject-keyword regex until conventional-commit or issue-link evidence replaces it; output must disclose that basis.
- Checker diagnostic extraction should prefer structured per-oracle parsers and label heuristic fallback.
- TLA conformance should prefer SANY XML facts and label text parsing as `regex-fallback`.
