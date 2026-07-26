/**
 * One operating-system process instance. A PID alone names a reusable slot;
 * the start token distinguishes successive processes that occupy that slot.
 */
export interface ProcessIdentity {
  version: 1;
  pid: number;
  platform: NodeJS.Platform;
  startToken: string;
}

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

export function parseProcessIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<ProcessIdentity>;
  if (
    identity.version !== 1 ||
    typeof identity.pid !== 'number' ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.platform !== 'string' ||
    !NODE_PLATFORMS.has(identity.platform as NodeJS.Platform) ||
    typeof identity.startToken !== 'string' ||
    identity.startToken.trim() === ''
  ) {
    return null;
  }
  return {
    version: 1,
    pid: identity.pid,
    platform: identity.platform as NodeJS.Platform,
    startToken: identity.startToken,
  };
}

export function sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return (
    expected.version === actual.version &&
    expected.pid === actual.pid &&
    expected.platform === actual.platform &&
    expected.startToken === actual.startToken
  );
}
