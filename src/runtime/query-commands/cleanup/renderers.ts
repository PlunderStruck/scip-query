import type { dead } from '../../../queries/index.js';
import { displayRange } from '../../render.js';

export function renderDeadGroup(
  rows: ReturnType<typeof dead>['symbols'],
  title: string,
  explanation: string,
  loc: number,
): void {
  console.log(`═══ ${title} (${rows.length}, ${loc} LOC) ═══`);
  console.log(explanation);
  console.log('');
  const byFile = new Map<string, typeof rows>();
  for (const s of rows) {
    const bucket = byFile.get(s.relativePath) ?? [];
    bucket.push(s);
    byFile.set(s.relativePath, bucket);
  }
  const fileOrder = [...byFile.entries()]
    .map(([file, bucket]) => ({
      file,
      bucket,
      totalLoc: bucket.reduce((sum, s) => sum + s.loc, 0),
    }))
    .sort((a, b) => b.totalLoc - a.totalLoc || a.file.localeCompare(b.file));

  let first = true;
  for (const { file, bucket } of fileOrder) {
    if (!first) console.log('');
    first = false;
    console.log(`  ${file}`);
    bucket.sort((a, b) => a.startLine - b.startLine);
    for (const s of bucket) {
      console.log(`    ${displayRange(s.startLine, s.endLine)}  (${s.loc} LOC)  ${s.shortName}`);
    }
  }
}
