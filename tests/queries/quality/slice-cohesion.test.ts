import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { sliceCohesion } from '../../../src/queries/quality/slice-cohesion.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const sym = (file: string, leaf: string) => `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${leaf}().`;

/**
 * `summarizeOrders` builds two unrelated results from the same input: the
 * taxed totals (and their grand total) and the trimmed labels. Nothing
 * computed for one is read by the other. `invoiceTotal` is one computation
 * with a guard in the middle: both returned fields derive from `rounded`.
 * `fillBuckets` mutates a parameter through an alias obtained from
 * `map.get`, so its bucket writes are effects on the caller's map.
 */
const ORDERS = [
  'interface Order { amount: number; label?: string; group: string }',
  '',
  'export function summarizeOrders(orders: Order[], taxRate: number) {',
  '  const totals: number[] = [];',
  '  for (const order of orders) {',
  '    totals.push(order.amount * (1 + taxRate));',
  '  }',
  '  const labels: string[] = [];',
  '  for (const order of orders) {',
  '    if (order.label) labels.push(order.label.trim());',
  '  }',
  '  const grand = totals.reduce((sum, value) => sum + value, 0);',
  '  return { totals, labels, grand };',
  '}',
  '',
  'export function invoiceTotal(orders: Order[], taxRate: number) {',
  '  let subtotal = 0;',
  '  for (const order of orders) {',
  '    subtotal += order.amount;',
  '  }',
  '  const tax = subtotal * taxRate;',
  '  const total = subtotal + tax;',
  "  if (total < 0) throw new Error('negative');",
  '  const rounded = Math.round(total * 100) / 100;',
  '  const label = `${rounded}`;',
  '  return { total: rounded, label };',
  '}',
  '',
  'export function fillBuckets(target: Map<string, Order[]>, orders: Order[]): number {',
  '  let placed = 0;',
  '  for (const order of orders) {',
  '    let bucket = target.get(order.group);',
  '    if (!bucket) {',
  '      bucket = [];',
  '      target.set(order.group, bucket);',
  '    }',
  '    bucket.push(order);',
  '    placed += 1;',
  '  }',
  '  return placed;',
  '}',
];

/**
 * `syncOrders` logs and rethrows inside a catch block: failure handling for
 * the request beside it, not a second computation. `describeOrder` returns
 * from several branches: alternatives of one return value. `runAll`
 * sequences independent operations: an orchestration root.
 */
