import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { dirname } from 'node:path';

export interface SanyActionFacts {
  name: string;
  reads: string[];
  writes: string[];
}

export interface SanyModuleFacts {
  modelParse: 'sany';
  variables: string[];
  operators: string[];
  actions: SanyActionFacts[];
}

export interface SanyXmlExportOptions {
  specPath: string;
  jarPath: string;
  spawnSync?: typeof nodeSpawnSync;
}

export function exportSanyXml(opts: SanyXmlExportOptions): string | null {
  const spawnSync = opts.spawnSync ?? nodeSpawnSync;
  // XMLExporter writes the parse tree to STDOUT; its `-o` flag means
  // "offline" (skip network DTD validation), NOT an output path. Run from
  // the spec's directory so EXTENDS of sibling modules resolve.
  const result = spawnSync('java', ['-cp', opts.jarPath, 'tla2sany.xml.XMLExporter', '-o', opts.specPath], {
    encoding: 'utf8',
    cwd: dirname(opts.specPath),
    maxBuffer: 1024 * 1024 * 32,
  });
  if (result.status !== 0) return null;
  const stdout = result.stdout ?? '';
  return stdout.includes('<?xml') ? stdout : null;
}

/**
 * Parse SANY's XMLExporter output (real grammar, verified against
 * tla2tools v1.8.0): the `<context>` holds `<entry>` blocks pairing a
 * `<UID>` with a node — `<OpDeclNode>` (declaration; `<kind>3</kind>` =
 * VARIABLE, 2 = CONSTANT) or `<UserDefinedOpKind>` (operator definition)
 * — each carrying a `<uniquename>` CHILD ELEMENT (not attributes). Operator
 * bodies reference declarations via `<OpDeclNodeRef><UID>n</UID>`;
 * priming appears as a `BuiltInKindRef` to the builtin named `'` followed
 * by the primed variable's ref, and `UNCHANGED`/`$Tuple` runs pin
 * variables that are explicitly NOT written (and not reads either).
 */
export function parseSanyXmlFacts(xml: string): SanyModuleFacts {
  const entries = parseContextEntries(xml);
  const variableByUid = new Map<string, string>();
  const builtinByUid = new Map<string, string>();
  const operatorEntries: ContextEntry[] = [];

  for (const entry of entries) {
    if (entry.type === 'OpDeclNode' && entry.kind === 3 && entry.uniquename) {
      variableByUid.set(entry.uid, entry.uniquename);
    } else if (entry.type === 'BuiltInKind' && entry.uniquename) {
      builtinByUid.set(entry.uid, entry.uniquename);
    } else if (entry.type === 'UserDefinedOpKind' && entry.uniquename) {
      operatorEntries.push(entry);
    }
  }

  const actions: SanyActionFacts[] = [];
  for (const operator of operatorEntries) {
    const facts = deriveActionFacts(operator.block, variableByUid, builtinByUid);
    actions.push({ name: operator.uniquename!, reads: facts.reads, writes: facts.writes });
  }

  return {
    modelParse: 'sany',
    variables: [...variableByUid.values()].sort(),
    operators: operatorEntries.map((entry) => entry.uniquename!).sort(),
    actions,
  };
}

interface ContextEntry {
  uid: string;
  type: string;
  uniquename: string | null;
  kind: number | null;
  /** Raw text of the whole entry block, for body reference walking. */
  block: string;
}

function parseContextEntries(xml: string): ContextEntry[] {
  const entries: ContextEntry[] = [];
  const pattern = /<entry>\s*<UID>(\d+)<\/UID>\s*<(\w+)>/g;
  for (const match of xml.matchAll(pattern)) {
    const start = match.index!;
    const end = xml.indexOf('</entry>', start);
    const block = xml.slice(start, end < 0 ? xml.length : end);
    const uniquename = firstElementText(block, 'uniquename');
    const kindText = firstElementText(block, 'kind');
    entries.push({
      uid: match[1]!,
      type: match[2]!,
      uniquename: uniquename === null ? null : decodeXmlEntity(uniquename),
      kind: kindText === null ? null : Number.parseInt(kindText, 10),
      block,
    });
  }
  return entries;
}

function deriveActionFacts(
  block: string,
  variableByUid: ReadonlyMap<string, string>,
  builtinByUid: ReadonlyMap<string, string>,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  // Walk the ordered reference sequence of the operator body.
  const refs = [...block.matchAll(/<(\w+Ref)>\s*<UID>(\d+)<\/UID>/g)];
  let mode: 'read' | 'write-next' | 'unchanged-run' = 'read';
  for (const [, refType, uid] of refs) {
    if (refType === 'BuiltInKindRef') {
      const builtin = builtinByUid.get(uid!) ?? '';
      if (builtin === "'") mode = 'write-next';
      else if (builtin === 'UNCHANGED') mode = 'unchanged-run';
      else if (mode === 'unchanged-run' && builtin === '$Tuple') {
        // Tuple wrapper inside an UNCHANGED run: stay in the run.
      } else if (mode !== 'write-next') mode = 'read';
      continue;
    }
    if (refType === 'OpDeclNodeRef') {
      const variable = variableByUid.get(uid!);
      if (!variable) continue;
      if (mode === 'write-next') {
        writes.add(variable);
        mode = 'read';
      } else if (mode === 'unchanged-run') {
        // Explicitly unchanged: neither a read nor a write.
      } else {
        reads.add(variable);
      }
      continue;
    }
    // Any other reference (operator calls, module refs) ends an UNCHANGED run.
    if (mode === 'unchanged-run') mode = 'read';
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

function firstElementText(block: string, element: string): string | null {
  const match = block.match(new RegExp(`<${element}>([^<]*)</${element}>`));
  return match ? match[1]! : null;
}

function decodeXmlEntity(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
