import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliVersion } from './cli-support.js';

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_NOTICE_CACHE_FILE = 'update-check.json';
const NPM_LATEST_URL = 'https://registry.npmjs.org/scip-query/latest';

interface UpdateNoticeCache {
  checkedAt: number;
  latestVersion: string | null;
}

export interface UpdateNoticeOptions {
  cacheDir?: string;
  commandName?: string;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  fetchLatestVersion?: () => Promise<string | null>;
  now?: number;
  writeNotice?: (message: string) => void;
}

export async function maybePrintUpdateNotice(opts: UpdateNoticeOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (env['SCIP_QUERY_UPDATE_CHECK'] === '0' || env['NO_UPDATE_NOTIFIER']) return;
  if (opts.commandName && isUpdateNoticeExemptCommand(opts.commandName)) return;

  const cacheDir = opts.cacheDir ?? resolveUpdateNoticeCacheDir(env);
  const now = opts.now ?? Date.now();
  const currentVersion = opts.currentVersion ?? cliVersion;
  const cached = readUpdateNoticeCache(cacheDir);
  const latestVersion =
    cached && now - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS
      ? cached.latestVersion
      : await refreshLatestVersion(cacheDir, opts.fetchLatestVersion ?? fetchLatestVersion, now);

  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return;

  const writeNotice = opts.writeNotice ?? ((message) => console.error(message));
  writeNotice(renderUpdateNotice(currentVersion, latestVersion));
}

function isUpdateNoticeExemptCommand(commandName: string): boolean {
  return commandName === 'hook-context' || commandName === 'hook-stop';
}

export function renderUpdateNotice(currentVersion: string, latestVersion: string): string {
  return [
    `scip-query update available: ${currentVersion} -> ${latestVersion}.`,
    'Agent: tell your human to update with: npm install -g scip-query@latest',
    '',
  ].join('\n');
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseSemver(candidate);
  const currentParts = parseSemver(current);
  if (!candidateParts || !currentParts) return candidate !== current;

  for (let i = 0; i < candidateParts.length; i++) {
    const diff = candidateParts[i]! - currentParts[i]!;
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

function resolveUpdateNoticeCacheDir(env: NodeJS.ProcessEnv): string {
  const base = env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
  return join(base, 'scip-query');
}

function readUpdateNoticeCache(cacheDir: string): UpdateNoticeCache | null {
  const cachePath = join(cacheDir, UPDATE_NOTICE_CACHE_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<UpdateNoticeCache>;
    return typeof raw.checkedAt === 'number' && (typeof raw.latestVersion === 'string' || raw.latestVersion === null)
      ? { checkedAt: raw.checkedAt, latestVersion: raw.latestVersion }
      : null;
  } catch {
    return null;
  }
}

async function refreshLatestVersion(
  cacheDir: string,
  fetchLatest: () => Promise<string | null>,
  now: number,
): Promise<string | null> {
  let latestVersion: string | null;
  try {
    latestVersion = await fetchLatest();
  } catch {
    latestVersion = null;
  }

  writeUpdateNoticeCache(cacheDir, { checkedAt: now, latestVersion });
  return latestVersion;
}

function writeUpdateNoticeCache(cacheDir: string, cache: UpdateNoticeCache): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, UPDATE_NOTICE_CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // Update checks should never make the CLI command fail.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const response = await fetch(NPM_LATEST_URL, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
