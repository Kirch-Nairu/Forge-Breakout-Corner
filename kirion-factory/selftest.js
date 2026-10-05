'use strict';

const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { loadConfig } = require('./src/config');
const { canTransition, transitionEpisode } = require('./src/core/lifecycle');
const { pathDecision, evaluateAction } = require('./src/core/authority');
const { normalizeUncertainty, selectNextQuestion, resolveUncertainty } = require('./src/core/question-engine');
const { validateWorkPackage } = require('./src/core/work-package');
const { EpisodeStore } = require('./src/state/episode-store');
const { hardwareSnapshot } = require('./src/worker/hardware');
const { createWorktree, removeWorktree } = require('./src/runner/worktree');

function exec(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${command} failed: ${err}`)));
  });
}

async function testLifecycle() {
  assert.equal(canTransition('PLANNED', 'DISCOVERY'), true);
  assert.equal(canTransition('PLANNED', 'PROMOTED'), false);
  const changed = transitionEpisode({ state:'READY', transitions:[] }, 'UNDER_REVIEW', { reason:'test' });
  assert.equal(changed.state, 'UNDER_REVIEW');
  assert.throws(() => transitionEpisode({ state:'PLANNED', transitions:[] }, 'ACCEPTED'));
}

async function testQuestions() {
  const low = normalizeUncertainty({ subject:'color', question:'color?', risk:'LOW', unblocksImplementation:1 });
  const high = normalizeUncertainty({ subject:'auth', question:'department scoped?', risk:'CRITICAL', architectureImpact:5, unblocksImplementation:5, guessingRisk:5 });
  assert.equal(selectNextQuestion([low, high]).item.id, high.id);
  const resolved = resolveUncertainty([low, high], high.id, 'department scoped');
  assert.equal(resolved.find(x => x.id === high.id).status, 'RESOLVED');
}

async function testAuthority() {
  const wp = { ownedScope:['src/auth/**','tests/auth/**'], prohibitedScope:['src/auth/secrets/**'] };
  assert.equal(pathDecision('src/auth/service.js', wp).allowed, true);
  assert.equal(pathDecision('src/auth/secrets/key.js', wp).allowed, false);
  assert.equal(pathDecision('src/payroll/x.js', wp).allowed, false);
  const denied = evaluateAction({ role:'CODE_WRITER', action:'PATCH_FILE', episode:{state:'AUTHORIZED'}, workPackage:wp, file:'src/auth/service.js', human:{writeAuthorized:false} });
  assert.equal(denied.allowed, false);
  const allowed = evaluateAction({ role:'CODE_WRITER', action:'PATCH_FILE', episode:{state:'AUTHORIZED'}, workPackage:wp, file:'src/auth/service.js', human:{writeAuthorized:true} });
  assert.equal(allowed.allowed, true);
}

async function testWorkPackage() {
  const wp = validateWorkPackage({
    goal:'test', sourceSha:'a'.repeat(40), ownedScope:['src/**'], prohibitedScope:['secrets/**'], requiredChecks:['node --test'], steps:['implement'], mutationBudget:{maxFiles:5,maxRounds:3}
  });
  assert.equal(wp.sourceSha, 'a'.repeat(40));
  assert.throws(() => validateWorkPackage({ goal:'x', sourceSha:'main', ownedScope:['**'], requiredChecks:['x'], steps:['x'] }));
}

async function testStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kirion-store-'));
  try {
    const store = new EpisodeStore(root); await store.init();
    let ep = await store.create({ goal:'selftest' });
    ep = await store.transition(ep.id, 'DISCOVERY');
    const reloaded = await store.get(ep.id);
    assert.equal(reloaded.state, 'DISCOVERY');
    assert.equal(reloaded.version >= 2, true);
  } finally { await fsp.rm(root, { recursive:true, force:true }); }
}

async function testWorktreeIsolation() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'kirion-git-'));
  const repo = path.join(base, 'repo'); await fsp.mkdir(repo);
  try {
    await exec('git', ['init'], repo);
    await exec('git', ['config','user.email','kirion-selftest@example.invalid'], repo);
    await exec('git', ['config','user.name','KIRION Selftest'], repo);
    await fsp.writeFile(path.join(repo,'a.txt'),'one\n');
    await exec('git',['add','a.txt'],repo); await exec('git',['commit','-m','base'],repo);
    const sourceSha = await exec('git',['rev-parse','HEAD'],repo);
    const result = await createWorktree({ repoPath:repo, episodeId:'episode-selftest', sourceSha, worktreeRoot:path.join(base,'worktrees') });
    assert.equal(result.candidateHead, sourceSha);
    assert.equal(result.canonicalHeadBefore, result.canonicalHeadAfter);
    await fsp.writeFile(path.join(result.target,'candidate.txt'),'candidate\n');
    assert.equal(await fsp.access(path.join(repo,'candidate.txt')).then(()=>true,()=>false), false);
    await removeWorktree({ repoPath:repo, target:result.target });
  } finally { await fsp.rm(base,{recursive:true,force:true}); }
}

async function main() {
  const config = loadConfig();
  await testLifecycle();
  await testQuestions();
  await testAuthority();
  await testWorkPackage();
  await testStore();
  await testWorktreeIsolation();
  const hardware = hardwareSnapshot(config);
  assert.ok(hardware.memory.totalBytes > 0);
  console.log('KIRION POTATO-16 bootstrap selftest: PASS');
  console.log(JSON.stringify({ profile:config.profile, logicalCpus:hardware.logicalCpus, totalMemoryGiB:(hardware.memory.totalBytes/1073741824).toFixed(1) }, null, 2));
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
