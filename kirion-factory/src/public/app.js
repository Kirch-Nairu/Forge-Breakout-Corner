'use strict';

let current = null;
let currentQuestion = null;

const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function short(value) { return value ? String(value).slice(0, 12) : '—'; }

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    const worker = data.worker?.service === 'KIRION_WORKER' ? `${data.worker.mode} / ${(data.worker.hardware.memory.freeBytes/1073741824).toFixed(1)} GB free` : 'OFFLINE';
    $('status').textContent = `${data.profile} · worker ${worker}`;
  } catch (err) { $('status').textContent = `status error · ${err.message}`; }
}

async function refreshEpisodes() {
  const { episodes } = await api('/api/episodes');
  $('episodes').innerHTML = episodes.length ? '' : '<p class="hint">No episodes yet.</p>';
  for (const episode of episodes) {
    const div = document.createElement('div');
    div.className = 'episode';
    div.innerHTML = `<strong>${episode.goal}</strong><small>${episode.state} · ${episode.id.slice(0,18)}…</small>`;
    div.onclick = () => loadEpisode(episode.id);
    $('episodes').appendChild(div);
  }
}

async function loadEpisode(id) {
  current = await api(`/api/episodes/${id}`);
  render();
}

function render() {
  $('empty').hidden = true;
  $('detail').hidden = false;
  $('episodeId').textContent = current.id;
  $('episodeGoal').textContent = current.goal;
  $('episodeState').textContent = current.state;
  const f = current.repoFacts;
  $('repoFacts').innerHTML = f ? [
    `HEAD ${short(f.head)}`,
    `branch ${f.branch}`,
    `${f.trackedFileCount} tracked files`,
    f.dirty ? 'worktree DIRTY' : 'worktree clean'
  ].map(x => `<span class="fact">${x}</span>`).join('') : '<span class="fact">repository not attached</span>';

  $('actions').innerHTML = '';
  $('questionBox').hidden = true;
  $('workPackage').hidden = !current.workPackage;
  if (current.workPackage) $('workPackage').textContent = JSON.stringify(current.workPackage, null, 2);

  const add = (label, fn) => {
    const b = document.createElement('button'); b.textContent = label; b.onclick = fn; $('actions').appendChild(b);
  };

  if (['DISCOVERY','NEEDS_INFORMATION'].includes(current.state) && !current.uncertainties?.length) add('Run adaptive discovery', discover);
  if (current.state === 'NEEDS_INFORMATION') showQuestion();
  if (current.state === 'DECISION_READY' && !current.workPackage) add('Generate bounded work package', generateWorkPackage);
  if (current.state === 'DECISION_READY' && current.workPackage?.status === 'PROPOSED') add('Authorize implementation', authorize);
}

function showQuestion() {
  const open = (current.uncertainties || []).filter(x => x.status !== 'RESOLVED' && !x.repositoryAnswerable);
  if (!open.length) return;
  open.sort((a,b) => ((b.unblocksImplementation||0)+(b.architectureImpact||0)+(b.guessingRisk||0))-((a.unblocksImplementation||0)+(a.architectureImpact||0)+(a.guessingRisk||0)));
  currentQuestion = open[0];
  $('questionText').textContent = currentQuestion.question;
  $('questionWhy').textContent = currentQuestion.why;
  $('answer').value = '';
  $('questionBox').hidden = false;
}

async function discover() {
  try {
    const result = await api(`/api/episodes/${current.id}/discover`, { method:'POST', body:'{}' });
    current = result.episode; currentQuestion = result.nextQuestion?.item || null; render();
  } catch (err) { alert(`Discovery failed: ${err.message}`); }
}

async function answer() {
  const value = $('answer').value.trim();
  if (!value || !currentQuestion) return;
  try {
    const result = await api(`/api/episodes/${current.id}/answer`, { method:'POST', body:JSON.stringify({ uncertaintyId: currentQuestion.id, answer:value }) });
    current = result.episode; currentQuestion = result.nextQuestion?.item || null; render();
  } catch (err) { alert(`Answer failed: ${err.message}`); }
}

async function generateWorkPackage() {
  try { current = await api(`/api/episodes/${current.id}/work-package`, { method:'POST', body:'{}' }); render(); }
  catch (err) { alert(`Planning failed: ${err.message}`); }
}

async function authorize() {
  if (!confirm(`Authorize Code Writer scope at exact source ${current.workPackage.sourceSha}?`)) return;
  try {
    current = await api(`/api/episodes/${current.id}/authorize`, {
      method:'POST',
      headers:{'x-kirion-human-intent':'AUTHORIZE_IMPLEMENTATION'},
      body:JSON.stringify({ sourceSha: current.workPackage.sourceSha })
    });
    render();
  } catch (err) { alert(`Authorization failed: ${err.message}`); }
}

$('start').onclick = async () => {
  try {
    current = await api('/api/episodes', { method:'POST', body:JSON.stringify({ goal:$('goal').value, repositoryPath:$('repo').value }) });
    await refreshEpisodes(); render();
  } catch (err) { alert(`Session start failed: ${err.message}`); }
};
$('refresh').onclick = refreshEpisodes;
$('submitAnswer').onclick = answer;
refreshStatus(); refreshEpisodes(); setInterval(refreshStatus, 10000);
