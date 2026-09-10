import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

async function graph(source: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-accuracy-'));
  try {
    writeFixtureFiles(root, { 'flow.ts': source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'flow.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      return await collectRuntimeBoundaryGraph(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('runtime boundary identity and binding accuracy', () => {
  it('retains repeated operations on one line', async () => {
    const result = await graph(['export function run() { fetch("/same"); fetch("/same"); }']);
    const calls = result.observations.filter((observation) => observation.action === 'http.request');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  it('assigns a same-line operation to its actual source callable', async () => {
    const result = await graph([
      'export function first() { return 1; } export function second() { return fetch("/second"); }',
    ]);
    expect(
      result.observations
        .filter((observation) => observation.action === 'http.request')
        .map((observation) => observation.owner.name),
    ).toEqual(['second']);
  });

  it('does not treat a shadowing parameter as the imported process spawner', async () => {
    const result = await graph([
      'import { spawn } from "node:child_process";',
      'export function actual() { spawn("node", []); }',
      'export function local(spawn: Function) { spawn("node", []); }',
    ]);
    expect(
      result.observations
        .filter((observation) => observation.action === 'process.spawn')
        .map((observation) => observation.owner.name),
    ).toEqual(['actual']);
  });

  it('does not treat a local fetch implementation as an HTTP crossing', async () => {
    const result = await graph(['export function local(fetch: Function) { return fetch("/local"); }']);
    expect(result.observations.filter((observation) => observation.action === 'http.request')).toEqual([]);
  });

  it('reads the effective fetch method instead of a nested or overwritten method property', async () => {
    const result = await graph([
      'export function run() {',
      ' fetch("/nested", { headers: { method: "POST" } });',
      ' fetch("/override", { method: "POST", method: "GET" });',
      '}',
    ]);
    const calls = result.observations.filter((observation) => observation.action === 'http.request');
    expect(calls.map((call) => call.keyParts.find((key) => key.name === 'method')?.value)).toEqual(['GET', 'GET']);
  });

  it('resolves axios aliases without accepting a shadowing local receiver', async () => {
    const result = await graph([
      'import client from "axios";',
      'const alias = client;',
      'export function actual() { alias.post("/actual", {}); }',
      'export function shadowed(client: any) { client.post("/local", {}); }',
    ]);
    expect(result.observations.filter((item) => item.action === 'http.request').map((item) => item.owner.name)).toEqual(
      ['actual'],
    );
  });

  it('does not turn an unrelated app object into an imported framework router', async () => {
    const result = await graph([
      'import express from "express";',
      'const app = express();',
      'export function actual() { app.get("/actual", () => 1); }',
      'export function shadowed(app: any) { app.get("/local", () => 2); }',
    ]);
    expect(result.observations.filter((item) => item.action === 'http.handle').map((item) => item.owner.name)).toEqual([
      'actual',
    ]);
  });

  it('retains uncertainty for opaque options and respects later explicit overrides', async () => {
    const result = await graph([
      'export function run(options: any) {',
      'fetch("/unknown", options); fetch("/spread", { method: "GET", ...options });',
      'fetch("/known", { ...options, method: "POST" });',
      '}',
    ]);
    const calls = result.observations.filter((item) => item.action === 'http.request');
    expect(calls.map((item) => item.keyParts.find((part) => part.name === 'method')?.value)).toEqual([
      undefined,
      undefined,
      'POST',
    ]);
    expect(calls.slice(0, 2).map((item) => item.strength)).toEqual(['candidate', 'candidate']);
  });

  it('does not collapse slash-sensitive HTTP paths', async () => {
    const result = await graph([
      'import fastify from "fastify";',
      'const server = fastify();',
      'server.get("/path", () => 1); fetch("/path/");',
    ]);
    expect(result.observations.filter((item) => item.action === 'http.handle')).toHaveLength(1);
    expect(result.links.filter((link) => link.joinRule === 'http.method-path')).toEqual([]);
  });

  it('retains a constant request path after an unrelated property write', async () => {
    const result = await graph([
      'export function run() {',
      ' const route = { path: "/original", count: 0 }; route.count++;',
      ' fetch(route.path);',
      '}',
    ]);
    const request = result.observations.find((item) => item.action === 'http.request');
    expect(request?.keyParts.find((part) => part.name === 'path')?.value).toBe('/original');
  });

  it.each([
    '(route).path = "/replacement";',
    '(route as typeof route).path = "/replacement";',
    'const alias = (route); alias.path = "/replacement";',
  ])('does not retain an obsolete request path after %s', async (write) => {
    const result = await graph([
      'export function run() {',
      ' const route = { path: "/original" };',
      write,
      ' fetch(route.path);',
      '}',
    ]);
    const request = result.observations.find((item) => item.action === 'http.request');
    expect(request).toBeDefined();
    expect(request?.keyParts.find((part) => part.name === 'path')?.value).not.toBe('/original');
  });

  it('does not join shadowed registry objects with the same spelling', async () => {
    const result = await graph([
      'const handlers = { run: () => 1 };',
      'export function actual() { return handlers["run"](); }',
      'export function unrelated(handlers: any) { return handlers["run"](); }',
    ]);
    const dispatches = result.observations.filter((item) => item.action === 'registry.dispatch');
    const actual = dispatches.find((item) => item.owner.name === 'actual')!;
    const unrelated = dispatches.find((item) => item.owner.name === 'unrelated')!;
    expect(actual).toBeDefined();
    expect(unrelated).toBeDefined();
    expect(result.links.some((link) => link.from === actual.id)).toBe(true);
    expect(result.links.some((link) => link.from === unrelated.id)).toBe(false);
  });
  it('keeps equal HTTP paths as possible peers without inventing a deployment identity', async () => {
    const result = await graph([
      'import fastify from "fastify";',
      'const first = fastify(); const second = fastify();',
      'first.get("/same", () => 1); second.get("/same", () => 2);',
      'fetch("/same");',
    ]);
    const links = result.links.filter((link) => link.joinRule === 'http.method-path');
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.strength === 'candidate')).toBe(true);
    expect(result.observations.every((item) => item.resolution !== 'locally-linked')).toBe(true);
    expect(result.frontiers.some((item) => item.reason.includes('deployment'))).toBe(true);
  });

  it('does not prove persistence from a local receiver named db', async () => {
    const result = await graph([
      'const db = new Map<string, string>();',
      'export function run() { return db.get("users"); }',
    ]);
    expect(
      result.observations.filter((item) => item.action.startsWith('database.') && item.strength !== 'candidate'),
    ).toEqual([]);
  });

  it('does not prove queue operations from an unrelated package import', async () => {
    const result = await graph([
      'import { connect } from "amqplib";',
      'const local = { sendToQueue(name: string) { return name; } };',
      'local.sendToQueue("jobs");',
    ]);
    expect(
      result.observations.filter((item) => item.action.startsWith('queue.') && item.strength !== 'candidate'),
    ).toEqual([]);
  });

  it('uses the last registry member and retains uncertainty after a spread', async () => {
    const result = await graph([
      'declare const extra: any;',
      'const handlers = { run: () => 1, run: () => 2 };',
      'const uncertainHandlers = { run: () => 3, ...extra };',
      'handlers["run"](); uncertainHandlers["run"]();',
    ]);
    const handlers = result.observations.filter(
      (item) => item.action === 'registry.handle' && item.strength !== 'candidate',
    );
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.source.startColumn).toBeGreaterThan(30);
    expect(result.links.filter((link) => link.joinRule === 'registry.identity-key')).toHaveLength(1);
  });

  it('resolves Effect imports by binding and rejects shadowed or type-only endpoint names', async () => {
    const result = await graph([
      'import { HttpApiEndpoint as Endpoint, HttpApiGroup as Group } from "effect/unstable/httpapi";',
      'import type { HttpApiEndpoint as TypeEndpoint } from "effect/unstable/httpapi";',
      'const alias = Endpoint;',
      'const actual = Group.make("group").add(alias.get("actual", "/actual"));',
      'function shadowed(Endpoint: any) { return Group.make("group").add(Endpoint.get("wrong", "/wrong")); }',
      'const typeOnly = Group.make("group").add(TypeEndpoint.get("type", "/type"));',
    ]);
    const endpoints = result.observations.filter((item) => item.action === 'http.handle');
    expect(endpoints.map((item) => item.keyParts.find((part) => part.name === 'path')?.value)).toEqual(['/actual']);
  });
  it('mounts only the selected router and rejects a shadowing use receiver', async () => {
    const result = await graph([
      'import express from "express";',
      'const app = express(); const selected = express.Router(); const sibling = express.Router();',
      'selected.get("/chosen", () => 1); sibling.get("/other", () => 2);',
      'app.use("/api", selected);',
      'function shadowed(app: any) { app.use("/false", selected); }',
    ]);
    const mounted = result.observations.filter((item) => item.evidence === 'framework-mount-composition');
    expect(mounted.map((item) => item.keyParts.find((part) => part.name === 'path')?.value)).toEqual(['/api/chosen']);
    expect(result.observations.find((item) => item.keyParts.some((part) => part.value === '/other'))?.strength).toBe(
      'exact',
    );
  });
  it('evaluates the declaration bound at each constant reference', async () => {
    const result = await graph([
      'const path = "/outer";',
      'export function run() { const path = "/inner"; return fetch(path); }',
      'const config = { path: "/global" };',
      'export function shadowed(config: any) { return fetch(config.path); }',
    ]);
    const requests = result.observations.filter((item) => item.action === 'http.request');
    expect(
      requests.find((item) => item.owner.name === 'run')?.keyParts.find((part) => part.name === 'path')?.value,
    ).toBe('/inner');
    expect(requests.find((item) => item.owner.name === 'shadowed')?.strength).toBe('candidate');
  });

  it('does not evaluate an overwritten object member as its initializer value', async () => {
    const result = await graph(['const routes = { path: "/old" };', 'routes.path = "/new";', 'fetch(routes.path);']);
    expect(
      result.observations.filter((item) => item.action === 'http.request' && item.strength !== 'candidate'),
    ).toEqual([]);
  });

  it('evaluates the effective constant-object field after duplicate keys and spreads', async () => {
    const result = await graph([
      'const routes = { path: "/old", path: "/new" };',
      'declare const extra: any;',
      'const uncertain = { path: "/old", ...extra };',
      'fetch(routes.path); fetch(uncertain.path);',
    ]);
    const requests = result.observations.filter((item) => item.action === 'http.request');
    expect(requests[0]!.keyParts.find((part) => part.name === 'path')?.value).toBe('/new');
    expect(requests[1]!.strength).toBe('candidate');
  });

  it('does not preserve an initial registry handler after an explicit member replacement', async () => {
    const result = await graph(['const handlers = { run: () => 1 };', 'handlers.run = () => 2;', 'handlers["run"]();']);
    expect(
      result.links.filter((link) => link.joinRule === 'registry.identity-key' && link.strength !== 'candidate'),
    ).toEqual([]);
  });

  it('composes every nested and repeated mount without mixing router instances', async () => {
    const result = await graph([
      'import express from "express";',
      'const app = express(); const parent = express.Router(); const child = express.Router();',
      'child.get("/leaf", () => 1);',
      'app.use("/v1", parent); app.use("/v2", parent); parent.use("/nested", child);',
    ]);
    const paths = result.observations
      .filter((item) => item.evidence === 'framework-mount-composition')
      .map((item) => item.keyParts.find((part) => part.name === 'path')?.value)
      .sort();
    expect(paths).toEqual(['/nested/leaf', '/v1/nested/leaf', '/v2/nested/leaf']);
  });

  it('retains aliases and constant synchronous returns while rejecting alias mutations', async () => {
    const result = await graph([
      'const routes = { path: "/safe" }; const alias = routes;',
      'const other = { path: "/old" }; const changed = other; changed.path = "/new";',
      'function path() { const suffix = "/sync"; return suffix; }',
      'const call = path;',
      'fetch(alias.path); fetch(call()); fetch(other.path);',
    ]);
    const requests = result.observations.filter((item) => item.action === 'http.request');
    expect(requests.slice(0, 2).map((item) => item.keyParts.find((part) => part.name === 'path')?.value)).toEqual([
      '/safe',
      '/sync',
    ]);
    expect(requests[2]!.strength).toBe('candidate');
  });

  it('reports cyclic mounts and unresolved factory results as stopped proofs', async () => {
    const result = await graph([
      'import express from "express";',
      'const app = express(); const router = express.Router();',
      'router.get("/leaf", () => 1); app.use("/api", router); router.use("/cycle", app);',
      'declare function factory(): any; app.use("/dynamic", factory());',
    ]);
    expect(result.frontiers.some((item) => item.reason === 'http-mount-cycle')).toBe(true);
    expect(result.frontiers.some((item) => item.reason === 'http-mount-target-unresolved')).toBe(true);
    expect(result.observations.filter((item) => item.evidence === 'framework-mount-composition')).toHaveLength(1);
  });
  it('does not equate mentioning a tool in instruction text with invoking its implementation', async () => {
    const result = await graph([
      'export const tool = { def: { name: "stop_process" }, execute() { return 1; } };',
      'export function docs() { return "Use stop_process() to stop."; }',
    ]);
    expect(
      result.links.filter((link) => link.joinRule === 'registry.capability-key' && link.strength !== 'candidate'),
    ).toEqual([]);
  });
  it('recognizes legal comments in framework imports when composing mounts', async () => {
    const result = await graph([
      'import express from /* dependency */ "express";',
      'const app = express(); const router = express.Router();',
      'router.get("/leaf", () => 1); app.use("/api", router);',
    ]);
    expect(
      result.observations
        .filter((item) => item.evidence === 'framework-mount-composition')
        .map((item) => item.keyParts.find((part) => part.name === 'path')?.value),
    ).toEqual(['/api/leaf']);
  });

  it('composes a router mounted without an explicit path', async () => {
    const result = await graph([
      'import express from "express";',
      'const app = express(); const parent = express.Router(); const child = express.Router();',
      'child.get("/leaf", () => 1); app.use("/api", parent); parent.use(child);',
    ]);
    expect(
      result.observations
        .filter((item) => item.evidence === 'framework-mount-composition')
        .map((item) => item.keyParts.find((part) => part.name === 'path')?.value)
        .sort(),
    ).toEqual(['/api/leaf', '/leaf']);
  });
});
