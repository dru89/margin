/**
 * Group diff ops into contiguous rebuild regions (UREGION-*): the
 * update orchestrator deletes each region's old range and rebuilds its
 * new blocks, touching nothing else. KEEP blocks are in no region.
 */
import type { CanonicalBlock } from './blocks.ts';
import type { DiffOp } from './differ.ts';

export interface RebuildRegion {
  /** Old-side block index range to delete, [start, end). Empty when insert-only. */
  oldStart: number;
  oldEnd: number;
  /** New blocks to build in the region's place (empty when delete-only). */
  blocks: CanonicalBlock[];
  /**
   * For insert-only regions: the old-side block index the insertion
   * precedes (i.e. insert before this block; oldStart === oldEnd === it).
   */
  insertBeforeOld: number;
}

export function planRegions(ops: DiffOp[]): RebuildRegion[] {
  const regions: RebuildRegion[] = [];
  let current: RebuildRegion | null = null;
  // Tracks the old-side index the cursor sits before, for insert-only regions.
  let oldCursor = 0;

  const flush = () => {
    if (current) regions.push(current);
    current = null;
  };

  for (const op of ops) {
    if (op.op === 'keep') {
      flush();
      oldCursor = op.oldIndex + 1;
      continue;
    }
    if (!current) {
      current = { oldStart: oldCursor, oldEnd: oldCursor, blocks: [], insertBeforeOld: oldCursor };
    }
    if (op.op === 'delete') {
      current.oldStart = Math.min(current.oldStart, op.oldIndex);
      current.oldEnd = Math.max(current.oldEnd, op.oldIndex + 1);
      oldCursor = op.oldIndex + 1;
    } else if (op.op === 'insert') {
      current.blocks.push(op.block);
    } else {
      current.oldStart = Math.min(current.oldStart, op.oldIndex);
      current.oldEnd = Math.max(current.oldEnd, op.oldIndex + 1);
      current.blocks.push(op.newBlock);
      oldCursor = op.oldIndex + 1;
    }
  }
  flush();
  return regions;
}
