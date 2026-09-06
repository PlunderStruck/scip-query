import path from 'node:path';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';
import type { MaintenanceBindingFacts, MaintenanceFunctionBindings } from '../../source/ast/maintenance-bindings.js';
import type { SourceImport } from '../../source/ast/maintenance-imports.js';
import { architectureBoundaryForFile } from '../internal/architecture-policy.js';
import { productionImports } from './source-dependencies.js';
import { compareFindings, isDependencyComponent, type SourceFinding } from './source-finding-contract.js';

export interface SourceModuleSubject {
  id: string;
  basis: 'declared-boundary' | 'directory';
  files: string[];
  consumers: string[];
  dependencies: string[];
  findingIds: string[];
  primaryFindingIds: string[];
  highestPriority: SourceFinding['rule'];
  interpretation: string;
}

export type SourceModuleInventory = Omit<SourceModuleSubject, 'highestPriority'> & {
  highestPriority?: SourceFinding['rule'];
};

/** Preserve the health/review contract: subjects always carry at least one finding. */
export function sourceModuleSubjects(
  files: readonly string[],
  imports: readonly SourceImport[],
  findings: readonly SourceFinding[],
  config?: ArchitectureConfig,
): SourceModuleSubject[] {
  return sourceModuleInventory(files, imports, findings, config).filter(
    (group): group is SourceModuleSubject => group.highestPriority !== undefined,
  );
}

