import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CHANGE_BENCHMARK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../benchmarks/change');
export const CHANGE_PHASES = ['initial', 'follow-up'];

export function changeSuite(root = CHANGE_BENCHMARK_ROOT) {
  const suite = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'));
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.tasks) || suite.tasks.length === 0)
    throw new Error('Invalid change suite');
  const ids = new Set();
  for (const task of suite.tasks) {
    if (!/^[a-z][a-z0-9-]*$/u.test(task.id) || ids.has(task.id) || !task.request?.trim() || !task.followUp?.trim())
      throw new Error('Invalid or duplicate change task');
    ids.add(task.id);
  }
  return suite;
}

export function fileInventory(root) {
  const result = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in submitted source: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) result.push(relative(root, target).replaceAll('\\', '/'));
    }
  };
  if (existsSync(root)) visit(root);
  return result;
}

export function directoryDigest(root) {
  const hash = createHash('sha256');
  for (const path of fileInventory(root))
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(join(root, path)))
      .update('\0');
  return hash.digest('hex');
}

export function materializeChangeFixture(destination, taskId, root = CHANGE_BENCHMARK_ROOT) {
  if (!changeSuite(root).tasks.some((task) => task.id === taskId)) throw new Error(`Unknown task: ${taskId}`);
  cpSync(join(root, 'fixture'), destination, { recursive: true, errorOnExist: true, force: false });
  if (taskId === 'dependency-direction') {
    writeFileSync(
      join(destination, 'src/domain/shipping.ts'),
      "import { webShippingRate } from '../adapters/web-config.js';\n\nexport function shippingCost(weight: number): number {\n  return weight * webShippingRate;\n}\n",
    );
    writeFileSync(
      join(destination, 'src/adapters/shipping.ts'),
      "import { shippingCost } from '../domain/shipping.js';\n\nexport function webShippingQuote(weight: number): number {\n  return shippingCost(weight);\n}\n",
    );
  }
  return destination;
}

export function changePrompt(task, mode, phase) {
  if (!['control', 'treatment'].includes(mode) || !CHANGE_PHASES.includes(phase))
    throw new Error('Invalid trial condition');
  const surface =
    mode === 'control'
      ? 'Explore using native shell search and source reads. Do not invoke scip-query or import its implementation.'
      : 'Use scip-query as the primary repository exploration surface. Use search for exact text, code <path> --members all for a complete file, evidence with explicit roots/family/direction/depth/max-edges for relationships, architecture for the declared policy, and diff-impact after your edit. Drain every printed Continue exactly command. Native tools are available for edits, tests, metadata, or an explicitly unsupported exploration gap. An index is already prepared; no setup or global skill installation is needed. Run --help for syntax as needed.';
  return `Implement this change in the current repository:\n\n${phase === 'initial' ? task.request : task.followUp}\n\nRead README.md to understand the declared responsibilities. Before editing, identify the responsible code, relevant callers, behavior to preserve, and dependency constraints. Inspect the evidence needed for those facts, batch independent reads, and avoid repeating source already read. Make the change, check the affected callers and appropriate behavior, then review the diff for obsolete wiring and unintended boundary changes. Source size alone is not a quality criterion.\n\n${surface}\n\nWork only in this checkout. You may edit src/** and add focused tests. Add executable tests as test/*.test.mjs using Node built-ins. You may update tests added during an earlier phase when the requested behavior changes. Do not modify the original test/smoke.test.mjs, package.json, tsconfig.json, README.md, AGENTS.md, .gitignore, or .scipquery.json; those define the evaluation environment and existing contracts. Do not inspect parent directories, benchmark definitions, hidden checks, other trials, or reference patches. Do not install packages, use the network, launch subagents, commit changes, or modify global settings. Finish with a concise summary of your changes, checks, and remaining limitations.\n`;
}

