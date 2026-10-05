'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { run } = require('../control/repo-inspector');

function safeEpisodeId(value) {
  const id = String(value || '');
  if (!/^episode-[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid episode id for worktree.');
  return id;
}

async function createWorktree({ repoPath, episodeId, sourceSha, worktreeRoot = null }) {
  const repo = path.resolve(repoPath);
  const id = safeEpisodeId(episodeId);
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('Exact source SHA required.');

  await run('git', ['cat-file', '-e', `${sourceSha}^{commit}`], repo);
  const before = await run('git', ['rev-parse', 'HEAD'], repo);
  const base = worktreeRoot ? path.resolve(worktreeRoot) : path.join(path.dirname(repo), '.kirion-worktrees', path.basename(repo));
  await fsp.mkdir(base, { recursive: true });
  const target = path.join(base, id);

  try { await fsp.access(target); throw new Error(`Worktree already exists: ${target}`); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await run('git', ['worktree', 'add', '--detach', target, sourceSha], repo, 60000);
  const candidateHead = await run('git', ['rev-parse', 'HEAD'], target);
  const after = await run('git', ['rev-parse', 'HEAD'], repo);
  if (before !== after) throw new Error('Canonical worktree HEAD changed during candidate creation.');
  if (candidateHead !== sourceSha) throw new Error('Candidate worktree does not match requested source SHA.');

  return { repo, target, sourceSha, canonicalHeadBefore: before, canonicalHeadAfter: after, candidateHead };
}

async function removeWorktree({ repoPath, target }) {
  await run('git', ['worktree', 'remove', '--force', path.resolve(target)], path.resolve(repoPath), 60000);
}

module.exports = { createWorktree, removeWorktree };
