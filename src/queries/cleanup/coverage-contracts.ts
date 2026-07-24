import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  CoverageContractConfig,
  CoverageContractKeySpec,
  CoverageContractSourceSpec,
} from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, getAst } from '../../source/ast.js';
import type { AstLanguage, SyntaxNode, Tree } from '../../source/ast.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { escapeRegex } from '../../source/primitives/regex-utils.js';
import { listGlobMatches, matchesGlob } from '../../analysis/glob-match.js';

/**
 * Coverage contracts close the "enumeration rot" defect class: a
 * hand-written key set (an object literal, a string array, a markdown
 * list) that is supposed to enumerate the same things as some ground-truth
 * source, but silently drifts because nothing checks it. See
 * docs/plans/2026-07-01-remediation-3-detection-primitives-and-lens-skills.md
 * step 17.3 for the design.
 */

export type CoverageContractStatus = 'ok' | 'violated' | 'unavailable';

export interface CoverageContractResult {
  name: string;
  file: string;
  status: CoverageContractStatus;
  /** Ground-truth entries the declared key set does not cover. */
  missing: string[];
  /** Declared entries with no ground-truth match (only when allowExtra is false). */
  extra: string[];
  /** Present only when status is 'unavailable' — never silently treated as passing. */
  unavailableReason?: string;
}

type KeyExtractionResult =
  | { ok: true; keys: string[] }
  | { ok: false; reason: string; disclosedUnavailable?: { language: AstLanguage; reason: 'parser-unavailable' } };

/** Pure set-diff core — the seam `checkCoverageContract` unit tests target directly. */
export function checkCoverageContract(
  declaredKeys: readonly string[],
  groundTruthKeys: readonly string[],
  opts: { allowExtra?: boolean } = {},
): { missing: string[]; extra: string[] } {
  const declared = new Set(declaredKeys);
  const groundTruth = new Set(groundTruthKeys);
  const missing = [...groundTruth].filter((key) => !declared.has(key)).sort();
  const extra = opts.allowExtra ? [] : [...declared].filter((key) => !groundTruth.has(key)).sort();
  return { missing, extra };
}

export function evaluateCoverageContract(db: ScipDatabase, contract: CoverageContractConfig): CoverageContractResult {
  const extraction = extractContractKeys(db, contract.file, contract.keys);
  if (!extraction.ok) {
    return {
      name: contract.name,
      file: contract.file,
      status: 'unavailable',
      missing: [],
      extra: [],
      unavailableReason: extraction.reason,
    };
  }
  const groundTruth = resolveContractSource(db.config.projectRoot, contract.mustEqual);
  const diff = checkCoverageContract(extraction.keys, groundTruth, { allowExtra: contract.allowExtra ?? false });
  const status: CoverageContractStatus = diff.missing.length > 0 || diff.extra.length > 0 ? 'violated' : 'ok';
  return { name: contract.name, file: contract.file, status, missing: diff.missing, extra: diff.extra };
}

export function evaluateCoverageContracts(
  db: ScipDatabase,
  contracts: readonly CoverageContractConfig[],
): CoverageContractResult[] {
  return contracts.map((contract) => evaluateCoverageContract(db, contract));
}

/** True when this diff touched either side of the contract — the diff-gate run condition. */
export function coverageContractTouchedByDiff(
  contract: CoverageContractConfig,
  changedFiles: ReadonlySet<string>,
): boolean {
  if (changedFiles.has(contract.file)) return true;
  const source = contract.mustEqual;
  switch (source.type) {
    case 'top-level-dirs':
      return [...changedFiles].some((file) => file === source.path || file.startsWith(`${source.path}/`));
    case 'file-glob':
      return [...changedFiles].some((file) => matchesGlob(source.pattern, file));
    case 'registered-commands':
      return changedFiles.has('docs/COMMAND_REFERENCE.md');
    case 'builtin-skills':
      return [...changedFiles].some((file) => file.startsWith('skills/'));
  }
}

export function coverageContractFindingMessage(result: CoverageContractResult): string {
  if (result.status === 'unavailable') {
    return `[coverage-contract] ${result.name}: DISCLOSED — could not evaluate (${result.unavailableReason})`;
  }
  const parts: string[] = [];
  if (result.missing.length > 0) parts.push(`missing ${result.missing.join(', ')}`);
  if (result.extra.length > 0) parts.push(`extra ${result.extra.join(', ')}`);
  return `[coverage-contract] ${result.name}: ${parts.join('; ')}`;
}

// ── Key extractors (the declared side) ─────────────────────

function extractContractKeys(db: ScipDatabase, file: string, spec: CoverageContractKeySpec): KeyExtractionResult {
  if (spec.type === 'markdown-list') return extractMarkdownListKeys(db, file, spec.marker);
  return extractAstKeys(db, file, spec);
}

