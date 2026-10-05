'use strict';

(function exposeSortCore(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KirionSortCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSortCore() {
  const metadata = {
    bubble: { label: 'Bubble Sort', best: 'O(n)', average: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: true },
    selection: { label: 'Selection Sort', best: 'O(n²)', average: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: false },
    insertion: { label: 'Insertion Sort', best: 'O(n)', average: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: true },
    merge: { label: 'Merge Sort', best: 'O(n log n)', average: 'O(n log n)', worst: 'O(n log n)', space: 'O(n)', stable: true },
    quick: { label: 'Quick Sort', best: 'O(n log n)', average: 'O(n log n)', worst: 'O(n²)', space: 'O(log n)', stable: false },
    heap: { label: 'Heap Sort', best: 'O(n log n)', average: 'O(n log n)', worst: 'O(n log n)', space: 'O(1)', stable: false }
  };

  function validateInput(input) {
    if (!Array.isArray(input)) throw new TypeError('Sort input must be an array.');
    if (input.length < 2 || input.length > 512) throw new RangeError('Sort input length must be between 2 and 512.');
    const values = input.map(Number);
    if (values.some(value => !Number.isFinite(value))) throw new TypeError('Sort input must contain only finite numbers.');
    return values;
  }

  function recorder(input) {
    const values = [...input];
    const operations = [];
    const compare = (i, j, extra = {}) => operations.push({ type: 'compare', i, j, a: values[i], b: values[j], ...extra });
    const compareValues = (i, j, a, b, extra = {}) => operations.push({ type: 'compare', i, j, a, b, ...extra });
    const swap = (i, j, extra = {}) => {
      if (i === j) return;
      [values[i], values[j]] = [values[j], values[i]];
      operations.push({ type: 'swap', i, j, ...extra });
    };
    const write = (i, value, extra = {}) => {
      values[i] = value;
      operations.push({ type: 'write', i, value, ...extra });
    };
    const pivot = (i, extra = {}) => operations.push({ type: 'pivot', i, value: values[i], ...extra });
    const mark = (kind, indices = [], extra = {}) => operations.push({ type: 'mark', kind, indices, ...extra });
    return { values, operations, compare, compareValues, swap, write, pivot, mark };
  }

  function bubble(input) {
    const r = recorder(input);
    const n = r.values.length;
    for (let end = n - 1; end > 0; end--) {
      let changed = false;
      for (let i = 0; i < end; i++) {
        r.compare(i, i + 1, { region: [0, end] });
        if (r.values[i] > r.values[i + 1]) {
          r.swap(i, i + 1, { reason: 'left value is larger' });
          changed = true;
        }
      }
      r.mark('sorted', [end]);
      if (!changed) break;
    }
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  function selection(input) {
    const r = recorder(input);
    for (let i = 0; i < r.values.length - 1; i++) {
      let min = i;
      r.mark('candidate-min', [min]);
      for (let j = i + 1; j < r.values.length; j++) {
        r.compare(min, j, { scanStart: i });
        if (r.values[j] < r.values[min]) {
          min = j;
          r.mark('candidate-min', [min]);
        }
      }
      r.swap(i, min, { reason: 'place smallest remaining value' });
      r.mark('sorted', [i]);
    }
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  function insertion(input) {
    const r = recorder(input);
    for (let i = 1; i < r.values.length; i++) {
      let j = i;
      r.mark('key', [j]);
      while (j > 0) {
        r.compare(j - 1, j, { insertionKey: i });
        if (r.values[j - 1] <= r.values[j]) break;
        r.swap(j - 1, j, { reason: 'shift key left' });
        j--;
      }
      r.mark('prefix-sorted', Array.from({ length: i + 1 }, (_, k) => k));
    }
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  function merge(input) {
    const r = recorder(input);
    const n = r.values.length;
    for (let width = 1; width < n; width *= 2) {
      for (let left = 0; left < n; left += width * 2) {
        const mid = Math.min(left + width, n);
        const right = Math.min(left + width * 2, n);
        if (mid >= right) continue;
        const a = r.values.slice(left, mid);
        const b = r.values.slice(mid, right);
        let ai = 0;
        let bi = 0;
        let out = left;
        r.mark('merge-range', Array.from({ length: right - left }, (_, k) => left + k), { left, mid, right });
        while (ai < a.length && bi < b.length) {
          r.compareValues(left + ai, mid + bi, a[ai], b[bi], { merge: [left, mid, right] });
          if (a[ai] <= b[bi]) r.write(out++, a[ai++], { source: 'left-run' });
          else r.write(out++, b[bi++], { source: 'right-run' });
        }
        while (ai < a.length) r.write(out++, a[ai++], { source: 'left-tail' });
        while (bi < b.length) r.write(out++, b[bi++], { source: 'right-tail' });
      }
    }
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  function quick(input) {
    const r = recorder(input);
    const sort = (lo, hi) => {
      if (lo >= hi) return;
      const pivotValue = r.values[hi];
      r.pivot(hi, { range: [lo, hi] });
      let boundary = lo;
      for (let j = lo; j < hi; j++) {
        r.compare(j, hi, { pivotValue, range: [lo, hi] });
        if (r.values[j] <= pivotValue) {
          r.swap(boundary, j, { reason: 'move value into lower partition' });
          boundary++;
        }
      }
      r.swap(boundary, hi, { reason: 'place pivot' });
      r.mark('pivot-placed', [boundary]);
      sort(lo, boundary - 1);
      sort(boundary + 1, hi);
    };
    sort(0, r.values.length - 1);
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  function heap(input) {
    const r = recorder(input);
    const heapify = (size, root) => {
      let largest = root;
      while (true) {
        const left = largest * 2 + 1;
        const right = left + 1;
        let candidate = largest;
        if (left < size) {
          r.compare(candidate, left, { heapSize: size });
          if (r.values[left] > r.values[candidate]) candidate = left;
        }
        if (right < size) {
          r.compare(candidate, right, { heapSize: size });
          if (r.values[right] > r.values[candidate]) candidate = right;
        }
        if (candidate === largest) return;
        r.swap(largest, candidate, { reason: 'restore max-heap' });
        largest = candidate;
      }
    };
    const n = r.values.length;
    for (let i = Math.floor(n / 2) - 1; i >= 0; i--) heapify(n, i);
    r.mark('heap-built', Array.from({ length: n }, (_, i) => i));
    for (let end = n - 1; end > 0; end--) {
      r.swap(0, end, { reason: 'extract max' });
      r.mark('sorted', [end]);
      heapify(end, 0);
    }
    r.mark('sorted-all', r.values.map((_, i) => i));
    return r;
  }

  const planners = { bubble, selection, insertion, merge, quick, heap };

  function createPlan(input, algorithm = 'quick') {
    const values = validateInput(input);
    const planner = planners[algorithm];
    if (!planner) throw new Error(`Unknown sorting algorithm: ${algorithm}`);
    const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const recorded = planner(values);
    const ended = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const result = recorded.values;
    for (let i = 1; i < result.length; i++) {
      if (result[i - 1] > result[i]) throw new Error(`${algorithm} planner produced an unsorted result.`);
    }
    return {
      format: 'KIRION-SORT-PLAN-1',
      algorithm,
      metadata: metadata[algorithm],
      input: values,
      result: [...result],
      operations: recorded.operations,
      planningMs: ended - started,
      operationCounts: recorded.operations.reduce((out, op) => {
        out[op.type] = (out[op.type] || 0) + 1;
        return out;
      }, {})
    };
  }

  return { metadata, algorithms: Object.keys(planners), createPlan, validateInput };
});
