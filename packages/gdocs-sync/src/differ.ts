/**
 * Block diff planner (UDIFF-*): LCS over block identity (content, not
 * styling), with adjacent DELETE+INSERT pairs of the same kind fused
 * into MODIFY so a changed paragraph reads as one edit.
 */
import { identity, type CanonicalBlock } from './blocks.ts';

export type DiffOp =
  | { op: 'keep'; oldIndex: number; newIndex: number; block: CanonicalBlock }
  | { op: 'delete'; oldIndex: number; block: CanonicalBlock }
  | { op: 'insert'; newIndex: number; block: CanonicalBlock }
  | { op: 'modify'; oldIndex: number; newIndex: number; oldBlock: CanonicalBlock; newBlock: CanonicalBlock };

export function diffBlocks(oldBlocks: CanonicalBlock[], newBlocks: CanonicalBlock[]): DiffOp[] {
  const oldIds = oldBlocks.map(identity);
  const newIds = newBlocks.map(identity);
  const n = oldIds.length;
  const m = newIds.length;

  // LCS table (blocks per doc are hundreds at most; O(n·m) is fine).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldIds[i] === newIds[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const raw: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldIds[i] === newIds[j]) {
      raw.push({ op: 'keep', oldIndex: i, newIndex: j, block: newBlocks[j]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      raw.push({ op: 'delete', oldIndex: i, block: oldBlocks[i]! });
      i++;
    } else {
      raw.push({ op: 'insert', newIndex: j, block: newBlocks[j]! });
      j++;
    }
  }
  while (i < n) raw.push({ op: 'delete', oldIndex: i, block: oldBlocks[i++]! });
  while (j < m) raw.push({ op: 'insert', newIndex: j, block: newBlocks[j++]! });

  // Fuse delete+insert of the same kind (and heading level) into modify.
  const ops: DiffOp[] = [];
  for (let k = 0; k < raw.length; k++) {
    const a = raw[k]!;
    const b = raw[k + 1];
    if (
      a.op === 'delete' &&
      b?.op === 'insert' &&
      a.block.kind === b.block.kind &&
      (a.block.kind !== 'heading' || b.block.kind !== 'heading' || a.block.level === b.block.level)
    ) {
      ops.push({ op: 'modify', oldIndex: a.oldIndex, newIndex: b.newIndex, oldBlock: a.block, newBlock: b.block });
      k++;
    } else {
      ops.push(a);
    }
  }
  return ops;
}