function extractAstKeys(
  db: ScipDatabase,
  file: string,
  spec: Extract<CoverageContractKeySpec, { type: 'object-literal-keys' | 'string-array' }>,
): KeyExtractionResult {
  const source = getSourceText(db, file);
  if (!source) return { ok: false, reason: `file not found: ${file}` };
  const language = detectAstLanguage(file);
  if (!language) {
    return { ok: false, reason: `unsupported file type for ${spec.type} extraction: ${file}` };
  }
  const tree = getAst(db, file);
  if (!tree) {
    return {
      ok: false,
      reason: `tree-sitter parser unavailable for ${language} (${file}) — contract skipped, not silently passed`,
      disclosedUnavailable: { language, reason: 'parser-unavailable' },
    };
  }
  const keys =
    spec.type === 'object-literal-keys'
      ? objectLiteralKeysByIdentifier(tree, spec.identifier)
      : stringArrayByIdentifier(tree, spec.identifier);
  if (keys === null) {
    const kind = spec.type === 'object-literal-keys' ? 'object literal' : 'string array';
    return { ok: false, reason: `no ${kind} named "${spec.identifier}" found in ${file}` };
  }
  return { ok: true, keys };
}

function declaratorValueNode(declarator: SyntaxNode): SyntaxNode | null {
  const value = declarator.childForFieldName('value');
  if (!value) return null;
  if (value.type === 'as_expression' || value.type === 'satisfies_expression') {
    return value.namedChild(0);
  }
  return value;
}

function objectLiteralKeysByIdentifier(tree: Tree, identifier: string): string[] | null {
  for (const declarator of tree.rootNode.descendantsOfType('variable_declarator')) {
    const nameNode = declarator.childForFieldName('name');
    if (nameNode?.text !== identifier) continue;
    const value = declaratorValueNode(declarator);
    if (value?.type !== 'object') continue;
    return objectLiteralKeyNames(value);
  }
  return null;
}

function objectLiteralKeyNames(objectNode: SyntaxNode): string[] {
  const keys = new Set<string>();
  for (const child of objectNode.namedChildren) {
    if (child.type === 'pair') {
      const keyNode = child.childForFieldName('key');
      if (keyNode) keys.add(stripQuotes(keyNode.text));
    } else if (child.type === 'shorthand_property_identifier') {
      keys.add(child.text);
    }
  }
  return [...keys].sort();
}

function stringArrayByIdentifier(tree: Tree, identifier: string): string[] | null {
  for (const declarator of tree.rootNode.descendantsOfType('variable_declarator')) {
    const nameNode = declarator.childForFieldName('name');
    if (nameNode?.text !== identifier) continue;
    const value = declaratorValueNode(declarator);
    if (value?.type !== 'array') continue;
    const values = new Set<string>();
    for (const element of value.namedChildren) {
      if (element.type === 'string') values.add(stripQuotes(element.text));
    }
    return [...values].sort();
  }
  return null;
}

function stripQuotes(text: string): string {
  if (text.length >= 2 && ((text[0] === "'" && text.endsWith("'")) || (text[0] === '"' && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  return text;
}

function extractMarkdownListKeys(db: ScipDatabase, file: string, marker: string): KeyExtractionResult {
  const source = getSourceText(db, file);
  if (!source) return { ok: false, reason: `file not found: ${file}` };
  const block = markerBlock(source, marker);
  if (block === null) {
    return {
      ok: false,
      reason: `no <!-- BEGIN GENERATED ${marker} --> ... <!-- END GENERATED ${marker} --> block in ${file}`,
    };
  }
  return { ok: true, keys: namesFromMarkdownBlock(block) };
}

function markerBlock(source: string, marker: string): string | null {
  const escapedMarker = escapeRegex(marker);
  const pattern = new RegExp(
    `<!--\\s*BEGIN GENERATED ${escapedMarker}\\s*-->([\\s\\S]*?)<!--\\s*END GENERATED ${escapedMarker}\\s*-->`,
  );
  const match = pattern.exec(source);
  return match ? match[1]! : null;
}

function namesFromMarkdownBlock(block: string): string[] {
  const names = new Set<string>();
  for (const match of block.matchAll(/`([a-z][a-z0-9-]*)`/g)) names.add(match[1]!);
  for (const match of block.matchAll(/\[([a-z][a-z0-9-]*)\]\([^)]*\)/g)) names.add(match[1]!);
  return [...names].sort();
}

// ── Ground-truth source resolvers (the "mustEqual" side) ────

export function resolveContractSource(projectRoot: string, spec: CoverageContractSourceSpec): string[] {
  switch (spec.type) {
    case 'top-level-dirs':
      return listTopLevelDirs(join(projectRoot, spec.path));
    case 'file-glob':
      return [...new Set(listGlobMatches(projectRoot, spec.pattern).map((relative) => basename(relative)))].sort();
    case 'registered-commands':
      return resolveRegisteredCommands(projectRoot);
    case 'builtin-skills':
      return listTopLevelDirs(join(projectRoot, 'skills'));
  }
}

function listTopLevelDirs(absoluteDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The registered-command list ground truth is the generated command
 * reference itself, not a runtime import of the command descriptors: the
 * the query layer should not import runtime command registration, and the
 * generated doc is already kept in lockstep with the descriptors by the
 * "keeps command reference syntax generated from descriptors" CLI contract
 * test — reading it is equivalent to reading the registry.
 */
function resolveRegisteredCommands(projectRoot: string): string[] {
  let source: string;
  try {
    source = readFileSync(join(projectRoot, 'docs/COMMAND_REFERENCE.md'), 'utf-8');
  } catch {
    return [];
  }
  const block = markerBlock(source, 'COMMAND REFERENCE');
  if (!block) return [];
  return namesFromMarkdownBlock(block);
}
