import { describe, expect, it } from 'vitest';
import { planTabs, type TabStep } from '../src/tabs.ts';

const ops = (steps: TabStep[]): string[] =>
  steps.map((s) =>
    s.op === 'rename' ? `rename:${s.from}→${s.to}` : s.op === 'reorder' ? `reorder:${s.order.join(',')}` : `${s.op}:${'title' in s ? s.title : ''}`,
  );

describe('UTAB — tab reconciliation planner', () => {
  it('UTAB-1: all names match → all update-in-place (plus reorder if order differs)', () => {
    const same = planTabs(['A', 'B', 'C'], ['A', 'B', 'C']);
    expect(ops(same)).toEqual(['update:A', 'update:B', 'update:C']);
    const shuffled = planTabs(['C', 'A', 'B'], ['A', 'B', 'C']);
    expect(shuffled.filter((s) => s.op === 'update')).toHaveLength(3);
    expect(shuffled.filter((s) => s.op === 'rename' || s.op === 'create' || s.op === 'delete')).toHaveLength(0);
    expect(shuffled[shuffled.length - 1]).toEqual({ op: 'reorder', order: ['C', 'A', 'B'] });
  });

  it('UTAB-2: unmatched input at position N renames the unclaimed existing at N', () => {
    const steps = planTabs(['A', 'New Title', 'C'], ['A', 'Old Title', 'C']);
    expect(ops(steps)).toEqual(['update:A', 'update:C', 'rename:Old Title→New Title']);
  });

  it('UTAB-3: renames at first, middle, and last positions; multiple in one plan', () => {
    const steps = planTabs(['X', 'B', 'Z'], ['A', 'B', 'C']);
    expect(steps.filter((s) => s.op === 'rename')).toEqual([
      { op: 'rename', from: 'A', to: 'X', existingIndex: 0 },
      { op: 'rename', from: 'C', to: 'Z', existingIndex: 2 },
    ]);
    expect(steps.filter((s) => s.op === 'create' || s.op === 'delete')).toHaveLength(0);
  });

  it('UTAB-4: a name match elsewhere blocks a positional rename', () => {
    // Input tab 'B' at position 0; existing has 'B' at position 1.
    // 'B' must match+move, never rename existing position-0 'A'.
    const steps = planTabs(['B', 'A'], ['A', 'B']);
    expect(steps.filter((s) => s.op === 'rename')).toHaveLength(0);
    expect(steps.filter((s) => s.op === 'update')).toHaveLength(2);
    expect(steps[steps.length - 1]).toEqual({ op: 'reorder', order: ['B', 'A'] });
  });

  it('UTAB-5: swapped titles are reorders, not renames', () => {
    const steps = planTabs(['B', 'A'], ['A', 'B']);
    expect(ops(steps).some((o) => o.startsWith('rename'))).toBe(false);
  });

  it('UTAB-6: rename combined with a create; rename combined with a delete', () => {
    const withCreate = planTabs(['X', 'B', 'D'], ['A', 'B']);
    expect(ops(withCreate)).toContain('rename:A→X');
    expect(ops(withCreate)).toContain('create:D');
    const withDelete = planTabs(['X'], ['A', 'B']);
    expect(ops(withDelete)).toContain('rename:A→X');
    expect(ops(withDelete)).toContain('delete:B');
  });

  it('UTAB-7: disjoint sets rename by position up to the shorter length', () => {
    const longer = planTabs(['X', 'Y', 'Z'], ['A', 'B']);
    expect(ops(longer)).toEqual(['rename:A→X', 'rename:B→Y', 'create:Z']);
    const shorter = planTabs(['X'], ['A', 'B', 'C']);
    expect(ops(shorter)).toEqual(['rename:A→X', 'delete:B', 'delete:C']);
  });

  it('UTAB-8: empty existing (fresh doc) and empty input produce sensible plans', () => {
    expect(ops(planTabs(['A', 'B'], []))).toEqual(['create:A', 'create:B']);
    expect(ops(planTabs([], ['A', 'B']))).toEqual(['delete:A', 'delete:B']);
    expect(planTabs([], [])).toEqual([]);
  });

  it('UTAB-9: shuffle + rename together land exactly the input order and titles', () => {
    const steps = planTabs(['C', 'X', 'A'], ['A', 'B', 'C']);
    // A and C name-match; B renames to X positionally.
    expect(ops(steps)).toContain('rename:B→X');
    const reorder = steps[steps.length - 1];
    expect(reorder).toEqual({ op: 'reorder', order: ['C', 'X', 'A'] });
  });
});