const HANDLERS = [
  'import { logger, client, audit, metrics } from "./deps";',
  'interface Order { id: string; amount: number; tags: string[] }',
  '',
  'export async function syncOrders(orders: Order[], region: string) {',
  '  const payload = orders.map((order) => ({ id: order.id, amount: order.amount }));',
  '  const endpoint = `/regions/${region}/orders`;',
  '  let synced = 0;',
  '  try {',
  '    const response = await client.post(endpoint, payload);',
  '    synced = response.count;',
  '    await audit.record(region, synced);',
  '  } catch (error) {',
  '    const message = `sync failed for ${region}`;',
  '    logger.error(message, error);',
  '    metrics.increment("sync.failure");',
  '    throw error;',
  '  }',
  '  const tags = new Set<string>();',
  '  for (const order of orders) {',
  '    for (const tag of order.tags) tags.add(tag);',
  '  }',
  '  const summary = [...tags].sort().join(",");',
  '  return { synced, summary };',
  '}',
  '',
  'export function describeOrder(order: Order, verbose: boolean) {',
  '  if (!order) return null;',
  '  const amount = order.amount.toFixed(2);',
  '  const tags = order.tags.join(", ");',
  '  const heading = `Order ${order.id}`;',
  '  if (verbose) {',
  '    const detail = `${heading}: ${amount} [${tags}]`;',
  '    return detail;',
  '  }',
  '  const short = `${heading}: ${amount}`;',
  '  const suffix = order.tags.length > 0 ? " (tagged)" : "";',
  '  const line = short + suffix;',
  '  return line;',
  '}',
  '',
  'export async function copyText(text: string): Promise<boolean> {',
  '  if (navigator?.clipboard?.writeText) {',
  '    try {',
  '      await navigator.clipboard.writeText(text);',
  '      return true;',
  '    } catch (error) {',
  '      logger.warn("modern clipboard failed", error);',
  '    }',
  '  }',
  '  try {',
  '    const area = document.createElement("textarea");',
  '    area.value = text;',
  '    area.style.position = "fixed";',
  '    document.body.appendChild(area);',
  '    area.select();',
  '    const successful = document.execCommand("copy");',
  '    document.body.removeChild(area);',
  '    return successful;',
  '  } catch (error) {',
  '    logger.error("fallback copy failed", error);',
  '    return false;',
  '  }',
  '}',
  '',
  'export async function notifyUser(userId: string, event: string) {',
  '  const empty = { status: "skipped", logId: null };',
  '  const pending = await client.reserve(userId, event);',
  '  if (!pending) return empty;',
  '  const logId = pending.id;',
  '  const recipient = await client.getRecipient(userId);',
  '  if (!recipient) {',
  '    logger.warn("suppressed", logId);',
  '    return audit.suppress(logId, "missing");',
  '  }',
  '  if (recipient.optedOut) {',
  '    logger.warn("suppressed", logId);',
  '    return audit.suppress(logId, "opted-out");',
  '  }',
  '  const message = `${event} for ${recipient.name}`;',
  '  const delivery = await client.send(recipient.address, message);',
  '  const status = delivery.ok ? "sent" : "failed";',
  '  await audit.record(logId, status);',
  '  return { status, logId };',
  '}',
  '',
  'export async function runAll(region: string) {',
  '  const users = await client.get(`/regions/${region}/users`);',
  '  const activeUsers = users.filter((user) => user.active);',
  '  const userCount = activeUsers.length;',
  '  await audit.record("users", userCount);',
  '  const orders = await client.get(`/regions/${region}/orders`);',
  '  const openOrders = orders.filter((order) => order.open);',
  '  const orderCount = openOrders.length;',
  '  await audit.record("orders", orderCount);',
  '  const invoices = await client.get(`/regions/${region}/invoices`);',
  '  const dueInvoices = invoices.filter((invoice) => invoice.due);',
  '  const invoiceCount = dueInvoices.length;',
  '  await audit.record("invoices", invoiceCount);',
  '}',
];

/**
 * `ResetDialog` wipes its own state at render time whenever the target
 * changes: the render reads that state, so the reset belongs with it.
 * `Campaigns` runs an effect that only reads router state and notifies: a
 * hook candidate whose parameters are the two hook-derived locals, while
 * the imported components and the `div` tag are not parameters.
 */
