'use strict';

const assert = require('assert');
const core = require('./public/sort-core');

function multiset(values) {
  return [...values].sort((a, b) => a - b);
}

function cases() {
  return [
    [9, 1, 5, 3, 8, 2, 7, 6, 4],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [8, 7, 6, 5, 4, 3, 2, 1],
    [5, 1, 5, 3, 5, 2, 1, 3, 2, 5],
    Array.from({ length: 64 }, (_, i) => ((i * 37) % 101) - 50)
  ];
}

const report = [];
for (const algorithm of core.algorithms) {
  for (const input of cases()) {
    const plan = core.createPlan(input, algorithm);
    assert.deepStrictEqual(plan.result, multiset(input), `${algorithm} result mismatch`);
    assert.deepStrictEqual(multiset(plan.result), multiset(input), `${algorithm} changed multiset`);
    assert.ok(plan.operations.length > 0, `${algorithm} emitted no operations`);
    assert.strictEqual(plan.algorithm, algorithm);
    assert.ok(plan.metadata?.worst, `${algorithm} metadata missing`);
    report.push({ algorithm, n: input.length, operations: plan.operations.length, counts: plan.operationCounts });
  }
}

assert.throws(() => core.createPlan([1], 'quick'), /between 2 and 512/);
assert.throws(() => core.createPlan([1, Number.NaN], 'quick'), /finite numbers/);
assert.throws(() => core.createPlan([2, 1], 'bogus'), /Unknown sorting algorithm/);

console.log(JSON.stringify({ ok: true, algorithms: core.algorithms, cases: report.length, report }, null, 2));
