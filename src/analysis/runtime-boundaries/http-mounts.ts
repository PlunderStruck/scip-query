import { createHash } from 'node:crypto';
import { getReExports, getSourceImports } from '../../language-parsers/index.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { evaluateStaticValue as evaluateBoundaryValue } from '../../symbols/graph/static-value-flow.js';
import { boundaryFileContext } from './extractors.js';
import type { BoundaryKeyPart, BoundaryObservation } from './types.js';

const MAX_REEXPORT_DEPTH = 4;

interface HttpMount {
  file: string;
  line: number;
  prefix: Omit<BoundaryKeyPart, 'name'>;
  targetFiles: string[];
}

export interface HttpMountCompositionResult {
  observations: BoundaryObservation[];
  filesInspected: number;
  mounts: number;
}

/** Compose proved framework mount prefixes onto route registrations. */
export function composeHttpMounts(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
): BoundaryObservation[] {
  return composeHttpMountsWithCoverage(db, observations).observations;
}

export function composeHttpMountsWithCoverage(
  db: ScipDatabase,
  observations: readonly BoundaryObservation[],
): HttpMountCompositionResult {
  const handlersByFile = new Map<string, BoundaryObservation[]>();
  for (const observation of observations) {
    if (observation.action !== 'http.handle' || observation.sourceScope !== 'production') continue;
    const bucket = handlersByFile.get(observation.source.file) ?? [];
    bucket.push(observation);
    handlersByFile.set(observation.source.file, bucket);
  }

  const derived: BoundaryObservation[] = [];
  const collected = collectHttpMounts(db);
  for (const mount of collected.mounts) {
    for (const targetFile of mount.targetFiles) {
      for (const handler of handlersByFile.get(targetFile) ?? []) {
        const path = handler.keyParts.find((part) => part.name === 'path');
        if (!path || path.evidence === 'expression') continue;
        const composed = composePath(mount.prefix.value, path.value);
        const keyParts = handler.keyParts.map(
          (part): BoundaryKeyPart =>
            part.name === 'path'
              ? {
                  name: 'path',
                  value: composed,
                  evidence: 'constant',
                  term: {
                    kind: 'concat',
                    parts: [
                      mount.prefix.term ?? { kind: 'literal', value: mount.prefix.value },
                      path.term ?? { kind: 'literal', value: path.value },
                    ],
                  },
                  derivation: {
                    kind: 'mechanically-derived',
                    rule: 'http.mount-prefix',
                    ruleVersion: '1',
                    inputFactIds: [handler.id],
                    sourceSpans: [
                      handler.source,
                      { file: mount.file, startLine: mount.line, endLine: mount.line },
                      ...(mount.prefix.derivation?.sourceSpans ?? []),
                      ...(path.derivation?.sourceSpans ?? []),
                    ],
                  },
                }
              : part,
        );
        const identity = `${handler.id}\0${mount.file}\0${mount.line}\0${composed}`;
        derived.push({
          ...handler,
          id: `boundary:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
          keyParts,
          strength: 'derived',
          evidence: 'framework-mount-composition',
          derivation: {
            kind: 'mechanically-derived',
            rule: 'http.mount-prefix',
            ruleVersion: '1',
            inputFactIds: [handler.id],
            sourceSpans: [handler.source, { file: mount.file, startLine: mount.line, endLine: mount.line }],
          },
          resolution: 'unresolved',
        });
        // A relative route registration is not independently a deployed address once a proved mount owns it.
        handler.strength = 'candidate';
        handler.resolution = 'unresolved';
      }
    }
  }
  return {
    observations: derived,
    filesInspected: collected.filesInspected,
    mounts: collected.mounts.length,
  };
}

function collectHttpMounts(db: ScipDatabase): { mounts: HttpMount[]; filesInspected: number } {
  const mounts: HttpMount[] = [];
  const files = getSourceFiles(db);
  for (const file of files) {
    const source = getSourceText(db, file);
    if (!hasExpressLikeImport(source)) continue;
    const context = boundaryFileContext(db, file);
    if (!context) continue;
    walk(context.root, (node) => {
      if (node.type !== 'call_expression') return;
      const target = node.childForFieldName('function') ?? node.namedChild(0);
      if (!target || !/\.use$/u.test(target.text.replace(/\s+/gu, ''))) return;
      const args = callArguments(node);
      if (args.length < 2) return;
      const prefix = evaluateBoundaryValue(context, args[0]);
      if (!prefix || prefix.evidence === 'expression') return;
      const targetFiles = resolveMountedTargetFiles(db, file, args[1]!);
      if (targetFiles.length === 0) return;
      mounts.push({
        file,
        line: node.startPosition.row,
        prefix: {
          value: prefix.value,
          evidence: prefix.evidence,
          term: prefix.term,
          derivation: prefix.derivation,
        },
        targetFiles,
      });
    });
  }
  return { mounts, filesInspected: files.length };
}

function resolveMountedTargetFiles(db: ScipDatabase, importerFile: string, expression: SyntaxNode): string[] {
  const targetText = expression.text.replace(/\s+/gu, '');
  const localName = /^([A-Za-z_$][\w$]*)/u.exec(targetText)?.[1];
  if (!localName) return [];
  const imported = getSourceImports(db, importerFile).find((item) => item.localName === localName && item.sourcePath);
  if (!imported?.sourcePath) return [importerFile];
  if (imported.kind === 'namespace') return [imported.sourcePath];
  const importedName = imported.importedName === 'default' ? localName : imported.importedName;
  const definitions = resolveImportedDefinitions(db, imported.sourcePath, importedName);
  return [...new Set(definitions.map((definition) => definition.relativePath))];
}

function resolveImportedDefinitions(
  db: ScipDatabase,
  relativePath: string,
  importedName: string,
  depth = 0,
  seen = new Set<string>(),
): ReturnType<typeof getDefinitionsForFile> {
  const identity = `${relativePath}\0${importedName}`;
  if (seen.has(identity) || depth > MAX_REEXPORT_DEPTH) return [];
  seen.add(identity);
  const direct = getDefinitionsForFile(db, relativePath).filter((definition) => definition.leaf === importedName);
  if (direct.length > 0) return direct;
  return getReExports(db, relativePath).flatMap((reexport) => {
    if (!reexport.sourcePath) return [];
    if (reexport.kind === 'named' && !reexport.names.includes(importedName)) return [];
    return resolveImportedDefinitions(db, reexport.sourcePath, importedName, depth + 1, new Set(seen));
  });
}

function composePath(prefix: string, path: string): string {
  const left = prefix === '/' ? '' : prefix.replace(/\/+$/u, '');
  const right = path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}` || '/';
}

function hasExpressLikeImport(source: string): boolean {
  return /(?:\bfrom\s*|\brequire\s*\(\s*)['"](?:express|fastify|hono|koa-router|@koa\/router)(?:[/']|")/u.test(source);
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
  return args?.namedChildren ?? [];
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