export function evaluateChange(repository, taskId, phase, root = CHANGE_BENCHMARK_ROOT) {
  if (!changeSuite(root).tasks.some((task) => task.id === taskId) || !CHANGE_PHASES.includes(phase))
    throw new Error('Invalid change evaluation');
  const obligations = [];
  const add = (id, category, pass, detail) => obligations.push({ id, category, pass, ...(detail ? { detail } : {}) });
  const fixture = join(root, 'fixture');
  recordFrozenChangeObligations(repository, fixture, add);
  const scratch = mkdtempSync(join(tmpdir(), 'scip-change-check-'));
  try {
    const files = fileInventory(join(repository, 'src'));
    if (files.some((path) => !path.endsWith('.ts'))) throw new Error('This suite supports TypeScript source only');
    cpSync(join(repository, 'src'), join(scratch, 'src'), { recursive: true });
    cpSync(join(fixture, 'package.json'), join(scratch, 'package.json'));
    cpSync(join(fixture, 'tsconfig.json'), join(scratch, 'tsconfig.json'));
    for (const path of ['README.md', '.scipquery.json', '.gitignore']) cpSync(join(fixture, path), join(scratch, path));
    const config = ts.readConfigFile(join(scratch, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, scratch);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    add(
      'typescript',
      'behavior',
      diagnostics.length === 0,
      diagnostics.length
        ? ts.formatDiagnostics(diagnostics, {
            getCurrentDirectory: () => scratch,
            getCanonicalFileName: (path) => path,
            getNewLine: () => '\n',
          })
        : undefined,
    );
    if (diagnostics.length > 0) return report();
    const structural = checkStructure(program, scratch, taskId, phase, root);
    obligations.push(...structural);
    program.emit();
    evaluateSubmittedTests(repository, scratch, fixture, add);
    obligations.push(...evaluateBehaviorChecks(scratch, taskId, phase, root));
    if (taskId === 'retire-implementation') evaluateRetiredImplementation(repository, files, add);
    return report();
  } catch (error) {
    add('evaluable-source', 'integrity', false, error.message);
    return report();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  function report() {
    return {
      taskId,
      phase,
      pass: obligations.every((item) => item.pass),
      obligations,
      limitations: [
        'Runtime checks cover the specified fixture cases. Structural checks cover compiler-resolved direct imports and calls, not arbitrary dynamic dispatch or a general proof of good design. Human design review remains separate.',
      ],
    };
  }
}

function recordFrozenChangeObligations(repository, fixture, add) {
  for (const path of [
    'package.json',
    'tsconfig.json',
    'README.md',
    '.gitignore',
    '.scipquery.json',
    'test/smoke.test.mjs',
  ]) {
    add(
      `preserved:${path}`,
      'integrity',
      existsSync(join(repository, path)) &&
        readFileSync(join(repository, path)).equals(readFileSync(join(fixture, path))),
      'Frozen environment and policy must remain unchanged.',
    );
  }
}

function evaluateSubmittedTests(repository, scratch, fixture, add) {
  const testFiles = fileInventory(join(repository, 'test'));
  cpSync(join(repository, 'test'), join(scratch, 'test'), { recursive: true });
  cpSync(join(fixture, 'test/smoke.test.mjs'), join(scratch, 'test/smoke.test.mjs'));
  const executableTests = [
    ...new Set(['smoke.test.mjs', ...testFiles.filter((path) => !path.includes('/') && path.endsWith('.test.mjs'))]),
  ];
  const tests = spawnSync(process.execPath, ['--test', ...executableTests.map((path) => join(scratch, 'test', path))], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  add(
    'submitted-tests',
    'verification',
    tests.status === 0 && !tests.error,
    tests.status === 0 && !tests.error
      ? `${executableTests.length} test file(s) executed against independent compilation.`
      : `${tests.error?.message ?? tests.stdout ?? tests.stderr}`,
  );
}

function evaluateBehaviorChecks(scratch, taskId, phase, root) {
  const input = join(scratch, 'input.json');
  writeFileSync(input, JSON.stringify({ build: join(scratch, 'build'), task: taskId, phase }));
  const execution = spawnSync(process.execPath, [join(root, 'checks.mjs'), input], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (execution.status !== 0 || execution.error) {
    return [
      {
        id: 'behavior-runner',
        category: 'behavior',
        pass: false,
        detail: `${execution.error?.message ?? execution.stderr ?? execution.signal}`,
      },
    ];
  } else {
    return JSON.parse(execution.stdout);
  }
}

function evaluateRetiredImplementation(repository, files, add) {
  const remnants = files.filter(
    (path) =>
      /legacy-receipt/u.test(path) ||
      /sendLegacyReceipt|legacyReceiptEnabled|legacy-receipt/u.test(
        readFileSync(join(repository, 'src', path), 'utf8'),
      ),
  );
  add('legacy-retired', 'retirement', remnants.length === 0, remnants.join(', '));
}

function checkStructure(program, root, taskId, phase, suiteRoot) {
  const checker = program.getTypeChecker();
  const localPath = (file) => relative(root, file).replaceAll('\\', '/');
  const sourceFiles = program.getSourceFiles().filter((file) => localPath(file.fileName).startsWith('src/'));
  const boundary = (file) =>
    file.endsWith('/src/index.ts') ? 'public' : relative(join(root, 'src'), file).split(/[\\/]/u)[0];
  const allowed = JSON.parse(readFileSync(join(suiteRoot, 'fixture/.scipquery.json'), 'utf8')).architecture
    .allowedDependencies;
  const violations = [];
  const unsupported = [];
  const functions = new Map();
  const edges = new Map();
  const isCallable = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node);
  for (const file of sourceFiles) {
    if (!allowed[boundary(file.fileName)]) unsupported.push(`${relative(root, file.fileName)}: undeclared boundary`);
    const visit = (node) => {
      if (isCallable(node) && node.body) functions.set(node, file.fileName);
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = ts.resolveModuleName(
            node.moduleSpecifier.text,
            file.fileName,
            program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule;
          if (!target || !localPath(target.resolvedFileName).startsWith('src/'))
            unsupported.push(`${relative(root, file.fileName)}: ${node.moduleSpecifier.text}`);
          else {
            const from = boundary(file.fileName);
            const to = boundary(target.resolvedFileName);
            if (from !== to && !allowed[from]?.includes(to)) violations.push(`${from} -> ${to}`);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)))
      )
        unsupported.push(`${relative(root, file.fileName)}: dynamic source loading`);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const fn of functions.keys()) {
    const calls = new Set();
    const visit = (node) => {
      if (node !== fn && isCallable(node)) return;
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (functions.has(declaration)) calls.add(declaration);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    edges.set(fn, calls);
  }
  const index = sourceFiles.find((file) => localPath(file.fileName) === 'src/index.ts');
  const module = index && checker.getSymbolAtLocation(index);
  const exports = module ? checker.getExportsOfModule(module) : [];
  const reach = (name) => {
    let symbol = exports.find((item) => item.name === name);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    let start = symbol?.valueDeclaration;
    if (start && ts.isVariableDeclaration(start)) start = start.initializer;
    const reached = new Set();
    const queue = start ? [start] : [];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (reached.has(current)) continue;
      reached.add(current);
      queue.push(...(edges.get(current) ?? []));
    }
    return reached;
  };
  const results = [
    {
      id: 'declared-dependency-directions',
      category: 'architecture',
      pass: violations.length === 0,
      detail: [...new Set(violations)].join(', '),
    },
    {
      id: 'supported-static-module-coverage',
      category: 'architecture',
      pass: unsupported.length === 0,
      detail: unsupported.join(', '),
    },
  ];
  const sharedOwner = (names, owner) => {
    const sets = names.map(reach);
    return [...sets[0]].some(
      (fn) => functions.has(fn) && boundary(functions.get(fn)) === owner && sets.every((set) => set.has(fn)),
    );
  };
  if (taskId === 'shared-rule')
    results.push({
      id: 'shared-cancellation-owner',
      category: 'ownership',
      pass: sharedOwner(['cancelFromWeb', 'cancelFromAdmin', 'cancelFromJob'], 'reservations'),
    });
  if (taskId === 'separate-responsibilities')
    results.push({
      id: 'shared-quote-owner',
      category: 'ownership',
      pass: sharedOwner(['checkoutQuote', 'supportQuote'], 'pricing'),
    });
  if (taskId === 'dependency-direction' && phase === 'follow-up')
    results.push({
      id: 'shared-domain-shipping-owner',
      category: 'ownership',
      pass: sharedOwner(['webShippingQuote', 'batchShippingQuote'], 'domain'),
    });
  return results;
}

export function compareChangeTrials(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = JSON.stringify([
      trial.suiteId,
      trial.suiteDigest,
      trial.evaluatorDigest,
      trial.toolDigest,
      trial.baselineCommit,
      trial.taskId,
      trial.model,
      trial.reasoning,
      trial.timeoutMs,
      trial.repetition,
    ]);
    const group = groups.get(key) ?? {};
    if (group[trial.mode]) throw new Error(`Duplicate ${trial.mode} trial for ${key}`);
    group[trial.mode] = trial;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    if (!group.control || !group.treatment) throw new Error('Comparison requires matched control and treatment trials');
    const summarize = (trial) => ({
      completed: trial.status === 'completed',
      initialPass: trial.phases.find((phase) => phase.phase === 'initial')?.evaluation.pass ?? false,
      followUpPass: trial.phases.find((phase) => phase.phase === 'follow-up')?.evaluation.pass ?? false,
      inputTokens:
        trial.status === 'completed'
          ? trial.phases.reduce((sum, phase) => sum + phase.execution.usage.inputTokens, 0)
          : null,
      cachedInputTokens:
        trial.status === 'completed'
          ? trial.phases.reduce((sum, phase) => sum + phase.execution.usage.cachedInputTokens, 0)
          : null,
      outputTokens:
        trial.status === 'completed'
          ? trial.phases.reduce((sum, phase) => sum + phase.execution.usage.outputTokens, 0)
          : null,
      durationMs: trial.status === 'completed' ? trial.phases.reduce((sum, phase) => sum + phase.durationMs, 0) : null,
      indexDurationMs: trial.indexDurationMs,
      failedObligations: trial.phases.flatMap((phase) =>
        phase.evaluation.obligations.filter((item) => !item.pass).map((item) => `${phase.phase}:${item.id}`),
      ),
    });
    return {
      taskId: group.control.taskId,
      repetition: group.control.repetition,
      model: group.control.model,
      reasoning: group.control.reasoning,
      control: summarize(group.control),
      treatment: summarize(group.treatment),
    };
  });
}
