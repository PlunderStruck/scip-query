import assert from 'node:assert/strict';
import fc from 'fast-check';
import { it } from 'vitest';
import { stronglyConnectedComponents } from '../../src/analysis/strongly-connected-components.js';
import { checkProperty, graphArbitrary, reachability, PROPERTY_TIMEOUT } from './support.js';
import { sourceSystemReport } from '../../src/queries/health/source-system.js';
import { sourceMaintenanceReport } from '../../src/queries/health/source-review.js';
import { withGitProject } from './fixture.js';

it(
  'graphs: components equal independently computed mutual reachability and preserve dependency order',
  async () => {
    await checkProperty(
      'graphs',
      'mutual-reachability-and-order',
      fc.property(graphArbitrary, ({ size, edges }) => {
        const graph = new Map(Array.from({ length: size }, (_, n) => [n, new Set<number>()]));
        for (const [from, to] of edges) graph.get(from)!.add(to);
        const paths = reachability(size, edges);
        const result = stronglyConnectedComponents(graph);
        assert.deepEqual(
          result.components.flat().sort((a, b) => a - b),
          [...graph.keys()],
        );
        assert.equal(result.componentOf.size, size);
        for (let a = 0; a < size; a += 1) {
          for (let b = 0; b < size; b += 1) {
            assert.equal(result.componentOf.get(a) === result.componentOf.get(b), paths[a]![b]! && paths[b]![a]!);
            if (paths[a]![b]) assert.ok(result.componentOf.get(a)! >= result.componentOf.get(b)!);
          }
        }
        // Removing empty adjacency keys must retain vertices still named as dependency targets.
        const sparse = new Map([...graph].filter(([, targets]) => targets.size > 0).reverse());
        const encountered = new Set([...sparse.keys(), ...[...sparse.values()].flatMap((targets) => [...targets])]);
        const sparseResult = stronglyConnectedComponents(sparse);
        assert.deepEqual([...sparseResult.componentOf.keys()].sort(), [...encountered].sort());
        for (const a of encountered)
          for (const b of encountered) {
            assert.equal(
              sparseResult.componentOf.get(a) === sparseResult.componentOf.get(b),
              paths[a]![b]! && paths[b]![a]!,
            );
          }
      }),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'graphs: generated modules retain resolved dependency direction, isolated owners and complete cycle membership',
  async () => {
    await checkProperty(
      'graphs',
      'source-module-dependencies',
      fc.property(graphArbitrary, ({ size, edges }) => {
        const unique = [...new Set(edges.filter(([from, to]) => from !== to).map(([from, to]) => `${from}:${to}`))].map(
          (edge) => edge.split(':').map(Number) as [number, number],
        );
        const files = Object.fromEntries(
          Array.from({ length: size }, (_, id) => {
            const imports = unique
              .filter(([from]) => from === id)
              .map(([, to]) => `import { value${to} } from '../m${to}/value';`);
            return [`src/m${id}/value.ts`, `${imports.join('\n')}\nexport const value${id} = ${id};`];
          }),
        );
        withGitProject(files, (root) => {
          const system = sourceSystemReport(root);
          assert.equal(system.coverage.status, 'accounted');
          assert.equal(system.totalModules, size);
          assert.deepEqual(system.modules.flatMap((group) => group.files).sort(), Object.keys(files).sort());
          const actual = system.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
          assert.deepEqual(actual, unique.map(([from, to]) => `directory:src/m${from}->directory:src/m${to}`).sort());
          const paths = reachability(size, unique);
          const cyclic = Array.from({ length: size }, (_, from) => from).filter((from) =>
            paths[from]!.some((reaches, to) => to !== from && reaches && paths[to]![from]),
          );
          const health = sourceMaintenanceReport(root);
          const reported = [
            ...new Set(
              health.findings
                .filter((finding) => finding.rule === 'dependency-cycle')
                .flatMap((finding) => finding.sites.map((site) => site.file)),
            ),
          ].sort();
          assert.deepEqual(reported, cyclic.map((id) => `src/m${id}/value.ts`).sort());
        });
      }),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
