import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isRecord, stringArray } from '../storage/evidence-payload.js';
import { isPathInsideProject as isInsideProject } from '../source/path-normalization.js';
import { parseSanyXmlFacts, type SanyActionFacts } from './sany-facts.js';

export type TlaCheckerMode = 'auto' | 'sany' | 'tlc' | 'apalache' | 'none';

export interface TlaResourceBinding {
  /**
   * Expression or suffix matched textually against a filesystem call's first
   * argument (e.g. `"lockPath"` matches `rmSync(lockPath, ...)`). Evidence
   * tier for a resulting write/read stays `static-action` — this is a
   * textual containment check, not a resolved value.
   */
  path: string;
}

/**
 * Q2 / statement-alias tier: binds a variable to SQL-backed state. A call
 * expression argument whose static string text (a string literal, or the
 * static fragments of a template literal — interpolations excluded) matches
 * `pattern` is classified by leading SQL verb: INSERT/UPDATE/DELETE/REPLACE
 * is a write, SELECT is a read. `pattern` is compiled as a RegExp, so a
 * plain substring (e.g. a table name) works unescaped. Evidence tier stays
 * `static-action`, mirroring `TlaResourceBinding`.
 */
export interface TlaStatementBinding {
  pattern: string;
}

/**
 * Exempts a variable's `missing-referent`/`invalid-referent-kind` findings
 * (P5.2 / followup #17) — for state materialized only via a process exit
 * code, a literal, or another concept with no direct stored-field twin.
 * Distinct from `TlaActionMapping.waive`, which exempts read/write facts,
 * not referent resolution.
 */
export interface TlaVariableWaiver {
  reason: string;
}

/**
 * C1 / ORM-call attribution tier: binds a variable to ORM-backed state when
 * no literal SQL text exists to match against `statements` (Drizzle-style
 * query builders). A call chain whose own method name is in the effective
 * write set ({@link ORM_WRITE_METHOD_NAMES} by default) or read set
 * ({@link ORM_READ_METHOD_NAMES} by default) AND whose own first argument's
 * text equals `table` attributes a write/read to this variable —
 * `db.update(t).set(...)` and `db.insert(t).values(...)` match on their own
 * argument; `db.select().from(t)` matches on the `.from(t)` chain segment
 * (the special case, since `.select()` itself carries no table argument).
 * `methods`, when given, narrows the effective set to a subset of the
 * canonical write+read vocabulary — every name must already be one of the
 * seven defaults, or the mapping fails to load (mirrors the `statements`
 * tier's strict pattern-compile validation). Matching never looks at the
 * receiver identifier (`db`, `tx`, ...), only the method + table-arg shape.
 */
export interface TlaOrmCallBinding {
  table: string;
  methods?: string[];
}

/** C1: default write-classified ORM method names. */
export const ORM_WRITE_METHOD_NAMES = ['update', 'insert', 'delete'] as const;
/** C1: default read-classified ORM method names. */
export const ORM_READ_METHOD_NAMES = ['select', 'query', 'findFirst', 'findMany'] as const;
const ORM_METHOD_NAMES = new Set<string>([...ORM_WRITE_METHOD_NAMES, ...ORM_READ_METHOD_NAMES]);

/**
 * The method names actually in play for one `ormCalls` entry — `methods`
 * when given (validated at parse time to be a subset of the canonical
 * vocabulary), otherwise every default write+read name.
 */
export function ormCallEffectiveMethods(binding: TlaOrmCallBinding): { write: string[]; read: string[] } {
  const names = binding.methods && binding.methods.length > 0 ? binding.methods : [...ORM_METHOD_NAMES];
  const writeSet = new Set<string>(ORM_WRITE_METHOD_NAMES);
  const readSet = new Set<string>(ORM_READ_METHOD_NAMES);
  return {
    write: names.filter((name) => writeSet.has(name)),
    read: names.filter((name) => readSet.has(name)),
  };
}

