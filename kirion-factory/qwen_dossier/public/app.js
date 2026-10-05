let current = null;
let currentQuestion = null;
const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function health() {
  try {
    const h = await api('/api/health');
    const online = h.qwen?.status === 'ok';
    $('health').textContent = online ? 'QWEN ONLINE' : `QWEN OFFLINE · ${h.qwen?.error || h.qwen?.status || 'unknown'}`;
    $('health').className = `status ${online ? 'ok' : 'bad'}`;
  } catch (err) {
    $('health').textContent = `health error · ${err.message}`;
    $('health').className = 'status bad';
  }
}

function renderProgress(p) {
  $('progress').textContent = `${p.answered} answered · ${p.remainingActive} remaining · ${p.criticalDomainsTouched}/${p.criticalDomainsTotal} domains`;
}

function renderQuestion(question) {
  currentQuestion = question;
  const card = $('questionCard');
  const ready = $('readyCard');
  if (!question) {
    card.hidden = true;
    ready.hidden = false;
    return;
  }
  ready.hidden = true;
  card.hidden = false;
  $('questionDomain').textContent = question.domain;
  $('questionRequired').textContent = question.required ? 'required' : 'optional';
  $('questionText').textContent = question.question;
  $('whyNow').textContent = question.whyNow ? `Why Qwen chose this now: ${question.whyNow}` : '';
  $('skip').hidden = !!question.required;
  const area = $('answerArea');
  area.innerHTML = '';

  if (question.kind === 'single') {
    const select = document.createElement('select');
    select.id = 'answerInput';
    for (const option of question.options || []) {
      const o = document.createElement('option');
      o.value = option;
      o.textContent = option.replaceAll('_', ' ');
      select.appendChild(o);
    }
    area.appendChild(select);
  } else if (question.kind === 'boolean') {
    const select = document.createElement('select');
    select.id = 'answerInput';
    select.innerHTML = '<option value="true">Yes</option><option value="false">No</option>';
    area.appendChild(select);
  } else {
    const textarea = document.createElement('textarea');
    textarea.id = 'answerInput';
    textarea.rows = 5;
    textarea.placeholder = 'Be concrete. This answer becomes part of the implementation contract.';
    area.appendChild(textarea);
  }
}

async function nextQuestion() {
  $('questionCard').hidden = true;
  $('readyCard').hidden = true;
  $('result').hidden = false;
  $('result').textContent = 'Qwen is selecting the next highest-value question…';
  try {
    const data = await api(`/api/sessions/${current.id}/next`, { method: 'POST', body: '{}' });
    current = data.session;
    renderProgress(data.progress);
    $('result').hidden = true;
    renderQuestion(data.question);
  } catch (err) {
    $('result').textContent = `Next-question failure: ${err.message}`;
  }
}

async function submit(answer) {
  if (!currentQuestion) return;
  try {
    const data = await api(`/api/sessions/${current.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ questionId: currentQuestion.id, answer })
    });
    current = data.session;
    renderProgress(data.progress);
    await nextQuestion();
  } catch (err) {
    alert(`Answer failed: ${err.message}`);
  }
}

$('start').onclick = async () => {
  try {
    const data = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        projectName: $('projectName').value,
        goal: $('goal').value,
        targetDirectory: $('targetDirectory').value,
        sourceRepo: $('sourceRepo').value
      })
    });
    current = data.session;
    $('setup').hidden = true;
    $('session').hidden = false;
    $('sessionTitle').textContent = current.projectName;
    renderProgress(data.progress);
    await nextQuestion();
  } catch (err) {
    alert(`Start failed: ${err.message}`);
  }
};

$('submitAnswer').onclick = () => {
  const el = $('answerInput');
  let answer = el.value;
  if (currentQuestion.kind === 'boolean') answer = answer === 'true';
  if (currentQuestion.kind === 'text') answer = answer.trim();
  submit(answer);
};

$('skip').onclick = () => submit('__SKIP__');

$('finalize').onclick = async () => {
  if (!confirm(`Generate the full dossier into:\n\n${current.targetDirectory}\n\nThe directory must be new or empty. Continue?`)) return;
  $('readyCard').hidden = true;
  $('result').hidden = false;
  $('result').textContent = 'Qwen is synthesizing the implementation dossier. This can take several minutes on POTATO-16…';
  try {
    const data = await api(`/api/sessions/${current.id}/finalize`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
    current = data.session;
    $('result').textContent = `DOSSIER GENERATED\n\nDirectory: ${data.generated.directory}\n\n${data.generated.files.join('\n')}`;
  } catch (err) {
    $('result').textContent = `Dossier generation failed: ${err.message}`;
  }
};

health();
setInterval(health, 10000);
