# Accuracy Calibration

Date: 2026-06-05

This report records real-repository command outputs for manual precision checks.
Treat every finding as untrusted until sampled against source evidence.

## scip-query

Path: `/Users/aydansalois/Documents/GitHub/scip-query`

### reindex
status: 0

```text
Detected languages: typescript
Indexing typescript with scip-typescript...
Converting to SQLite...
Augmented SQLite documents with 0 auxiliary source files (0 already present).
Done in 1.6s
Indexed typescript in 1.6s
```

### health
status: 0

```text

  Codebase Health Score: 100/100

  100 files | 4212 symbols | 2.8 MB

  Findings:
    Complexity hotspots:  10

  Top Complexity Hotspots:
       3.8  src:queries:dead:dead()
       2.7  src:queries:wrapper-candidates:wrapperCandidates()
       2.6  src:queries:slice:slice()
       2.5  src:queries:isolated:isolated()
       2.3  src:queries:stale-abstractions:staleAbstractions()

  No issues found. Codebase is clean.
```

### dead --min-loc 5 --skip-barrels
status: 0

```text
═══ FILE-INTERNAL ONLY (271, 6690 LOC) ═══
  Used only within the same file (no cross-file callers). Could be a
  single-use helper, an abstraction-in-progress, or a callback registered
  through a framework path that static analysis cannot trace (signal
  handlers, event listeners, dependency injection). NOT necessarily dead —
  review case by case.

  src/reindex/augment-vue.ts
    259-271  (13 LOC)  src:reindex:augment-vue:readAugmentVueCache()
    273-283  (11 LOC)  src:reindex:augment-vue:writeAugmentVueCache()
    285-307  (23 LOC)  src:reindex:augment-vue:computeAugmentVueFingerprint()
    335-424  (90 LOC)  src:reindex:augment-vue:computeVueResolvedReferencesForFiles()
    426-441  (16 LOC)  src:reindex:augment-vue:addVueOccurrence()
    443-449  (7 LOC)  src:reindex:augment-vue:countTokenTexts()
    451-471  (21 LOC)  src:reindex:augment-vue:sameSymbolSourceStarts()
    473-490  (18 LOC)  src:reindex:augment-vue:sourceStartForHighlight()
    496-550  (55 LOC)  src:reindex:augment-vue:awaitVueReferenceWorkers()
    552-558  (7 LOC)  src:reindex:augment-vue:resolveVueWorkerCount()
    565-583  (19 LOC)  src:reindex:augment-vue:createVueReferenceTasks()
    589-606  (18 LOC)  src:reindex:augment-vue:partitionTasks()
    608-613  (6 LOC)  src:reindex:augment-vue:taskWeight()
    615-621  (7 LOC)  src:reindex:augment-vue:fileWeight()
    623-644  (22 LOC)  src:reindex:augment-vue:clearVueDocumentChunks()
    646-654  (9 LOC)  src:reindex:augment-vue:listVueDocumentFiles()
    656-753  (98 LOC)  src:reindex:augment-vue:createVueLanguageContext()
    755-773  (19 LOC)  src:reindex:augment-vue:createSymbolLookup()
    775-809  (35 LOC)  src:reindex:augment-vue:loadDefinitionRanges()
    811-838  (28 LOC)  src:reindex:augment-vue:findNearestStart()
    840-873  (34 LOC)  src:reindex:augment-vue:createVueSymbolLookup()
    875-888  (14 LOC)  src:reindex:augment-vue:replaceVueDocumentChunks()
    890-915  (26 LOC)  src:reindex:augment-vue:insertVueDefinitionMentions()
    917-938  (22 LOC)  src:reindex:augment-vue:createVueSymbolIdLookup()
    940-964  (25 LOC)  src:reindex:augment-vue:resolveDefinitionSymbolId()
    966-976  (11 LOC)  src:reindex:augment-vue:dedupeOccurrences()
    978-986  (9 LOC)  src:reindex:augment-vue:occurrenceKey()
    988-1017  (30 LOC)  src:reindex:augment-vue:insertOccurrencesWithoutTransaction()
    1020-1034  (15 LOC)  src:reindex:augment-vue:identifierTokens()
    1036-1041  (6 LOC)  src:reindex:augment-vue:firstGeneratedOffset()
    1043-1054  (12 LOC)  src:reindex:augment-vue:firstSourceOffset()
    1056-1070  (15 LOC)  src:reindex:augment-vue:offsetToLineChar()
    1081-1102  (22 LOC)  src:reindex:augment-vue:languageIdForPath()
    1104-1120  (17 LOC)  src:reindex:augment-vue:createSourceTextCache()
    1122-1130  (9 LOC)  src:reindex:augment-vue:createLineStarts()
    1132-1145  (14 LOC)  src:reindex:augment-vue:selectDocumentIds()
    1147-1157  (11 LOC)  src:reindex:augment-vue:readPackageInfo()

  src/analysis/framework-patterns.ts
    62-160  (99 LOC)  src:analysis:framework-patterns:getJsTestExclusions()
    172-213  (42 LOC)  src:analysis:framework-patterns:collectSuppressionExclusions()
    215-447  (233 LOC)  src:analysis:framework-patterns:getRustExclusions()
    453-468  (16 LOC)  src:analysis:framework-patterns:isGeneratedFileHeader()
    516-541  (26 LOC)  src:analysis:framework-patterns:collectAttrHelperNames()
    548-561  (14 LOC)  src:analysis:framework-patterns:collectSerdeWithModNames()

  src/language-parsers/javascript.ts
    44-146  (103 LOC)  src:language-parsers:javascript:parseJavaScriptImportsAst()
    148-153  (6 LOC)  src:language-parsers:javascript:jsImportSpecifier()
    159-171  (13 LOC)  src:language-parsers:javascript:collectMemberAccesses()
    173-214  (42 LOC)  src:language-parsers:javascript:parseJavaScriptImportStatements()
    216-264  (49 LOC)  src:language-parsers:javascript:parseJavaScriptImportStatement()
    266-288  (23 LOC)  src:language-parsers:javascript:parseImportClause()
    290-328  (39 LOC)  src:language-parsers:javascript:parseImportBinding()
    330-342  (13 LOC)  src:language-parsers:javascript:splitImportClause()
    418-429  (12 LOC)  src:language-parsers:javascript:parseReExportBinding()
    431-437  (7 LOC)  src:language-parsers:javascript:lineOf()
    439-457  (19 LOC)  src:language-parsers:javascript:getReExportsAst()
    459-469  (11 LOC)  src:language-parsers:javascript:resolveExportSpecifierSource()
    471-496  (26 LOC)  src:language-parsers:javascript:parseReExportClause()
    512-535  (24 LOC)  src:language-parsers:javascript:collectVueNonScriptIdentifiers()

  src/symbols/reference-graph.ts
    163-195  (33 LOC)  src:symbols:reference-graph:buildCallerRowsMap()
    229-279  (51 LOC)  src:symbols:reference-graph:resolvedCandidateLines()
    286-293  (8 LOC)  src:symbols:reference-graph:resolveReferencePrelude()
    295-312  (18 LOC)  src:symbols:reference-graph:buildReferenceSites()
    387-448  (62 LOC)  src:symbols:reference-graph:buildAstCalleeMap()
    489-610  (122 LOC)  src:symbols:reference-graph:buildChunkCalleeMap()

  src/symbols/symbol-lookup.ts
    51-81  (31 LOC)  src:symbols:symbol-lookup:findBestFuzzySymbolMatch()
    83-95  (13 LOC)  src:symbols:symbol-lookup:findFileLineSymbolMatch()
    97-115  (19 LOC)  src:symbols:symbol-lookup:findDefinitionRangeRow()
    117-138  (22 LOC)  src:symbols:symbol-lookup:findDefinitionChunkRow()
    201-238  (38 LOC)  src:symbols:symbol-lookup:getDefinitionRowsForSymbolId()
    240-286  (47 LOC)  src:symbols:symbol-lookup:getSymbolLookupCandidates()
    288-351  (64 LOC)  src:symbols:symbol-lookup:scoreSymbolCandidate()
    357-365  (9 LOC)  src:symbols:symbol-lookup:lookupTokens()
    367-395  (29 LOC)  src:symbols:symbol-lookup:findDirectSymbolCandidate()

  src/language-parsers/python.ts
    28-92  (65 LOC)  src:language-parsers:python:parsePythonImportsAst()
    94-110  (17 LOC)  src:language-parsers:python:parsePythonImportItem()
    112-124  (13 LOC)  src:language-parsers:python:pythonModuleSpec()
    126-180  (55 LOC)  src:language-parsers:python:collectPythonImportStatements()
    182-214  (33 LOC)  src:language-parsers:python:parsePythonStatementHeader()
    216-286  (71 LOC)  src:language-parsers:python:parsePythonImportStatement()
    288-295  (8 LOC)  src:language-parsers:python:pythonParenBalance()

  src/queries/stale-abstractions.ts
    150-157  (8 LOC)  src:queries:stale-abstractions:getFilesWithFunctions()
    162-170  (9 LOC)  src:queries:stale-abstractions:isNestedTypeMember()
    178-189  (12 LOC)  src:queries:stale-abstractions:isTypeOnlyFile()
    191-207  (17 LOC)  src:queries:stale-abstractions:isTrueStaleAbstraction()
    215-238  (24 LOC)  src:queries:stale-abstractions:partitionConsumers()
    252-277  (26 LOC)  src:queries:stale-abstractions:isTransitivelyConsumed()
    289-301  (13 LOC)  src:queries:stale-abstractions:isImportOnlyConsumer()
    303-330  (28 LOC)  src:queries:stale-abstractions:computeFileLeafUsage()
    344-372  (29 LOC)  src:queries:stale-abstractions:isReExportOnlyConsumer()
    379-400  (22 LOC)  src:queries:stale-abstractions:detectDefinitionKind()
    413-433  (21 LOC)  src:queries:stale-abstractions:detectDefinerUsesType()
    435-462  (28 LOC)  src:queries:stale-abstractions:scoreConfidence()
    464-468  (5 LOC)  src:queries:stale-abstractions:definitionLoc()
    470-485  (16 LOC)  src:queries:stale-abstractions:mergeConsumerMaps()

  src/symbols/definition-catalog.ts
    244-320  (77 LOC)  src:symbols:definition-catalog:correctDefinitionRangesFromSource()
    328-357  (30 LOC)  src:symbols:definition-catalog:correctDefinitionRangesFromAst()
    359-384  (26 LOC)  src:symbols:definition-catalog:resolveCallableDefinitionStartLine()
    397-430  (34 LOC)  src:symbols:definition-catalog:buildDeclarationCandidatesMap()
    432-470  (39 LOC)  src:symbols:definition-catalog:resolveCallableDefinitionEndLine()
    472-517  (46 LOC)  src:symbols:definition-catalog:maskStructuralLine()

  src/queries/similar.ts
    41-64  (24 LOC)  src:queries:similar:compareAgainstFingerprints()
    73-102  (30 LOC)  src:queries:similar:comparePair()
    196-213  (18 LOC)  src:queries:similar:findCallees()
    215-233  (19 LOC)  src:queries:similar:getAllCalleeFingerprints()
    235-274  (40 LOC)  src:queries:similar:similarBySourceShape()
    276-287  (12 LOC)  src:queries:similar:findSourceFingerprint()
    289-297  (9 LOC)  src:queries:similar:buildSourceFingerprintTokens()
    299-314  (16 LOC)  src:queries:similar:getAllSourceFingerprints()
    316-357  (42 LOC)  src:queries:similar:definitionSnippet()
    359-389  (31 LOC)  src:queries:similar:sourceTokens()
    391-399  (9 LOC)  src:queries:similar:splitIdentifier()

  src/language-parsers/rust.ts
    39-66  (28 LOC)  src:language-parsers:rust:parseRustImportsAst()
    68-128  (61 LOC)  src:language-parsers:rust:flattenRustUseTree()
    130-134  (5 LOC)  src:language-parsers:rust:joinRustPath()
    136-180  (45 LOC)  src:language-parsers:rust:parseRustUseClause()
    203-227  (25 LOC)  src:language-parsers:rust:parseRustExportsAst()
    229-234  (6 LOC)  src:language-parsers:rust:hasPubVisibility()
    236-255  (20 LOC)  src:language-parsers:rust:parseRustExportClause()
    257-267  (11 LOC)  src:language-parsers:rust:buildRustExport()

  src/source/ast.ts
    62-72  (11 LOC)  src:source:ast:getParserCtor()
    114-148  (35 LOC)  src:source:ast:loadGrammar()
    151-167  (17 LOC)  src:source:ast:getParser()
    219-236  (18 LOC)  src:source:ast:getVueScriptAst()
    238-243  (6 LOC)  src:source:ast:parseSource()
    257-286  (30 LOC)  src:source:ast:extractVueScriptBlock()
    288-294  (7 LOC)  src:source:ast:countNewlinesBefore()
    298-319  (22 LOC)  src:source:ast:compileQuery()
    558-580  (23 LOC)  src:source:ast:runCachedAstQuery()
    618-644  (27 LOC)  src:source:ast:buildSignatureIndex()

  src/queries/health.ts
    89-103  (15 LOC)  src:queries:health:runHealthAnalyses()
    105-126  (22 LOC)  src:queries:health:filterHealthSignals()
    128-247  (120 LOC)  src:queries:health:buildHealthActions()
    249-281  (33 LOC)  src:queries:health:computeHealthScore()

  src/queries/similar-signatures.ts
    84-98  (15 LOC)  src:queries:similar-signatures:resolveNormalizedSignature()
    100-109  (10 LOC)  src:queries:similar-signatures:extractDocumentedSignature()
    111-141  (31 LOC)  src:queries:similar-signatures:extractDeclarationHead()
    143-150  (8 LOC)  src:queries:similar-signatures:looksCompleteDeclaration()
    160-191  (32 LOC)  src:queries:similar-signatures:normalizeSignature()
    193-233  (41 LOC)  src:queries:similar-signatures:normalizeSourceSignature()
    235-266  (32 LOC)  src:queries:similar-signatures:declarationStartLines()
    268-275  (8 LOC)  src:queries:similar-signatures:parenBalance()

  src/runtime/watch.ts
    112-153  (42 LOC)  src:runtime:watch:Watcher:handleFileChange()
    155-213  (59 LOC)  src:runtime:watch:Watcher:triggerReindex()
    219-263  (45 LOC)  src:runtime:watch:Watcher:runReindex()

  src/queries/similar-chains.ts
    181-195  (15 LOC)  src:queries:similar-chains:generateChains()
    197-234  (38 LOC)  src:queries:similar-chains:dfsChains()
    244-285  (42 LOC)  src:queries:similar-chains:editDistance()
    289-296  (8 LOC)  src:queries:similar-chains:getCommonPrefix()
    298-307  (10 LOC)  src:queries:similar-chains:getCommonSuffix()
    309-314  (6 LOC)  src:queries:similar-chains:isSubChain()

  src/queries/drift.ts
    166-224  (59 LOC)  src:queries:drift:buildSymbolRefGraph()
    231-260  (30 LOC)  src:queries:drift:inferLayerRules()
    272-281  (10 LOC)  src:queries:drift:isSideEffectImport()
    283-294  (12 LOC)  src:queries:drift:shouldSkipDriftFile()
    296-302  (7 LOC)  src:queries:drift:isStructuralRole()

  src/reindex/detect.ts
    94-100  (7 LOC)  src:reindex:detect:safeReadDir()
    102-108  (7 LOC)  src:reindex:detect:hasMarkerFile()
    110-116  (7 LOC)  src:rein

[truncated 9314 chars]
```

### stale-abstractions --min-loc 3
status: 0

```text
No stale abstractions found.
```

### wrapper-candidates --max-loc 15
status: 0

```text
No wrapper candidates found.
```

### passthrough-candidates --max-loc 15
status: 0

```text
No passthrough candidates found.
```

### extract-candidates --min-loc 15 --min-callees 5
status: 0

```text
No extraction candidates found.
```

### drift
status: 0

```text
No drift detected.
```

### redundant-reexports
status: 0

```text
No redundant re-exports found.
```
