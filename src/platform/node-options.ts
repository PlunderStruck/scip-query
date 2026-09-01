/**
 * Child analysis processes get their own V8 heap bound, but the parent's other
 * NODE_OPTIONS (a `--require` preload, inspector or diagnostic flags, a
 * user-set option) must survive the handoff: replacing the variable wholesale
 * silently drops them, which is how a memory probe attached to the parent
 * never sees a child.
 */

export function inheritedMaxOldSpaceMb(nodeOptions: string | undefined): number | undefined {
  const match = nodeOptions?.match(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/u);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The parent's NODE_OPTIONS with any heap bound replaced by `maxHeapMb`. */
export function nodeOptionsWithMaxOldSpace(nodeOptions: string | undefined, maxHeapMb: number): string {
  const preserved = (nodeOptions ?? '').replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/gu, ' ').trim();
  return [preserved, `--max-old-space-size=${maxHeapMb}`].filter(Boolean).join(' ');
}
