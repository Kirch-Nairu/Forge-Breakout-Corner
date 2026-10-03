'use strict';

const path = require('path');
const { readJson, now, hashValue } = require('./jsonfs');

class CostOptimizer {
  constructor(engine, advanced) {
    this.engine = engine;
    this.advanced = advanced;
    this.cache = new Map();
  }

  async stats(collection) {
    let stats = await readJson(path.join(this.advanced.statsDir, `${collection}.json`), null);
    if (!stats) stats = await this.advanced.analyze(collection);
    return stats;
  }

  estimatePredicate(node, stats) {
    if (!node) return 1;
    if (node.and) return Math.max(0.000001, node.and.reduce((s, n) => s * this.estimatePredicate(n, stats), 1));
    if (node.or) return Math.min(1, node.or.reduce((s, n) => s + this.estimatePredicate(n, stats), 0));
    if (node.not) return 1 - this.estimatePredicate(node.not, stats);
    const field = stats.fields?.[node.field];
    if (!field) return 0.5;
    const op = node.op || 'eq';
    if (op === 'eq') return field.distinct ? Math.max(1 / field.distinct, 1 / Math.max(1, stats.rows)) : 0.1;
    if (op === 'ne') return 1 - (field.distinct ? 1 / field.distinct : 0.1);
    if (['gt','gte','lt','lte'].includes(op)) return field.histogram?.length ? 0.33 : 0.4;
    if (op === 'contains' || op === 'regex') return 0.15;
    if (op === 'in' && Array.isArray(node.value)) return Math.min(1, node.value.length / Math.max(1, field.distinct || 10));
    return 0.5;
  }

  async estimateCollection(collection, where = null) {
    const stats = await this.stats(collection);
    const selectivity = this.estimatePredicate(where, stats);
    return { collection, rows: stats.rows, selectivity, estimatedRows: Math.max(1, Math.round(stats.rows * selectivity)), statsAt: stats.analyzedAt };
  }

  async optimize(query) {
    const fingerprint = hashValue(query);
    const cached = this.cache.get(fingerprint);
    if (cached) return { ...cached, cacheHit: true };
    const base = await this.estimateCollection(query.from, query.where);
    const joinEstimates = [];
    for (const join of query.joins || []) joinEstimates.push({ join, estimate: await this.estimateCollection(join.collection, null) });
    joinEstimates.sort((a, b) => a.estimate.estimatedRows - b.estimate.estimatedRows);
    const optimized = { ...query, joins: joinEstimates.map(x => x.join) };
    const logicalPlan = {
      node: 'PROJECT', select: query.select || ['*'],
      child: {
        node: query.orderBy?.length ? 'SORT' : 'PASSTHROUGH', orderBy: query.orderBy || [],
        child: {
          node: query.aggregates ? 'AGGREGATE' : 'PASSTHROUGH', groupBy: query.groupBy || [], aggregates: query.aggregates || {},
          child: {
            node: joinEstimates.length ? 'JOIN_PIPELINE' : 'SCAN',
            base,
            joins: joinEstimates.map(({ join, estimate }, position) => ({
              position, collection: join.collection, alias: join.as || join.collection,
              algorithm: 'HASH_JOIN', estimatedRightRows: estimate.estimatedRows,
              estimatedBuildBytes: estimate.estimatedRows * 160,
              reason: 'Join order sorted by estimated build-side cardinality.'
            }))
          }
        }
      }
    };
    const plan = {
      fingerprint, optimizedAt: now(), cacheHit: false, original: query, optimized,
      estimates: { base, joins: joinEstimates.map(x => x.estimate) }, logicalPlan,
      estimatedCostUnits: base.estimatedRows + joinEstimates.reduce((sum, x) => sum + x.estimate.estimatedRows, 0),
      disclaimer: 'Toy cost model using JSON ANALYZE statistics, not a serious optimizer.'
    };
    this.cache.set(fingerprint, plan);
    return plan;
  }

  async execute(query) {
    const plan = await this.optimize(query);
    const result = await this.engine.query(plan.optimized);
    return { optimizer: plan, execution: result };
  }

  status() { return { cachedPlans: this.cache.size, fingerprints: [...this.cache.keys()] }; }
  clear() { const count = this.cache.size; this.cache.clear(); return { cleared: count }; }
}

module.exports = { CostOptimizer };