export interface TlaVariableMapping {
  code: string[];
  aliases: string[];
  projection?: string;
  /** Binds this variable to filesystem state (lock files, published artifacts). */
  resource?: TlaResourceBinding;
  /** Binds this variable to SQL-backed state (prepared statements). */
  statements?: TlaStatementBinding[];
  /** C1: binds this variable to ORM-call-backed state (Drizzle-style query builders). */
  ormCalls?: TlaOrmCallBinding[];
  waive?: TlaVariableWaiver;
  /**
   * I3 / followup #25: when `false`, the variable's own name is NOT
   * force-included in `aliases` — an object-literal key or identifier that
   * merely echoes the variable name (but means something unrelated
   * elsewhere in scope) no longer attributes a write/read. Defaults to
   * `true` (unset here; only stored when explicitly `false`), matching the
   * pre-I3 behavior exactly for every existing mapping.
   */
  selfAlias?: boolean;
}

export interface TlaActionMapping {
  code: string[];
  reads: string[];
  writes: string[];
  calls: string[];
  waive?: TlaFactWaiver;
}

export interface TlaFactWaiver {
  reads: string[];
  writes: string[];
  reason: string;
  legacy?: boolean;
}

export interface TlaTraceStep {
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  code?: string;
}

/**
 * P5.7 / followup #19: controls the unmapped-write sweep's granularity.
 * `'scope-files'` (default, current behavior) scans every `scope` file's
 * full range — every function touching a modeled variable anywhere in
 * scope must be mapped as an action. `'actions'` opts out of that sweep
 * entirely, relying only on the per-action write/read checks — for models
 * whose scope files legitimately contain unrelated code the mapping was
 * never meant to cover in full.
 */
export type TlaUnmappedWriteScope = 'actions' | 'scope-files';

/**
 * Q3 / Init-binding: binds the model's `Init` to the code referent(s) that
 * materialize initial state (a lazy-init factory, a module-level default).
 * Writes statically found inside an Init referent are Init-attributed —
 * they are excluded from unmapped-write findings without needing
 * `unmappedWriteScope: "actions"` as a whole-file workaround. `codeRefs`
 * must not overlap any action's `code` referents (validated at load time):
 * a referent cannot be both the model's initialization and a transition.
 */
export interface TlaInitMapping {
  codeRefs: string[];
  waive?: TlaVariableWaiver;
}

export interface TlaModelContract {
  module?: string;
  config?: string;
  scope: string[];
  variables: Record<string, TlaVariableMapping>;
  actions: Record<string, TlaActionMapping>;
  init?: TlaInitMapping;
  invariants: string[];
  traces: string[];
  unmappedWriteScope: TlaUnmappedWriteScope;
}

export interface LoadedTlaContract {
  contract: TlaModelContract;
  mapPath: string;
  mapDir: string;
}

export interface TlaContractLoadResult {
  loaded?: LoadedTlaContract;
  errors: string[];
}

export interface TlaModuleFacts {
  path: string;
  modelParse: 'sany' | 'regex-fallback';
  variables: string[];
  operators: string[];
  actions: SanyActionFacts[];
  text: string;
}

const CHECKER_MODES = new Set<TlaCheckerMode>(['auto', 'sany', 'tlc', 'apalache', 'none']);
const TLA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isTlaCheckerMode(value: string): value is TlaCheckerMode {
  return CHECKER_MODES.has(value as TlaCheckerMode);
}