/** Inventory every captured group; location alone does not establish a business responsibility. */
export function sourceModuleInventory(
  files: readonly string[],
  imports: readonly SourceImport[],
  findings: readonly SourceFinding[],
  config?: ArchitectureConfig,
): SourceModuleInventory[] {
  const { groups, owners } = moduleOwnership(files, config);
  const { outgoing, incoming } = moduleRelationships(imports, owners, config);
  const sorted = [...findings]
    .filter((finding) => finding.status !== 'resolved' && !isDependencyComponent(finding))
    .sort(compareFindings);
  const rank = new Map(sorted.map((finding, index) => [finding.id, index]));
  assignModuleFindings(sorted, groups, owners);
  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: group.files.sort(),
      consumers: [...(incoming.get(group.id) ?? [])].sort(),
      dependencies: [...(outgoing.get(group.id) ?? [])].sort(),
    }))
    .sort(
      (a, b) =>
        (rank.get(a.primaryFindingIds[0]!) ?? Infinity) - (rank.get(b.primaryFindingIds[0]!) ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}

function moduleOwnership(files: readonly string[], config?: ArchitectureConfig) {
  const groups = new Map<string, SourceModuleInventory>();
  const owners = new Map<string, string>();
  for (const file of files) {
    const boundary = architectureBoundaryForFile(config, file);
    const id = boundary ? `boundary:${boundary}` : `directory:${path.posix.dirname(file)}`;
    owners.set(file, id);
    if (!groups.has(id))
      groups.set(id, {
        id,
        basis: boundary ? 'declared-boundary' : 'directory',
        files: [],
        consumers: [],
        dependencies: [],
        findingIds: [],
        primaryFindingIds: [],
        interpretation:
          'Grouping identifies declared membership or a shared directory. Review the observed contracts before changing ownership.',
      });
    groups.get(id)!.files.push(file);
  }
  return { groups, owners };
}

function moduleRelationships(
  imports: readonly SourceImport[],
  owners: ReadonlyMap<string, string>,
  config?: ArchitectureConfig,
) {
  const outgoing = new Map<string, Set<string>>(),
    incoming = new Map<string, Set<string>>();
  for (const edge of productionImports(imports, config)) {
    if (edge.resolution !== 'internal' || !edge.target) continue;
    const from = owners.get(edge.file),
      to = owners.get(edge.target);
    if (!from || !to || from === to) continue;
    const targets = outgoing.get(from) ?? new Set<string>();
    targets.add(edge.target);
    outgoing.set(from, targets);
    const sources = incoming.get(to) ?? new Set<string>();
    sources.add(edge.file);
    incoming.set(to, sources);
  }
  return { outgoing, incoming };
}

function assignModuleFindings(
  sorted: readonly SourceFinding[],
  groups: Map<string, SourceModuleInventory>,
  owners: ReadonlyMap<string, string>,
): void {
  for (const finding of sorted) {
    const primary = finding.sites.map((site) => owners.get(site.file)).find((id) => id !== undefined);
    if (primary) groups.get(primary)!.primaryFindingIds.push(finding.id);
    for (const id of new Set(
      finding.sites.map((site) => owners.get(site.file)).filter((id): id is string => Boolean(id)),
    )) {
      const group = groups.get(id)!;
      if (!group.findingIds.length) group.highestPriority = finding.rule;
      group.findingIds.push(finding.id);
    }
  }
}

/** Independent implementations, dependencies and named consumer sets are leads for a responsibility review. */
export function responsibilityFindings(facts: readonly MaintenanceBindingFacts[]): SourceFinding[] {
  const consumers = facts.flatMap((item) => item.consumers);
  const findings: SourceFinding[] = [];
  for (const fileFacts of facts) {
    if (fileFacts.functions.length < 4) continue;
    const file = fileFacts.functions[0]!.fn.file;
    const groups = independentFunctionGroups(fileFacts.functions)
      .map((group) => {
        const functions = group.filter((item) => item.exports.length && item.fn.tokenCount >= 60);
        const exports = new Set(functions.flatMap((item) => item.exports));
        return {
          functions,
          dependencies: [...new Set(group.flatMap((item) => item.dependencies))],
          consumers: consumers.filter((item) => item.target === file && (exports.has(item.name) || item.name === '*')),
        };
      })
      .filter((group) => group.functions.length >= 2 && group.dependencies.length && group.consumers.length);
    const independent = groups.filter((group) =>
      groups.every(
        (other) =>
          group === other ||
          !other.consumers.some((consumer) => group.consumers.some((item) => item.file === consumer.file)),
      ),
    );
    if (independent.length < 2) continue;
    findings.push({
      id: `responsibility:${file}`,
      rule: 'responsibility',
      evidence: 'candidate',
      score: independent.length,
      summary: `${file} contains ${independent.length} substantial exported function groups with separate observed dependencies and named consumers.`,
      sites: independent.flatMap((group) =>
        group.functions.map(({ fn }) => ({ file, line: fn.startLine, name: fn.name })),
      ),
      details: independent
        .map(
          (group, index) =>
            `Group ${index + 1}: ${group.functions.map((item) => item.fn.name).join(', ')}; dependencies: ${group.dependencies.join(', ')}; named importers: ${group.consumers.map((item) => `${item.file}:${item.line} (${item.name})`).join(', ')}.`,
        )
        .concat([
          'No shared same-file binding or imported module connects these groups in the covered top-level functions. Nested closures contribute their binding references to their containing function.',
          'A shared public contract can justify keeping these groups together. Classes, indirect re-exports, dynamic consumers, external users and runtime resource identity are not established by this provider. Read those contracts before proposing a split.',
        ]),
    });
  }
  return findings;
}

function independentFunctionGroups(functions: readonly MaintenanceFunctionBindings[]): MaintenanceFunctionBindings[][] {
  const graph = new Map(functions.map((_, index) => [String(index), new Set<string>()]));
  const owners = new Map<string, string>();
  functions.forEach((fn, index) => {
    const current = String(index);
    for (const key of [
      ...[fn.declaration, ...fn.bindings].map((offset) => `binding:${offset}`),
      ...fn.dependencies.map((file) => `import:${file}`),
    ]) {
      const previous = owners.get(key);
      if (previous !== undefined) {
        graph.get(current)!.add(previous);
        graph.get(previous)!.add(current);
      } else owners.set(key, current);
    }
  });
  return stronglyConnectedComponents(graph).components.map((members) =>
    members.map((member) => functions[Number(member)]!),
  );
}
