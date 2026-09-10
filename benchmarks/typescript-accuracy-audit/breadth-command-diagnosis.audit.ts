import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deserializeSCIP } from '@c4312/scip';
import { it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { resolveSymbol } from '../../src/symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../../src/symbols/graph/call-graph-evidence.js';
import { scipOccurrenceCallTargetsForRange } from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { symbolSemanticEvidence } from '../../src/semantic/symbol-evidence.js';

it.skipIf(process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'breadth')(
  'locates the constructor omission between raw SCIP and public call graph',
  () => {
    const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-breadth-audit/isolated');
    const root = readFileSync(
      resolve(process.env['SCIP_QUERY_BREADTH_COMMAND_ROOT'] ?? '/tmp/scip-query-breadth-audit/command-root.txt'),
      'utf8',
    ).trim();
    const db = new ScipDatabase({
      projectRoot: root,
      dbPath: join(root, '.cache/index.db'),
      indexPath: join(root, '.cache/index.scip'),
    });
    try {
      const target = resolveSymbol(db, 'runJob').match!;
      if (!target) throw new Error('Missing diagnosis root');
      const opts = { additive: true, semantic: true, semanticEvidence: symbolSemanticEvidence };
      const unfiltered = getCalleeRowsForSymbol(db, target, opts);
      const filtered = getCalleeRowsForSymbol(db, target, { ...opts, callableOnly: true });
      const exact = scipOccurrenceCallTargetsForRange(db, 'src/service/runner.ts', 0, 20);
      const raw = deserializeSCIP(readFileSync(join(root, '.cache/index.scip')));
      const references = raw.documents
        .find((d) => d.relativePath === 'src/service/runner.ts')!
        .occurrences.filter((o) => o.symbol.includes('/Store#'))
        .map(({ symbol, range, symbolRoles }) => ({ symbol, range, symbolRoles }));
      writeFileSync(
        join(output, 'call-graph-diagnosis.json'),
        JSON.stringify({ unfiltered, filtered, exact, references }, null, 2) + '\n',
      );
      console.log(
        JSON.stringify({
          unfiltered: unfiltered.map((r) => ({ symbol: r.symbol, source: r.source })),
          filtered: filtered.map((r) => r.symbol),
          rawStoreReferences: references.length,
        }),
      );
    } finally {
      db.close();
    }
  },
);
