'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { now, ensureDir, readJson, atomicJson, appendJsonl, copyDir, hashValue } = require('./jsonfs');

class JsonCluster {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'cluster');
    this.stateFile = path.join(this.root, 'state.json');
    this.replicas = path.join(this.root, 'replicas');
  }

  async init() {
    await ensureDir(this.root);
    await ensureDir(this.replicas);
    if (!(await readJson(this.stateFile, null))) {
      await atomicJson(this.stateFile, {
        clusterId: `json-cluster-${Date.now()}`,
        term: 1,
        leader: 'node-primary',
        localNode: 'node-primary',
        quorum: 2,
        nodes: {
          'node-primary': { role: 'leader', online: true, appliedLsn: 0, lastHeartbeat: now() },
          'node-replica-a': { role: 'follower', online: true, appliedLsn: 0, lastHeartbeat: null },
          'node-replica-b': { role: 'follower', online: true, appliedLsn: 0, lastHeartbeat: null }
        },
        electionHistory: []
      });
    }
    return this.status();
  }

  async state() { return readJson(this.stateFile, null); }
  async save(state) { await atomicJson(this.stateFile, state); return state; }

  async status() {
    const state = await this.state();
    const meta = await this.engine.meta();
    state.nodes[state.localNode].appliedLsn = Math.max(0, meta.nextLsn - 1);
    state.nodes[state.localNode].lastHeartbeat = now();
    await this.save(state);
    return state;
  }

  async assertLeader() {
    const state = await this.state();
    if (state.leader !== state.localNode) throw Object.assign(new Error(`Write rejected: local node ${state.localNode} is not leader. Current leader: ${state.leader}`), { status: 503 });
  }

  async heartbeat() {
    const state = await this.state();
    const at = now();
    for (const [id, node] of Object.entries(state.nodes)) {
      if (!node.online) continue;
      if (id === state.localNode) node.lastHeartbeat = at;
      else if (node.lastHeartbeat) node.lastHeartbeat = at;
    }
    await this.save(state);
    return { at, online: Object.values(state.nodes).filter(n => n.online).length, quorum: state.quorum };
  }

  async replicate(nodeId) {
    const state = await this.state();
    const node = state.nodes[nodeId];
    if (!node || nodeId === state.localNode) throw Object.assign(new Error('Choose a follower node.'), { status: 400 });
    if (!node.online) throw Object.assign(new Error(`${nodeId} is offline.`), { status: 503 });
    const events = await this.engine.cdc(node.appliedLsn || 0, 5000);
    const dir = path.join(this.replicas, nodeId);
    await ensureDir(dir);
    for (const event of events) await appendJsonl(path.join(dir, 'replica-wal.jsonl'), event);
    await copyDir(this.engine.current, path.join(dir, 'current'));
    await copyDir(this.engine.indexes, path.join(dir, 'indexes'));
    await fsp.copyFile(this.engine.catalogFile, path.join(dir, 'catalog.json'));
    await fsp.copyFile(this.engine.metaFile, path.join(dir, 'meta.json'));
    const latestLsn = events.length ? events[events.length - 1].lsn : node.appliedLsn || 0;
    node.appliedLsn = latestLsn;
    node.lastHeartbeat = now();
    node.replicationDigest = hashValue({ latestLsn, copiedAt: node.lastHeartbeat });
    await this.save(state);
    return { node: nodeId, applied: events.length, appliedLsn: latestLsn, digest: node.replicationDigest };
  }

  async replicateAll() {
    const state = await this.state();
    const out = [];
    for (const id of Object.keys(state.nodes)) if (id !== state.localNode && state.nodes[id].online) out.push(await this.replicate(id));
    return out;
  }

  async setOnline(nodeId, online) {
    const state = await this.state();
    if (!state.nodes[nodeId]) throw Object.assign(new Error(`Unknown node: ${nodeId}`), { status: 404 });
    state.nodes[nodeId].online = Boolean(online);
    state.nodes[nodeId].lastHeartbeat = online ? now() : state.nodes[nodeId].lastHeartbeat;
    await this.save(state);
    return state.nodes[nodeId];
  }

  async elect(candidate) {
    const state = await this.state();
    if (!state.nodes[candidate]) throw Object.assign(new Error(`Unknown candidate: ${candidate}`), { status: 404 });
    if (!state.nodes[candidate].online) throw Object.assign(new Error('Offline node cannot become leader.'), { status: 409 });
    const voters = Object.entries(state.nodes).filter(([, node]) => node.online).map(([id]) => id);
    if (voters.length < state.quorum) throw Object.assign(new Error(`No quorum: ${voters.length}/${state.quorum}`), { status: 503 });
    state.term += 1;
    const previous = state.leader;
    state.leader = candidate;
    for (const [id, node] of Object.entries(state.nodes)) node.role = id === candidate ? 'leader' : 'follower';
    const election = {
      id: `election-${state.term}-${Date.now()}`,
      at: now(), term: state.term, previousLeader: previous, elected: candidate,
      votes: voters.map(voter => ({ voter, candidate, granted: true })),
      disclaimer: 'Simulated consensus theater. This is not Raft.'
    };
    state.electionHistory.unshift(election);
    state.electionHistory = state.electionHistory.slice(0, 20);
    await this.save(state);
    await this.engine.walEvent({ type: 'CLUSTER_ELECTION', term: state.term, leader: candidate, previousLeader: previous });
    return election;
  }

  async failover() {
    const state = await this.state();
    const candidates = Object.entries(state.nodes)
      .filter(([id, node]) => id !== state.leader && node.online)
      .sort((a, b) => Number(b[1].appliedLsn || 0) - Number(a[1].appliedLsn || 0));
    if (!candidates.length) throw Object.assign(new Error('No online follower available.'), { status: 503 });
    state.nodes[state.leader].online = false;
    await this.save(state);
    return this.elect(candidates[0][0]);
  }

  async promoteLocal() {
    const state = await this.state();
    state.nodes[state.localNode].online = true;
    await this.save(state);
    return this.elect(state.localNode);
  }
}

module.exports = { JsonCluster };