export function loadTlaModelContract(projectRoot: string, mapPath: string): TlaContractLoadResult {
  const errors: string[] = [];
  const resolvedMapPath = resolveProjectPath(projectRoot, mapPath);
  if (!resolvedMapPath) {
    return { errors: [`map path escapes project root: ${mapPath}`] };
  }
  if (!existsSync(resolvedMapPath)) {
    return { errors: [`map file not found: ${mapPath}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedMapPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`map file is not valid JSON: ${message}`] };
  }

  const contract = parseContract(raw, errors);
  if (!contract) return { errors };
  return {
    loaded: {
      contract,
      mapPath: resolvedMapPath,
      mapDir: dirname(resolvedMapPath),
    },
    errors,
  };
}

export function resolveProjectPath(projectRoot: string, path: string | undefined): string | null {
  if (!path) return null;
  const resolved = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  return isInsideProject(projectRoot, resolved) ? resolved : null;
}

export function resolveContractPath(projectRoot: string, mapDir: string, path: string | undefined): string | null {
  if (!path) return null;
  if (isAbsolute(path)) {
    const resolved = resolve(path);
    return isInsideProject(projectRoot, resolved) ? resolved : null;
  }

  const projectRelative = resolve(projectRoot, path);
  if (isInsideProject(projectRoot, projectRelative) && existsSync(projectRelative)) return projectRelative;

  const mapRelative = resolve(mapDir, path);
  if (isInsideProject(projectRoot, mapRelative) && existsSync(mapRelative)) return mapRelative;

  const fallback = isInsideProject(projectRoot, projectRelative) ? projectRelative : mapRelative;
  return isInsideProject(projectRoot, fallback) ? fallback : null;
}

export function readTlaModuleFacts(projectRoot: string, modulePath: string): TlaModuleFacts | null {
  const absolutePath = resolveProjectPath(projectRoot, modulePath);
  if (!absolutePath || !existsSync(absolutePath)) return null;
  const text = readFileSync(absolutePath, 'utf8');
  return {
    path: absolutePath,
    modelParse: 'regex-fallback',
    text,
    variables: parseTlaVariables(text),
    operators: parseTlaOperators(text),
    actions: [],
  };
}

export function readTlaModuleFactsFromSanyXml(
  projectRoot: string,
  modulePath: string,
  xml: string,
): TlaModuleFacts | null {
  const absolutePath = resolveProjectPath(projectRoot, modulePath);
  if (!absolutePath || !existsSync(absolutePath)) return null;
  const text = readFileSync(absolutePath, 'utf8');
  const facts = parseSanyXmlFacts(xml);
  return {
    path: absolutePath,
    modelParse: 'sany',
    text,
    variables: facts.variables,
    operators: facts.operators,
    actions: facts.actions,
  };
}

export function loadTraceSteps(projectRoot: string, tracePath: string): { steps: TlaTraceStep[]; errors: string[] } {
  const absolutePath = resolveProjectPath(projectRoot, tracePath);
  if (!absolutePath) return { steps: [], errors: [`trace path escapes project root: ${tracePath}`] };
  if (!existsSync(absolutePath)) return { steps: [], errors: [`trace file not found: ${tracePath}`] };

  try {
    const raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
    const stepsRaw = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.steps) ? raw.steps : null;
    if (!stepsRaw) return { steps: [], errors: [`trace file must be an array or an object with a steps array`] };
    const steps: TlaTraceStep[] = [];
    const errors: string[] = [];
    for (const [index, step] of stepsRaw.entries()) {
      if (!isRecord(step) || typeof step.action !== 'string') {
        errors.push(`trace step ${index} must include an action string`);
        continue;
      }
      steps.push({
        action: step.action,
        before: isRecord(step.before) ? step.before : undefined,
        after: isRecord(step.after) ? step.after : undefined,
        code: typeof step.code === 'string' ? step.code : undefined,
      });
    }
    return { steps, errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { steps: [], errors: [`trace file is not valid JSON: ${message}`] };
  }
}

/**
 * Dedupes trace input paths by resolved absolute location (P5.5 / followup
 * #20) — `contract.traces` and `--trace` naming the same file (relative vs.
 * absolute, or simply repeated) must not double-count that file's steps.
 * Preserves the first-seen original string (so relative-path resolution
 * behavior at load time is unchanged) and drops later duplicates.
 */
export function dedupeTracePaths(projectRoot: string, paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const resolved = resolveProjectPath(projectRoot, path) ?? path;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(path);
  }
  return out;
}

function parseContract(raw: unknown, errors: string[]): TlaModelContract | null {
  if (!isRecord(raw)) {
    errors.push('map file must contain a JSON object');
    return null;
  }

  const variables = parseVariables(raw.variables, errors);
  validateNoVariableCollisions(variables, errors);
  const actions = parseActions(raw.actions, variables, errors);
  const init = parseInitMapping(raw.init, errors);
  validateInitDoesNotOverlapActions(init, actions, errors);
  const contract: TlaModelContract = {
    module: optionalString(raw.module, 'module', errors),
    config: optionalString(raw.config, 'config', errors),
    scope: stringArray(raw.scope) ?? [],
    variables,
    actions,
    ...(init ? { init } : {}),
    invariants: stringArray(raw.invariants) ?? [],
    traces: stringArray(raw.traces) ?? [],
    unmappedWriteScope: parseUnmappedWriteScope(raw.unmappedWriteScope, errors),
  };
  validateScope(raw.scope, errors);
  return errors.length === 0 ? contract : null;
}

function parseInitMapping(raw: unknown, errors: string[]): TlaInitMapping | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push('init must be an object when present');
    return undefined;
  }
  const codeRefs = stringArray(raw.codeRefs);
  if (!codeRefs || codeRefs.length === 0) {
    errors.push('init.codeRefs must name at least one TypeScript referent');
    return undefined;
  }
  const waive = parseInitWaiver(raw.waive, errors);
  return { codeRefs, ...(waive ? { waive } : {}) };
}

function parseInitWaiver(raw: unknown, errors: string[]): TlaVariableWaiver | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push('init.waive must be an object when present');
    return undefined;
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason) {
    errors.push('init.waive.reason must be a non-empty string');
    return undefined;
  }
  return { reason };
}

/**
 * Q3: a referent cannot be both Init (initialization) and an action
 * (transition) — that would let the same code satisfy two contradictory
 * roles in the conformance model. Reject at load time, mirroring the
 * variable-collision checks.
 */
function validateInitDoesNotOverlapActions(
  init: TlaInitMapping | undefined,
  actions: Record<string, TlaActionMapping>,
  errors: string[],
): void {
  if (!init) return;
  const initRefs = new Set(init.codeRefs);
  const overlaps = new Set<string>();
  for (const mapping of Object.values(actions)) {
    for (const ref of mapping.code) {
      if (initRefs.has(ref)) overlaps.add(ref);
    }
  }
  if (overlaps.size > 0) {
    errors.push(
      `init.codeRefs overlaps action code referents: ${[...overlaps].sort().join(', ')} — a referent cannot be both Init and an action`,
    );
  }
}

function parseUnmappedWriteScope(raw: unknown, errors: string[]): TlaUnmappedWriteScope {
  if (raw === undefined) return 'scope-files';
  if (raw === 'actions' || raw === 'scope-files') return raw;
  errors.push(`unmappedWriteScope must be "actions" or "scope-files" when present`);
  return 'scope-files';
}

/**
 * P5.3 / followup #18: two variables sharing an alias (or the same
 * resource path suffix) makes every matching write/read ambiguous — the
 * conformance scanner would attribute it to both. Fail the load instead of
 * silently misattributing.
 */
function validateNoVariableCollisions(variables: Record<string, TlaVariableMapping>, errors: string[]): void {
  reportCollisions(variables, errors, 'alias', (mapping) => mapping.aliases);
  reportCollisions(variables, errors, 'resource path', (mapping) => (mapping.resource ? [mapping.resource.path] : []));
  reportCollisions(variables, errors, 'statement pattern', (mapping) =>
    mapping.statements ? mapping.statements.map((statement) => statement.pattern) : [],
  );
  // C1: two variables binding the same table are only ambiguous if their
  // effective method classes overlap — a write-only binding and a
  // read-only binding on the same table legitimately attribute to
  // different variables, so the collision key is (table, method), not
  // just table.
  reportCollisions(variables, errors, 'ORM table/method', (mapping) =>
    (mapping.ormCalls ?? []).flatMap((binding) => {
      const { write, read } = ormCallEffectiveMethods(binding);
      return [...write, ...read].map((method) => `${binding.table}:${method}`);
    }),
  );
}

function reportCollisions(
  variables: Record<string, TlaVariableMapping>,
  errors: string[],
  label: string,
  keysFor: (mapping: TlaVariableMapping) => readonly string[],
): void {
  const owners = new Map<string, string[]>();
  for (const [name, mapping] of Object.entries(variables)) {
    for (const key of keysFor(mapping)) {
      const existing = owners.get(key);
      if (existing) existing.push(name);
      else owners.set(key, [name]);
    }
  }
  for (const [key, names] of owners) {
    if (names.length < 2) continue;
    errors.push(
      `variables ${[...new Set(names)].sort().join(', ')} share ${label} "${key}" — conformance scanning cannot attribute a matching write/read to one variable unambiguously`,
    );
  }
}

function parseVariables(raw: unknown, errors: string[]): Record<string, TlaVariableMapping> {
  if (!isRecord(raw)) {
    errors.push('variables must be an object keyed by TLA+ variable name');
    return {};
  }

  const out: Record<string, TlaVariableMapping> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TLA_NAME_PATTERN.test(name)) {
      errors.push(`invalid TLA+ variable name: ${name}`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`variables.${name} must be an object`);
      continue;
    }
    const code = stringOrStringArray(value.code);
    if (!code || code.length === 0) {
      errors.push(`variables.${name}.code must name at least one TypeScript referent`);
      continue;
    }
    const aliases = stringArray(value.aliases) ?? [];
    const resource = parseResourceBinding(value.resource, name, errors);
    const statements = parseStatementBindings(value.statements, name, errors);
    const ormCalls = parseOrmCallBindings(value.ormCalls, name, errors);
    const waive = parseVariableWaiver(value.waive, name, errors);
    const selfAlias = parseSelfAlias(value.selfAlias, name, errors);
    const effectiveAliases = selfAlias ? [...new Set([name, ...aliases])] : [...new Set(aliases)];
    if (selfAlias === false && effectiveAliases.length === 0 && !resource && !statements && !ormCalls && !waive) {
      errors.push(
        `variables.${name}.selfAlias is false but no aliases, resource, statements, ormCalls, or waive are set — ${name} would be unattributable; add an explicit alias, bind resource/statements/ormCalls, or add variables.${name}.waive with a reason`,
      );
    }
    out[name] = {
      code,
      aliases: effectiveAliases,
      projection: typeof value.projection === 'string' ? value.projection : undefined,
      ...(resource ? { resource } : {}),
      ...(statements ? { statements } : {}),
      ...(ormCalls ? { ormCalls } : {}),
      ...(waive ? { waive } : {}),
      ...(selfAlias === false ? { selfAlias: false } : {}),
    };
  }
  return out;
}

/** I3 / followup #25: `variables.<v>.selfAlias`, defaulting to `true`. */
function parseSelfAlias(raw: unknown, variableName: string, errors: string[]): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  errors.push(`variables.${variableName}.selfAlias must be a boolean when present`);
  return true;
}

function parseResourceBinding(raw: unknown, variableName: string, errors: string[]): TlaResourceBinding | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`variables.${variableName}.resource must be an object when present`);
    return undefined;
  }
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) {
    errors.push(`variables.${variableName}.resource.path must be a non-empty string`);
    return undefined;
  }
  return { path };
}

function parseStatementBindings(
  raw: unknown,
  variableName: string,
  errors: string[],
): TlaStatementBinding[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`variables.${variableName}.statements must be an array when present`);
    return undefined;
  }
  const out: TlaStatementBinding[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`variables.${variableName}.statements[${index}] must be an object`);
      return;
    }
    const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
    if (!pattern) {
      errors.push(`variables.${variableName}.statements[${index}].pattern must be a non-empty string`);
      return;
    }
    try {
      new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `variables.${variableName}.statements[${index}].pattern is not a valid regular expression: ${message}`,
      );
      return;
    }
    out.push({ pattern });
  });
  return out.length > 0 ? out : undefined;
}

function parseOrmCallBindings(raw: unknown, variableName: string, errors: string[]): TlaOrmCallBinding[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`variables.${variableName}.ormCalls must be an array when present`);
    return undefined;
  }
  const out: TlaOrmCallBinding[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`variables.${variableName}.ormCalls[${index}] must be an object`);
      return;
    }
    const table = typeof entry.table === 'string' ? entry.table.trim() : '';
    if (!table) {
      errors.push(`variables.${variableName}.ormCalls[${index}].table must be a non-empty string`);
      return;
    }
    if (entry.methods === undefined) {
      out.push({ table });
      return;
    }
    const methods = stringArray(entry.methods);
    if (!methods) {
      errors.push(`variables.${variableName}.ormCalls[${index}].methods must be an array of strings when present`);
      return;
    }
    const unrecognized = methods.filter((method) => !ORM_METHOD_NAMES.has(method));
    if (unrecognized.length > 0) {
      errors.push(
        `variables.${variableName}.ormCalls[${index}].methods contains unrecognized name(s): ${unrecognized.join(', ')} — must be one of ${[...ORM_METHOD_NAMES].join(', ')}`,
      );
      return;
    }
    out.push(methods.length > 0 ? { table, methods } : { table });
  });
  return out.length > 0 ? out : undefined;
}

function parseVariableWaiver(raw: unknown, variableName: string, errors: string[]): TlaVariableWaiver | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`variables.${variableName}.waive must be an object when present`);
    return undefined;
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason) {
    errors.push(`variables.${variableName}.waive.reason must be a non-empty string`);
    return undefined;
  }
  return { reason };
}

function parseActions(
  raw: unknown,
  variables: Record<string, TlaVariableMapping>,
  errors: string[],
): Record<string, TlaActionMapping> {
  if (!isRecord(raw)) {
    errors.push('actions must be an object keyed by TLA+ action name');
    return {};
  }

  const variableNames = new Set(Object.keys(variables));
  const out: Record<string, TlaActionMapping> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TLA_NAME_PATTERN.test(name)) {
      errors.push(`invalid TLA+ action name: ${name}`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`actions.${name} must be an object`);
      continue;
    }
    const code = stringOrStringArray(value.code);
    if (!code || code.length === 0) {
      errors.push(`actions.${name}.code must name at least one TypeScript referent`);
      continue;
    }
    const reads = stringArray(value.reads) ?? [];
    const writes = stringArray(value.writes) ?? [];
    const calls = stringArray(value.calls) ?? [];
    for (const variable of [...reads, ...writes]) {
      if (!variableNames.has(variable)) errors.push(`actions.${name} references unknown variable: ${variable}`);
    }
    const waive = parseActionWaiver(
      value.waive,
      value.allowUnknown === true,
      reads,
      writes,
      variableNames,
      name,
      errors,
    );
    out[name] = {
      code,
      reads,
      writes,
      calls,
      ...(waive ? { waive } : {}),
    };
  }
  return out;
}

function parseActionWaiver(
  raw: unknown,
  allowUnknown: boolean,
  reads: readonly string[],
  writes: readonly string[],
  variableNames: ReadonlySet<string>,
  actionName: string,
  errors: string[],
): TlaFactWaiver | undefined {
  if (isRecord(raw)) {
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) errors.push(`actions.${actionName}.waive.reason must be a non-empty string`);
    const waivedReads = stringArray(raw.reads) ?? [];
    const waivedWrites = stringArray(raw.writes) ?? [];
    if (waivedReads.length === 0 && waivedWrites.length === 0) {
      errors.push(`actions.${actionName}.waive must list reads or writes`);
    }
    validateWaivedVariables(actionName, 'reads', waivedReads, variableNames, errors);
    validateWaivedVariables(actionName, 'writes', waivedWrites, variableNames, errors);
    return {
      reads: [...new Set(waivedReads)],
      writes: [...new Set(waivedWrites)],
      reason,
    };
  }

  if (raw !== undefined) {
    errors.push(`actions.${actionName}.waive must be an object when present`);
  }

  if (allowUnknown) {
    return {
      reads: [...new Set(reads)],
      writes: [...new Set(writes)],
      reason: 'legacy allowUnknown',
      legacy: true,
    };
  }

  return undefined;
}

function validateWaivedVariables(
  actionName: string,
  field: 'reads' | 'writes',
  variables: readonly string[],
  variableNames: ReadonlySet<string>,
  errors: string[],
): void {
  for (const variable of variables) {
    if (!variableNames.has(variable)) {
      errors.push(`actions.${actionName}.waive.${field} references unknown variable: ${variable}`);
    }
  }
}

function parseTlaVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*VARIABLES?\s+([^\n]+)/gm)) {
    const declaration = match[1] ?? '';
    for (const name of declaration.split(',')) {
      const cleaned = name.trim();
      if (TLA_NAME_PATTERN.test(cleaned)) names.add(cleaned);
    }
  }
  return [...names].sort();
}

function parseTlaOperators(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/** TLC config keywords that terminate a preceding INVARIANT(S) section. */
const TLC_CONFIG_KEYWORDS = new Set([
  'ACTION_CONSTRAINT',
  'ACTION_CONSTRAINTS',
  'ALIAS',
  'CHECK_DEADLOCK',
  'CONSTANT',
  'CONSTANTS',
  'CONSTRAINT',
  'CONSTRAINTS',
  'INIT',
  'INVARIANT',
  'INVARIANTS',
  'NEXT',
  'POSTCONDITION',
  'PROPERTIES',
  'PROPERTY',
  'SPECIFICATION',
  'SYMMETRY',
  'VIEW',
]);

export function readTlaConfigInvariants(configPath: string | null | undefined): string[] {
  if (!configPath || !existsSync(configPath)) return [];
  // TLC treats INVARIANT and INVARIANTS as synonyms, and invariant names may
  // appear on the keyword line or on any following lines until the next
  // config keyword (the standard block form). Strip comments, then tokenize.
  const text = readFileSync(configPath, 'utf8')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\\\*[^\n]*/g, ' ');
  const names = new Set<string>();
  let inInvariantSection = false;
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    if (TLC_CONFIG_KEYWORDS.has(token)) {
      inInvariantSection = token === 'INVARIANT' || token === 'INVARIANTS';
      continue;
    }
    if (inInvariantSection && TLA_NAME_PATTERN.test(token)) names.add(token);
  }
  return [...names].sort();
}

function optionalString(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  errors.push(`${field} must be a string when present`);
  return undefined;
}

function stringOrStringArray(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  return stringArray(value);
}

function validateScope(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!stringArray(value)) errors.push('scope must be an array of strings when present');
}

export function defaultMapPathForSpec(specPath: string): string {
  const base = specPath.replace(/\.tla$/i, '');
  return `${base}.scip-tla.json`;
}

/**
 * I5 / usability: `tla verify <spec>` resolving a sibling mapping purely by
 * filename fails for a mapping named after a variant (e.g. `FooHardened.
 * scip-tla.json`) that targets the plain `Foo.tla` spec — 4 of 9 real Vega
 * mappings hit this exact shape. Called only as a fallback, after the
 * default filename-matched mapping was checked and found absent.
 */
export type TlaMapAutoDiscoveryResult =
  | { status: 'found'; mapPath: string; moduleName: string }
  | { status: 'ambiguous'; candidates: string[]; moduleName: string }
  | { status: 'none' };

const TLA_MODULE_HEADER = /^-{4,}\s*MODULE\s+([A-Za-z_][A-Za-z0-9_]*)\s*-{4,}/m;

/**
 * Scans `specPath`'s own directory for sibling `*.scip-tla.json` files
 * whose top-level `module` field names the spec — the project-relative
 * `.tla` path (this repo's own `specs/**\/*.scip-tla.json` and every real
 * Vega mapping use that full-path convention), the bare filename with or
 * without its `.tla` extension, or the spec's own `---- MODULE <name> ----`
 * identifier are all accepted so a hand-written mapping using any of those
 * natural spellings is found. Never picks silently: zero matches is
 * `'none'` (caller falls through to the ordinary "map file not found"
 * error), exactly one is `'found'`, two or more is `'ambiguous'` naming
 * every candidate so the caller can report them instead of guessing.
 */
export function discoverMapPathByModule(projectRoot: string, specPath: string): TlaMapAutoDiscoveryResult {
  if (!existsSync(specPath)) return { status: 'none' };
  const moduleMatch = readFileSync(specPath, 'utf8').match(TLA_MODULE_HEADER);
  const moduleName = moduleMatch?.[1];
  const relativeSpecPath = relative(projectRoot, specPath).split(sep).join('/');
  const specBasename = basename(specPath);
  const acceptable = new Set(
    [moduleName, relativeSpecPath, specBasename, specBasename.replace(/\.tla$/i, '')].filter((value): value is string =>
      Boolean(value),
    ),
  );

  const dir = dirname(specPath);
  if (!existsSync(dir)) return { status: 'none' };
  const candidates: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.scip-tla.json')) continue;
    const candidatePath = join(dir, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(candidatePath, 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (isRecord(raw) && typeof raw.module === 'string' && acceptable.has(raw.module)) candidates.push(candidatePath);
  }
  candidates.sort();

  const resolvedModuleName = moduleName ?? relativeSpecPath;
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length > 1) return { status: 'ambiguous', candidates, moduleName: resolvedModuleName };
  return { status: 'found', mapPath: candidates[0]!, moduleName: resolvedModuleName };
}
