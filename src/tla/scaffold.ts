import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import type { IndexedDefinition } from '../domain/symbol-types.js';
import { getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { collectReadsForRange, collectWritesForRange, type VariableAlias } from './conformance.js';

/**
 * TLA P1 (`tla scaffold`): derive a draft TLA+ model, checker config, and
 * mapping contract from compiler-indexed evidence instead of hand-assertion.
 *
 * Evidence tier: heuristic draft. State variables come from the static write
 * scan (the same scan `tla verify` uses), domains come from declared union /
 * boolean types in source text, and actions come from top-level callables
 * that write discovered state. Everything uncertain is emitted as an explicit
 * TODO in the generated artifacts — a scaffold must never silently guess.
 */

export interface ScaffoldVariable {
  /** TLA+ variable name (sanitized leaf). */
  name: string;
  /** Source leaf name. */
  leaf: string;
  /** Mapping referent, `path/leaf` form used by the contract. */
  codeRef: string;
  declarationLine: number;
  /** TLA expression for the initial value, or null when not inferable. */
  initTla: string | null;
  /** TLA expression for the domain set, or null when not inferable. */
  domainTla: string | null;
  domainBasis: 'union-literal' | 'boolean' | 'sequence' | 'todo';
}

export interface ScaffoldAction {
  /** TLA+ action name (PascalCase of the function leaf). */
  name: string;
  leaf: string;
  codeRef: string;
  startLine: number;
  writes: string[];
  reads: string[];
}

export interface TlaScaffoldResult {
  moduleName: string;
  file: string;
  variables: ScaffoldVariable[];
  actions: ScaffoldAction[];
  warnings: string[];
  spec: string;
  cfg: string;
  map: string;
}

export interface TlaScaffoldOptions {
  moduleName?: string;
  specDir?: string;
}

const TLA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function scaffoldTlaModel(db: ScipDatabase, file: string, opts: TlaScaffoldOptions = {}): TlaScaffoldResult {
  const warnings: string[] = [];
  const definitions = getDefinitionsForFile(db, file);
  if (definitions.length === 0) {
    throw new Error(`no indexed definitions found for ${file}; run 'scip-query reindex' or check the path`);
  }
  const source = readFileSync(join(db.config.projectRoot, file), 'utf8');
  const lines = source.split(/\r?\n/);

  // Discriminate on the SCIP descriptor suffix ('().' = callable) rather than
  // isFunctionLike, which misclassifies term symbols (see round-2 review,
  // complexity-hotspots finding).
  const isCallable = (def: IndexedDefinition): boolean => def.symbol.trimEnd().endsWith('().');
  const topLevelVars = definitions.filter(
    (def) => !isCallable(def) && !def.isTypeLike && def.parentTypeName === null && TLA_NAME.test(def.leaf),
  );
  const aliases: VariableAlias[] = topLevelVars.map((def) => ({ variable: def.leaf, alias: def.leaf }));
  const fileWrites = aliases.length > 0 ? collectWritesForRange(db, file, 0, Number.POSITIVE_INFINITY, aliases) : [];
  const writtenLeafs = new Set(fileWrites.map((write) => write.variable));

  const stateDefs = topLevelVars.filter((def) => {
    if (writtenLeafs.has(def.leaf)) return true;
    return isLetDeclaration(lines, def);
  });
  if (stateDefs.length === 0) {
    throw new Error(
      `no mutable module state discovered in ${file} — the static write scan found no writes to top-level variables, ` +
        'and no top-level let declarations exist. Pick a file that owns runtime state.',
    );
  }

  const variables = stateDefs.map((def) => inferVariable(def, lines, file, warnings));

  const stateAliases: VariableAlias[] = variables.map((variable) => ({
    variable: variable.name,
    alias: variable.leaf,
  }));
  const callables = definitions.filter((def) => isCallable(def) && def.parentTypeName === null);
  const actions: ScaffoldAction[] = [];
  const seenActionNames = new Set<string>();
  for (const callable of callables) {
    const writes = collectWritesForRange(db, file, callable.startLine, callable.endLine, stateAliases);
    if (writes.length === 0) continue;
    const reads = collectReadsForRange(db, file, callable.startLine, callable.endLine, stateAliases);
    const name = uniqueActionName(pascalCase(callable.leaf), seenActionNames);
    actions.push({
      name,
      leaf: callable.leaf,
      codeRef: `${file}/${callable.leaf}`,
      startLine: callable.startLine,
      writes: [...new Set(writes.map((write) => write.variable))].sort(),
      reads: [...new Set(reads.map((read) => read.variable))].sort(),
    });
  }
  if (actions.length === 0) {
    warnings.push(
      'no top-level callable writes the discovered state; the generated Next relation is empty and the model cannot step. ' +
        'State may be mutated through methods, callbacks, or other files — narrow or widen the target.',
    );
  }

  const moduleName = opts.moduleName ?? defaultModuleName(file);
  const specDir = opts.specDir ?? join('specs', moduleName);
  const spec = renderSpec(moduleName, variables, actions, file);
  const cfg = renderCfg();
  const map = renderMap(moduleName, specDir, file, variables, actions);
  return { moduleName, file, variables, actions, warnings, spec, cfg, map };
}

function isLetDeclaration(lines: readonly string[], def: IndexedDefinition): boolean {
  const text = lines[def.startLine] ?? '';
  return /^\s*(export\s+)?let\s/.test(text);
}

function inferVariable(
  def: IndexedDefinition,
  lines: readonly string[],
  file: string,
  warnings: string[],
): ScaffoldVariable {
  const declaration = declarationText(lines, def);
  const name = def.leaf.replace(/[^A-Za-z0-9_]/g, '_');
  const { domainTla, domainBasis, initTla } = inferDomainAndInit(def.leaf, declaration);
  if (!domainTla) {
    warnings.push(
      `variable ${def.leaf} (${file}:${def.startLine + 1}): domain not inferable from the declared type — ` +
        'fill in the TODO domain before model checking.',
    );
  }
  if (!initTla) {
    warnings.push(
      `variable ${def.leaf} (${file}:${def.startLine + 1}): initial value not inferable — fill in the TODO in Init.`,
    );
  }
  return {
    name,
    leaf: def.leaf,
    codeRef: `${file}/${def.leaf}`,
    declarationLine: def.startLine,
    initTla,
    domainTla,
    domainBasis,
  };
}

function declarationText(lines: readonly string[], def: IndexedDefinition): string {
  // Take up to three physical lines from the declaration start — enough for
  // `let x: 'a' | 'b' =\n  'a';` style wrapping without parsing the file.
  return lines
    .slice(def.startLine, def.startLine + 3)
    .join(' ')
    .trim();
}

function inferDomainAndInit(
  leaf: string,
  declaration: string,
): { domainTla: string | null; domainBasis: ScaffoldVariable['domainBasis']; initTla: string | null } {
  const typeMatch = declaration.match(new RegExp(`\\b${escapeRegExpLocal(leaf)}\\s*:\\s*([^=;]+)`));
  const typeText = typeMatch?.[1]?.trim() ?? null;
  const initMatch = declaration.match(/=\s*([^;]+)/);
  const initText = initMatch?.[1]?.trim() ?? null;

  let domainTla: string | null = null;
  let domainBasis: ScaffoldVariable['domainBasis'] = 'todo';
  if (typeText) {
    const literals = unionStringLiterals(typeText);
    if (literals) {
      domainTla = `{${literals.map((value) => `"${value}"`).join(', ')}}`;
      domainBasis = 'union-literal';
    } else if (/^boolean\b/.test(typeText)) {
      domainTla = 'BOOLEAN';
      domainBasis = 'boolean';
    } else if (/\[\]\s*$/.test(typeText) || /^(Array|ReadonlyArray)</.test(typeText)) {
      domainBasis = 'sequence';
      domainTla = null; // sequences get a Seq(...) TypeOK clause with a TODO element domain
    }
  }

  let initTla: string | null = null;
  if (initText) {
    const scalar = initText.match(/^['"]([^'"]*)['"]/);
    if (scalar) initTla = `"${scalar[1]}"`;
    else if (/^(true|false)\b/.test(initText)) initTla = initText.startsWith('true') ? 'TRUE' : 'FALSE';
    else if (/^-?\d+\b/.test(initText)) initTla = initText.match(/^-?\d+/)![0];
    else if (/^\[\s*\]/.test(initText)) initTla = '<<>>';
  }
  return { domainTla, domainBasis, initTla };
}

function unionStringLiterals(typeText: string): string[] | null {
  const parts = typeText.split('|').map((part) => part.trim());
  if (parts.length < 2) return null;
  const literals: string[] = [];
  for (const part of parts) {
    const match = part.match(/^['"]([^'"]*)['"]$/);
    if (!match) return null;
    literals.push(match[1]!);
  }
  return literals;
}

function pascalCase(leaf: string): string {
  const cleaned = leaf.replace(/[^A-Za-z0-9_]/g, '_');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function uniqueActionName(base: string, seen: Set<string>): string {
  let name = base;
  let n = 2;
  while (seen.has(name)) name = `${base}${n++}`;
  seen.add(name);
  return name;
}

function defaultModuleName(file: string): string {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(/[^A-Za-z0-9_]/g, '');
  return pascalCase(cleaned || 'Model');
}

function renderSpec(
  moduleName: string,
  variables: readonly ScaffoldVariable[],
  actions: readonly ScaffoldAction[],
  file: string,
): string {
  const varNames = variables.map((variable) => variable.name);
  const out: string[] = [];
  out.push(`---- MODULE ${moduleName} ----`);
  out.push(`\\* Scaffolded by 'scip-query tla scaffold ${file}'.`);
  out.push(`\\* Draft evidence tier: state from the static write scan, domains from`);
  out.push(`\\* declared types, actions from top-level callables that write state.`);
  out.push(`\\* Review every TODO before trusting a green model-check run.`);
  out.push('EXTENDS Naturals, Sequences, TLC');
  out.push('');
  out.push(`VARIABLES ${varNames.join(', ')}`);
  out.push('');
  out.push(`vars == <<${varNames.join(', ')}>>`);
  out.push('');
  for (const variable of variables) {
    if (variable.domainBasis === 'sequence') continue;
    const domain = variable.domainTla ?? '{ "TODO" } \\* TODO: declare the domain';
    out.push(`${variable.name}Domain == ${domain}`);
  }
  out.push('');
  out.push('Init ==');
  for (const variable of variables) {
    const init =
      variable.initTla ?? `${variable.name}Domain \\* TODO: replace with the concrete initial value (\\in used)`;
    out.push(
      variable.initTla !== null
        ? `  /\\ ${variable.name} = ${variable.initTla}`
        : `  /\\ ${variable.name} \\in ${init}`,
    );
  }
  out.push('');
  for (const action of actions) {
    const unchanged = varNames.filter((name) => !action.writes.includes(name));
    out.push(`\\* Derived from ${action.codeRef} (writes: ${action.writes.join(', ') || 'none'})`);
    out.push(`${action.name} ==`);
    out.push(`  /\\ TRUE \\* TODO guard: encode the enabling condition of ${action.leaf}()`);
    for (const write of action.writes) {
      const variable = variables.find((candidate) => candidate.name === write);
      const domain = variable?.domainBasis === 'sequence' ? `Seq({"TODO"})` : `${write}Domain`;
      out.push(`  /\\ ${write}' \\in ${domain} \\* TODO: tighten to the concrete transition`);
    }
    if (unchanged.length > 0) out.push(`  /\\ UNCHANGED <<${unchanged.join(', ')}>>`);
    out.push('');
  }
  out.push('Next ==');
  if (actions.length === 0) {
    out.push('  FALSE \\* TODO: no state-writing callables were discovered');
  } else {
    for (const [index, action] of actions.entries()) {
      out.push(`  ${index === 0 ? '\\/' : '\\/'} ${action.name}`);
    }
  }
  out.push('');
  out.push('Spec == Init /\\ [][Next]_vars');
  out.push('');
  out.push('TypeOK ==');
  for (const variable of variables) {
    if (variable.domainBasis === 'sequence') {
      out.push(`  /\\ ${variable.name} \\in Seq({"TODO"}) \\* TODO: element domain`);
    } else {
      out.push(`  /\\ ${variable.name} \\in ${variable.name}Domain`);
    }
  }
  out.push('====');
  out.push('');
  return out.join('\n');
}

function renderCfg(): string {
  return ['SPECIFICATION Spec', 'INVARIANT TypeOK', ''].join('\n');
}

function renderMap(
  moduleName: string,
  specDir: string,
  file: string,
  variables: readonly ScaffoldVariable[],
  actions: readonly ScaffoldAction[],
): string {
  const contract = {
    module: `${specDir}/${moduleName}.tla`,
    config: `${specDir}/${moduleName}.cfg`,
    scope: [file],
    derived: {
      generatedBy: 'scip-query tla scaffold',
      basis: 'static-scan',
      generatedFrom: file,
    },
    variables: Object.fromEntries(
      variables.map((variable) => [variable.name, { code: [variable.codeRef], aliases: [variable.leaf] }]),
    ),
    actions: Object.fromEntries(
      actions.map((action) => [
        action.name,
        { code: [action.codeRef], reads: action.reads, writes: action.writes, calls: [] },
      ]),
    ),
    invariants: ['TypeOK'],
    traces: [],
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function escapeRegExpLocal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