const COMPONENTS = [
  'import { useState, useEffect, useCallback } from "react";',
  'import { Button, Dialog } from "./ui";',
  'import { useRouter, useSearchParams } from "./navigation";',
  'import { notify } from "./notify";',
  'declare const CHANNELS: { DEFAULT: string };',
  '',
  'export function ResetDialog({ pending }: { pending: { id: string } | null }) {',
  '  const [channel, setChannel] = useState(CHANNELS.DEFAULT);',
  '  const [notes, setNotes] = useState("");',
  '  const formFor = pending ? pending.id : null;',
  '  const [shownFor, setShownFor] = useState<string | null>(null);',
  '  if (formFor !== shownFor) {',
  '    setShownFor(formFor);',
  '    setChannel(CHANNELS.DEFAULT);',
  '    setNotes("");',
  '  }',
  '  const canSubmit = notes.trim().length > 0;',
  '  const title = pending ? `Resolve ${pending.id}` : "Resolve";',
  '  const body = `${channel}: ${notes}`;',
  '  const footer = canSubmit ? "ready" : "waiting";',
  '  return (',
  '    <Dialog title={title}>',
  '      <div>{body}</div>',
  '      <Button disabled={!canSubmit}>{footer}</Button>',
  '    </Dialog>',
  '  );',
  '}',
  '',
  'export function Campaigns({ items }: { items: { id: string; name: string }[] }) {',
  '  const router = useRouter();',
  '  const searchParams = useSearchParams();',
  '  const boostAuth = searchParams.get("boostAuth");',
  '  const platform = searchParams.get("platform");',
  '  const serialized = searchParams.toString();',
  '  useEffect(() => {',
  '    if (!boostAuth) return;',
  '    const label = platform === "meta" ? "Meta" : "Boost";',
  '    notify(`${label} connected: ${boostAuth}`);',
  '    const params = new URLSearchParams(serialized);',
  '    params.delete("boostAuth");',
  '    router.replace(`/campaigns?${params.toString()}`);',
  '  }, [boostAuth, platform, router, serialized]);',
  '  const sorted = [...items].sort((left, right) => left.name.localeCompare(right.name));',
  '  const names = sorted.map((item) => item.name);',
  '  const count = names.length;',
  '  const heading = `${count} campaigns`;',
  '  const subtitle = count === 1 ? "one campaign" : "campaigns";',
  '  const rows = names.map((name) => <div key={name}>{name}</div>);',
  '  const footer = `${heading} (${subtitle})`;',
  '  return (',
  '    <div>',
  '      <h1>{heading}</h1>',
  '      {rows}',
  '      <Button>{footer}</Button>',
  '    </div>',
  '  );',
  '}',
  '',
  'export function Loader({ url }: { url: string }) {',
  '  const [data, setData] = useState<string | null>(null);',
  '  const [tick, setTick] = useState(0);',
  '  const load = useCallback(async () => {',
  '    const response = await fetch(url);',
  '    const text = await response.text();',
  '    setData(text);',
  '  }, [url]);',
  '  useEffect(() => {',
  '    void load();',
  '  }, [load]);',
  '  useEffect(() => {',
  '    const id = setInterval(() => setTick((value) => value + 1), 1000);',
  '    return () => clearInterval(id);',
  '  }, []);',
  '  const label = data ? data.slice(0, 10) : "loading";',
  '  const status = `${label} (${tick})`;',
  '  const width = Math.min(100, tick * 5);',
  '  const style = { width: `${width}%` };',
  '  return (',
  '    <div style={style}>',
  '      <span>{status}</span>',
  '    </div>',
  '  );',
  '}',
];

