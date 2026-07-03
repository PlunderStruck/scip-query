import type { CommandDescriptor } from './command-descriptor-types.js';
import { cleanupQueryCommandDescriptors } from '../query-commands/cleanup.js';
import { coreQueryCommandDescriptors } from '../query-commands/core.js';
import { graphQueryCommandDescriptors } from '../query-commands/graph.js';
import { healthQueryCommandDescriptors } from '../query-commands/health.js';
import { impactQueryCommandDescriptors } from '../query-commands/impact.js';
import { navigationQueryCommandDescriptors } from '../query-commands/navigation.js';
import { planningQueryCommandDescriptors } from '../query-commands/planning.js';
import { tlaQueryCommandDescriptors } from '../query-commands/tla.js';

const queryCommandOrder = [
  'stats',
  'files',
  'methods',
  'refs',
  'trace',
  'deps',
  'rdeps',
  'system',
  'surface',
  'dead',
  'hotspots',
  'imports',
  'imported-by',
  'unused-imports',
  'outline',
  'members',
  'fan-in',
  'fan-out',
  'coupling',
  'cycles',
  'bottlenecks',
  'isolated',
  'by-kind',
  'kind-counts',
  'deep-chains',
  'hierarchy',
  'call-graph',
  'similar',
  'similar-files',
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
  'similar-chains',
  'extract-candidates',
  'locality-candidates',
  'affected',
  'change-surface',
  'cleanup-plan',
  'cleanup-apply',
  'co-change',
  'recent-duplicates',
  'doc-drift',
  'unused-params',
  'diff-gate',
  'incomplete-migration',
  'tla',
  'plan-context',
  'drift',
  'wrapper-candidates',
  'passthrough-candidates',
  'stale-abstractions',
  'complexity-hotspots',
  'self-audit',
  'convergence',
  'code',
  'complexity',
  'dataflow',
  'slice',
  'redundant-reexports',
  'duplicate-bodies',
  'twin-drift',
  'twin-ab',
  'not-implemented',
  'decorative-checkers',
  'similar-signatures',
] as const;

const queryCommandFamilies = [
  coreQueryCommandDescriptors,
  navigationQueryCommandDescriptors,
  graphQueryCommandDescriptors,
  cleanupQueryCommandDescriptors,
  impactQueryCommandDescriptors,
  planningQueryCommandDescriptors,
  tlaQueryCommandDescriptors,
  healthQueryCommandDescriptors,
];

const familyDescriptors = queryCommandFamilies.flat();
const QUERY_COMMANDS_BY_ID = new Map(familyDescriptors.map((descriptor) => [descriptor.id, descriptor]));

for (const descriptor of familyDescriptors) {
  if (!queryCommandOrder.includes(descriptor.id as (typeof queryCommandOrder)[number])) {
    throw new Error(`Query command descriptor is not ordered: ${descriptor.id}`);
  }
}

export const orderedQueryCommandDescriptors: CommandDescriptor[] = queryCommandOrder.map((id) =>
  queryCommandDescriptor(id),
);

export function queryCommandDescriptor(id: string): CommandDescriptor {
  const descriptor = QUERY_COMMANDS_BY_ID.get(id);
  if (!descriptor) throw new Error(`Unknown query command descriptor: ${id}`);
  return descriptor;
}