function openFixture(): { db: ScipDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'scip-slice-cohesion-'));
  writeFixtureFiles(root, {
    'src/orders.ts': ORDERS,
    'src/handlers.ts': HANDLERS,
    'src/components.tsx': COMPONENTS,
    'scripts/run.ts': HANDLERS,
  });
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/orders.ts')
    .document(2, 'typescript', 'src/handlers.ts')
    .document(3, 'typescript', 'src/components.tsx')
    .document(4, 'typescript', 'scripts/run.ts')
    .symbol(1, sym('orders.ts', 'summarizeOrders'), 'summarizeOrders', SymbolInformation_Kind.Function)
    .symbol(2, sym('orders.ts', 'invoiceTotal'), 'invoiceTotal', SymbolInformation_Kind.Function)
    .symbol(3, sym('orders.ts', 'fillBuckets'), 'fillBuckets', SymbolInformation_Kind.Function)
    .symbol(4, sym('handlers.ts', 'syncOrders'), 'syncOrders', SymbolInformation_Kind.Function)
    .symbol(5, sym('handlers.ts', 'describeOrder'), 'describeOrder', SymbolInformation_Kind.Function)
    .symbol(6, sym('handlers.ts', 'runAll'), 'runAll', SymbolInformation_Kind.Function)
    .symbol(7, sym('components.tsx', 'ResetDialog'), 'ResetDialog', SymbolInformation_Kind.Function)
    .symbol(8, sym('components.tsx', 'Campaigns'), 'Campaigns', SymbolInformation_Kind.Function)
    .symbol(9, sym('run.ts', 'runAll'), 'runAll', SymbolInformation_Kind.Function)
    .symbol(10, sym('components.tsx', 'Loader'), 'Loader', SymbolInformation_Kind.Function)
    .symbol(11, sym('handlers.ts', 'copyText'), 'copyText', SymbolInformation_Kind.Function)
    .symbol(12, sym('handlers.ts', 'notifyUser'), 'notifyUser', SymbolInformation_Kind.Function)
    .definition(1, 1, 1, 2, 0, 13, 1)
    .definition(2, 1, 2, 15, 0, 26, 1)
    .definition(3, 1, 3, 28, 0, 40, 1)
    .definition(4, 2, 4, 3, 0, 23, 1)
    .definition(5, 2, 5, 25, 0, 38, 1)
    .definition(6, 2, 6, 84, 0, 97, 1)
    .definition(7, 3, 7, 6, 0, 26, 1)
    .definition(8, 3, 8, 28, 0, 57, 1)
    .definition(9, 4, 9, 84, 0, 97, 1)
    .definition(10, 3, 10, 59, 0, 84, 1)
    .definition(11, 2, 11, 40, 0, 62, 1)
    .definition(12, 2, 12, 64, 0, 82, 1)
    .chunk(1, 1, 0, ORDERS.length)
    .chunk(2, 2, 0, HANDLERS.length)
    .chunk(3, 3, 0, COMPONENTS.length)
    .chunk(4, 4, 0, HANDLERS.length)
    .mention(1, 1, 1)
    .mention(1, 2, 1)
    .mention(1, 3, 1)
    .mention(2, 4, 1)
    .mention(2, 5, 1)
    .mention(2, 6, 1)
    .mention(3, 7, 1)
    .mention(3, 8, 1)
    .mention(4, 9, 1)
    .mention(3, 10, 1)
    .mention(2, 11, 1)
    .mention(2, 12, 1)
    .write();
  const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
  return { db: new ScipDatabase(config), root };
}

function withFixture<T>(run: (db: ScipDatabase) => T): T {
  const { db, root } = openFixture();
  try {
    return run(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('slice-cohesion', () => {
  it('partitions a function whose outputs never share a statement and names the extraction interface', () => {
    withFixture((db) => {
      const results = sliceCohesion(db, { minLoc: 1, scope: 'orders.ts' });
      expect(results.map((result) => result.shortName)).toEqual([expect.stringContaining('summarizeOrders')]);
      const [candidate] = results;
      expect(candidate).toMatchObject({
        splitCandidate: true,
        actionTier: 'signal',
        archetype: 'calculation',
        operational: false,
        coverage: expect.objectContaining({ status: 'complete', model: 'function-local-flow' }),
      });
      // Scan results are compact: no per-unit listing and no slice arrays.
      expect(candidate!.units).toBeUndefined();
      expect(candidate!.outputs[0]!.slice).toBeUndefined();
      expect(candidate!.outputs.map((output) => output.id)).toEqual([
        'return.totals@13',
        'return.labels@13',
        'return.grand@13',
      ]);
      expect(candidate!.clusters).toHaveLength(2);
      const [totalsCluster, labelsCluster] = candidate!.clusters;
      expect(totalsCluster).toMatchObject({
        outputs: ['return.totals@13', 'return.grand@13'],
        inputs: ['orders', 'taxRate'],
        role: 'remainder',
        kind: 'calculation',
        guardOnly: false,
      });
      expect(totalsCluster!.lineRanges).toEqual([
        { startLine: 3, endLine: 5 },
        { startLine: 11, endLine: 11 },
      ]);
      expect(labelsCluster).toMatchObject({
        outputs: ['return.labels@13'],
        inputs: ['orders'],
        role: 'extraction',
        narrow: true,
      });
      expect(labelsCluster!.lineRanges).toEqual([{ startLine: 7, endLine: 9 }]);
      expect(candidate!.separableStatements).toBe(labelsCluster!.units.length);
      expect(candidate!.metrics.tightness).toBe(0);
      expect(candidate!.recommendation).toBe(
        'Extract from summarizeOrders: 1) pure calculation candidate: lines 8-10 producing return.labels from (orders). ' +
          'Stays in place: the largest computation (lines 4-6, line 12 producing return.totals, return.grand).',
      );
    });
  });

  it('keeps a single computation whole, treats exits as guards, and follows parameter aliases', () => {
    withFixture((db) => {
      const [invoice] = sliceCohesion(db, { symbol: 'invoiceTotal' });
      expect(invoice).toMatchObject({ splitCandidate: false, actionTier: 'support' });
      expect(invoice!.units).toBeDefined();
      expect(invoice!.outputs.find((output) => output.kind === 'throw')).toMatchObject({ guard: true });
      const valueOutputs = invoice!.outputs.filter((output) => !output.guard).map((output) => output.id);
      expect(valueOutputs).toEqual(['return.total@26', 'return.label@26']);
      expect(invoice!.clusters).toHaveLength(1);
      expect(invoice!.clusters[0]!.outputs).toEqual(valueOutputs);
      expect(invoice!.metrics.tightness).toBeGreaterThan(0);
      expect(invoice!.recommendation).toContain('keep the function whole');

      const [buckets] = sliceCohesion(db, { symbol: 'fillBuckets' });
      expect(buckets!.outputs.map((output) => [output.id, output.kind])).toEqual([
        ['call:target.set@35', 'effect-call'],
        ['write:target@37', 'mutation'],
        ['return@40', 'return'],
      ]);
      expect(buckets!.splitCandidate).toBe(false);
      expect(buckets!.orphans).toEqual([]);
    });
  });

  it('keeps catch-block failure handling with the try block it handles', () => {
    withFixture((db) => {
      const [sync] = sliceCohesion(db, { symbol: 'syncOrders' });
      expect(sync).toBeDefined();
      const handlerOutputs = sync!.outputs.filter((output) => output.line >= 12 && output.line <= 15);
      expect(handlerOutputs.length).toBeGreaterThanOrEqual(2);
      // The request and its failure handling are one cluster; the tag summary is the other.
      const requestCluster = sync!.clusters.find((cluster) => cluster.outputs.includes('return.synced@23'));
      expect(requestCluster).toBeDefined();
      for (const output of handlerOutputs) {
        if (output.guard) continue;
        expect(requestCluster!.outputs).toContain(output.id);
      }
      const summaryCluster = sync!.clusters.find((cluster) => cluster.outputs.includes('return.summary@23'));
      expect(summaryCluster).toMatchObject({ inputs: ['orders'], narrow: true, kind: 'calculation' });
      expect(sync!.clusters.map((cluster) => cluster.role).sort()).toEqual(['extraction', 'remainder']);
      expect(sync!.evidenceReasons).toContainEqual(
        expect.stringContaining('catch/finally statement(s) were kept with the try block they handle'),
      );
    });
  });

  it('treats every return statement as one return value and a script root as orchestration', () => {
    withFixture((db) => {
      const [describe] = sliceCohesion(db, { symbol: 'describeOrder' });
      expect(describe).toBeDefined();
      const returns = describe!.outputs.filter((output) => output.kind === 'return');
      expect(returns.filter((output) => output.guard).map((output) => output.id)).toEqual(['return@27']);
      const merged = returns.find((output) => !output.guard);
      expect(merged).toMatchObject({ id: 'return@33', units: expect.arrayContaining([]) });
      expect(merged!.units).toHaveLength(2);
      expect(describe!.splitCandidate).toBe(false);

      // Two strategies for one result share the return value, so the modern
      // attempt and the fallback are one computation.
      const [copy] = sliceCohesion(db, { symbol: 'copyText' });
      expect(copy).toMatchObject({ splitCandidate: false });
      expect(copy!.clusters).toHaveLength(1);
      expect(copy!.outputs.filter((output) => output.kind === 'return' && !output.guard)).toHaveLength(1);

      // `return empty`, log-then-return, and delegation before an exit are
      // guards, not computations to extract.
      const [notify] = sliceCohesion(db, { symbol: 'notifyUser' });
      expect(notify!.outputs.filter((output) => output.guard).map((output) => output.id)).toEqual([
        'return@68',
        'call:logger.warn@72',
        'return@73',
        'call:logger.warn@76',
        'return@77',
      ]);
      expect(notify).toMatchObject({ splitCandidate: false });
      expect(notify!.clusters.filter((cluster) => cluster.role === 'extraction')).toHaveLength(0);
      // The delivery computes a result while awaiting the client: not pure.
      expect(notify!.clusters[0]!.kind).toBe('operation');

      const [runAll] = sliceCohesion(db, { symbol: sym('handlers.ts', 'runAll') });
      expect(runAll).toMatchObject({ archetype: 'orchestration', actionTier: 'support', operational: false });
      expect(runAll!.tierReason).toContain('Orchestration root');
      expect(runAll!.recommendation).toContain('treat it as an orchestration root');
    });
  });

  it('models React state ownership, hook extractions, and parameter interfaces without imports', () => {
    withFixture((db) => {
      const [reset] = sliceCohesion(db, { symbol: 'ResetDialog' });
      expect(reset).toMatchObject({ archetype: 'react-component', splitCandidate: false });
      expect(reset!.evidenceReasons).toContainEqual(
        expect.stringContaining('state written at render time or in effects was treated as a dependency'),
      );
      // The render-time reset writes state the JSX reads, so both sit in one cluster.
      expect(reset!.clusters).toHaveLength(1);

      const [campaigns] = sliceCohesion(db, { symbol: 'Campaigns' });
      expect(campaigns).toMatchObject({ archetype: 'react-component', splitCandidate: true, actionTier: 'signal' });
      const effect = campaigns!.clusters.find((cluster) => cluster.role === 'extraction');
      expect(effect).toMatchObject({ kind: 'hook', narrow: true });
      expect(effect!.hooks).toEqual(['useRouter@30', 'useSearchParams@31', 'useEffect@35']);
      // Imports (`notify`, `URLSearchParams`), the router hook results, and JSX tags are not parameters.
      expect(effect!.inputs).toEqual([]);
      const render = campaigns!.clusters.find((cluster) => cluster.role === 'remainder');
      expect(render!.inputs).toEqual(['items']);
      expect(campaigns!.recommendation).toContain('custom hook candidate');

      // Effects that write state through a `useCallback` closure, a promise
      // continuation, or a timer own the state the JSX renders.
      const [loader] = sliceCohesion(db, { symbol: 'Loader' });
      expect(loader).toMatchObject({ archetype: 'react-component', splitCandidate: false });
      expect(loader!.clusters).toHaveLength(1);
      expect(loader!.evidenceReasons).toContainEqual(
        expect.stringMatching(/dependency of later reads: .*data.*tick|tick.*data/u),
      );
    });
  });

  it('ranks operational scripts after product code and returns nothing for an unknown symbol', () => {
    withFixture((db) => {
      expect(sliceCohesion(db, { symbol: 'noSuchFunction' })).toEqual([]);
      expect(sliceCohesion(db, { minLoc: 1, minStatements: 50 })).toEqual([]);
      const [cohesiveByThreshold] = sliceCohesion(db, { symbol: 'summarizeOrders', minClusterUnits: 6 });
      expect(cohesiveByThreshold).toMatchObject({ splitCandidate: false });
      expect(cohesiveByThreshold!.clusters).toHaveLength(2);
      expect(cohesiveByThreshold!.clusters.map((cluster) => cluster.role)).toEqual([
        'below-threshold',
        'below-threshold',
      ]);

      const all = sliceCohesion(db, { minLoc: 1 });
      const paths = all.map((candidate) => candidate.relativePath);
      const lastProduct = paths.map((path) => path.startsWith('src/')).lastIndexOf(true);
      const firstScript = paths.indexOf('scripts/run.ts');
      if (firstScript >= 0) expect(firstScript).toBeGreaterThan(lastProduct);
      expect(all.find((candidate) => candidate.relativePath === 'scripts/run.ts')?.operational).toBe(true);
    });
  });
});
