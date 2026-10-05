'use strict';

(function initKirionAudio(root) {
  const MODES = ['off', 'minimal', 'reactive', 'cinematic'];
  let mode = localStorage.getItem('kirion-audio-mode') || 'reactive';
  if (!MODES.includes(mode)) mode = 'reactive';
  let volume = Number(localStorage.getItem('kirion-audio-volume') || 0.16);
  if (!Number.isFinite(volume)) volume = 0.16;
  volume = Math.min(0.5, Math.max(0.02, volume));
  let context = null;
  let master = null;
  let ambientNodes = [];
  let lastToneAt = 0;

  function ensureContext() {
    if (context) {
      if (context.state === 'suspended') context.resume().catch(() => {});
      return context;
    }
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);
    syncAmbient();
    return context;
  }

  function stopAmbient() {
    for (const node of ambientNodes) {
      try { node.stop?.(); } catch {}
      try { node.disconnect?.(); } catch {}
    }
    ambientNodes = [];
  }

  function syncAmbient() {
    stopAmbient();
    if (mode !== 'cinematic' || !context || !master) return;
    const low = context.createOscillator();
    const lowGain = context.createGain();
    const upper = context.createOscillator();
    const upperGain = context.createGain();
    low.type = 'sine';
    low.frequency.value = 48;
    lowGain.gain.value = 0.012;
    upper.type = 'triangle';
    upper.frequency.value = 96;
    upperGain.gain.value = 0.0045;
    low.connect(lowGain); lowGain.connect(master);
    upper.connect(upperGain); upperGain.connect(master);
    low.start(); upper.start();
    ambientNodes = [low, lowGain, upper, upperGain];
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    localStorage.setItem('kirion-audio-mode', mode);
    if (mode !== 'off') ensureContext();
    syncAmbient();
    renderControl();
  }

  function cycleMode() {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  function setVolume(next) {
    volume = Math.min(0.5, Math.max(0.02, Number(next) || 0.16));
    localStorage.setItem('kirion-audio-volume', String(volume));
    if (master && context) master.gain.setTargetAtTime(volume, context.currentTime, 0.015);
  }

  function envelopeTone({ frequency = 440, duration = 0.05, type = 'sine', gain = 0.14, slideTo = null, delay = 0 }) {
    if (mode === 'off') return;
    const ctx = ensureContext();
    if (!ctx || !master) return;
    const start = ctx.currentTime + Math.max(0, delay);
    const oscillator = ctx.createOscillator();
    const localGain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (slideTo != null) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), start + duration);
    localGain.gain.setValueAtTime(0.0001, start);
    localGain.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), start + Math.min(0.012, duration / 3));
    localGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(localGain);
    localGain.connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.015);
  }

  function play(kind, value = 0.5) {
    if (mode === 'off') return;
    const highFrequencyKinds = new Set(['compare', 'swap', 'write', 'pivot']);
    if (mode === 'minimal' && highFrequencyKinds.has(kind)) return;

    const now = performance.now();
    const throttle = highFrequencyKinds.has(kind) ? 24 : 46;
    if (now - lastToneAt < throttle && kind !== 'error' && kind !== 'complete') return;
    lastToneAt = now;
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));

    if (kind === 'compare') return envelopeTone({ frequency: 260 + normalized * 620, duration: 0.022, type: 'sine', gain: 0.055 });
    if (kind === 'swap') return envelopeTone({ frequency: 420 + normalized * 420, duration: 0.036, type: 'square', gain: 0.045, slideTo: 650 + normalized * 300 });
    if (kind === 'write') return envelopeTone({ frequency: 330 + normalized * 300, duration: 0.03, type: 'triangle', gain: 0.04 });
    if (kind === 'pivot') return envelopeTone({ frequency: 740, duration: 0.055, type: 'triangle', gain: 0.06, slideTo: 520 });
    if (kind === 'validate') {
      envelopeTone({ frequency: 440, duration: 0.035, type: 'triangle', gain: 0.035 });
      return envelopeTone({ frequency: 660, duration: 0.04, type: 'sine', gain: 0.025, delay: 0.024 });
    }
    if (kind === 'schema') return envelopeTone({ frequency: 560, duration: 0.045, type: 'triangle', gain: 0.04, slideTo: 720 });
    if (kind === 'transaction') {
      envelopeTone({ frequency: 205, duration: 0.07, type: 'sine', gain: 0.045, slideTo: 280 });
      return envelopeTone({ frequency: 410, duration: 0.05, type: 'triangle', gain: 0.032, delay: 0.035 });
    }
    if (kind === 'start') return envelopeTone({ frequency: 250, duration: 0.07, type: 'sine', gain: 0.07, slideTo: 430 });
    if (kind === 'query') {
      envelopeTone({ frequency: 510, duration: 0.045, type: 'triangle', gain: 0.055, slideTo: 660 });
      return envelopeTone({ frequency: 820, duration: 0.035, type: 'sine', gain: 0.03, delay: 0.032 });
    }
    if (kind === 'commit') {
      envelopeTone({ frequency: 294, duration: 0.055, type: 'sine', gain: 0.065 });
      envelopeTone({ frequency: 440, duration: 0.07, type: 'sine', gain: 0.055, delay: 0.03 });
      return envelopeTone({ frequency: 587.33, duration: 0.08, type: 'triangle', gain: 0.038, delay: 0.066 });
    }
    if (kind === 'batch') {
      envelopeTone({ frequency: 220, duration: 0.05, type: 'triangle', gain: 0.05, slideTo: 330 });
      envelopeTone({ frequency: 440, duration: 0.045, type: 'sine', gain: 0.035, delay: 0.03 });
      return envelopeTone({ frequency: 660, duration: 0.04, type: 'sine', gain: 0.025, delay: 0.058 });
    }
    if (kind === 'complete') {
      envelopeTone({ frequency: 392, duration: 0.08, type: 'sine', gain: 0.06 });
      envelopeTone({ frequency: 523.25, duration: 0.09, type: 'sine', gain: 0.055, delay: 0.055 });
      return envelopeTone({ frequency: 659.25, duration: 0.11, type: 'sine', gain: 0.05, delay: 0.11 });
    }
    if (kind === 'error') {
      envelopeTone({ frequency: 220, duration: 0.09, type: 'sawtooth', gain: 0.055, slideTo: 150 });
      return envelopeTone({ frequency: 165, duration: 0.12, type: 'sawtooth', gain: 0.045, delay: 0.06, slideTo: 110 });
    }
  }

  function phaseTarget(phase) {
    if (phase === 'ABORT') return 'transaction';
    if (phase === 'OBSERVE') return 'request';
    if (phase === 'QUERY') return 'benchmark';
    return String(phase || 'REQUEST').toLowerCase();
  }

  function mountTrafficMeter() {
    const stage = document.querySelector('.flow-stage');
    if (!stage || stage.querySelector('.traffic-meter')) return;
    const meter = document.createElement('div');
    meter.className = 'traffic-meter';
    meter.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 18; i += 1) meter.appendChild(document.createElement('i'));
    stage.appendChild(meter);
  }

  function hitTrafficMeter(intensity = 1) {
    const bars = [...document.querySelectorAll('.traffic-meter i')];
    if (!bars.length) return;
    const lit = Math.max(4, Math.min(bars.length, Math.round(5 + intensity * 13)));
    bars.forEach((bar, index) => {
      bar.classList.toggle('hot', index < lit && Math.random() > 0.12);
      if (index < lit) setTimeout(() => bar.classList.remove('hot'), 180 + index * 18);
    });
  }

  function dramaticWorkbenchVisual(type, phase, domain) {
    const nodes = [...document.querySelectorAll('.pipe-node')];
    const packetLayer = document.querySelector('#packetLayer');
    const stage = document.querySelector('.flow-stage');
    if (!stage || !packetLayer || !nodes.length) return;
    const targetName = phaseTarget(phase);
    const target = Math.max(0, nodes.findIndex(node => node.dataset.phase === targetName));
    const positions = nodes.slice(0, target + 1).map(node => {
      const rect = node.getBoundingClientRect();
      const layerRect = packetLayer.getBoundingClientRect();
      return { left: rect.left - layerRect.left + rect.width / 2, top: rect.top - layerRect.top + rect.height / 2 };
    });
    if (!positions.length) return;

    const isError = /FAILED|ABORT|DENY|ERROR/.test(type);
    const isCommit = /COMMIT|COMPLETE/.test(type);
    const isBatch = /BATCH|SEED/.test(type);
    const packetCount = isError ? 10 : isBatch ? 9 : isCommit ? 8 : 5;
    const className = isError ? 'error' : isCommit ? 'commit' : phase === 'QUERY' ? 'query' : '';

    stage.classList.remove('data-running', 'data-commit', 'data-error', 'data-query');
    void stage.offsetWidth;
    stage.classList.add('data-running');
    if (isCommit) stage.classList.add('data-commit');
    if (isError) stage.classList.add('data-error');
    if (phase === 'QUERY') stage.classList.add('data-query');
    document.body.classList.remove('workbench-impact', 'impact-forge', 'impact-earth', 'impact-jupiter', 'impact-mars', 'impact-benchmark', 'impact-workbench');
    document.body.classList.add('workbench-impact', `impact-${domain || 'workbench'}`);

    for (let j = 0; j < packetCount; j += 1) {
      const packet = document.createElement('div');
      packet.className = `flow-packet drama-packet ${className}`;
      packet.style.left = `${positions[0].left}px`;
      packet.style.top = `${positions[0].top + (j - packetCount / 2) * 1.8}px`;
      packet.style.setProperty('--packet-scale', String(j === 0 ? 1.35 : 0.55 + Math.random() * 0.55));
      packetLayer.appendChild(packet);
      positions.slice(1).forEach((pos, i) => setTimeout(() => {
        packet.style.left = `${pos.left}px`;
        packet.style.top = `${pos.top + Math.sin(j * 1.7 + i) * 5}px`;
      }, 55 + j * 22 + i * 105));
      setTimeout(() => packet.remove(), 650 + positions.length * 135 + j * 22);
    }

    const node = nodes[target];
    if (node) {
      node.classList.remove('dramatic-hit');
      void node.offsetWidth;
      node.classList.add('dramatic-hit');
      const shock = document.createElement('span');
      shock.className = `pipe-shock ${className}`;
      node.appendChild(shock);
      setTimeout(() => shock.remove(), 760);
      setTimeout(() => node.classList.remove('dramatic-hit'), 820);
    }

    hitTrafficMeter(isBatch ? 1 : isCommit ? 0.85 : 0.55);
    setTimeout(() => {
      stage.classList.remove('data-running', 'data-commit', 'data-error', 'data-query');
      document.body.classList.remove('workbench-impact', `impact-${domain || 'workbench'}`);
    }, 920);
  }

  function reactToWorkbenchEvent() {
    const type = document.querySelector('#lastEventType')?.textContent || '';
    const phase = document.querySelector('#lastEventPhase')?.textContent || 'REQUEST';
    const domain = String(document.querySelector('#lastEventDomain')?.textContent || 'workbench').toLowerCase();
    if (!type || type === 'WAITING') return;

    dramaticWorkbenchVisual(type, phase, domain);
    if (/FAILED|ABORT|DENY|ERROR/.test(type)) return play('error');
    if (/SEED_COMPLETE|BENCHMARK_COMPLETE/.test(type)) return play('complete');
    if (/BATCH_COMMIT/.test(type)) return play('batch');
    if (/RECORD_COMMIT/.test(type)) return play('commit');
    if (/QUERY_COMPLETE/.test(type)) return play('query');
    if (/VALIDATE/.test(type) || phase === 'VALIDATE') return play('validate');
    if (/SCHEMA/.test(type) || phase === 'SCHEMA') return play('schema');
    if (/TRANSACTION/.test(type) || phase === 'TRANSACTION') return play('transaction');
    if (/SEED_BEGIN|WRITE_ACTION_BEGIN/.test(type)) return play('start');
  }

  function renderControl() {
    const button = document.querySelector('#kirionSoundMode');
    if (button) {
      button.dataset.mode = mode;
      button.textContent = `SOUND ${mode.toUpperCase()}`;
      button.title = 'Cycle sound mode: off → minimal → reactive → cinematic';
    }
    const slider = document.querySelector('#kirionSoundVolume');
    if (slider) slider.value = String(Math.round(volume * 200));
  }

  function mountControl() {
    const host = document.querySelector('.top-chips');
    if (!host || document.querySelector('#kirionSoundMode')) return;
    const wrap = document.createElement('div');
    wrap.className = 'sound-control';
    wrap.innerHTML = `
      <button id="kirionSoundMode" class="chip sound-mode" type="button">SOUND OFF</button>
      <label class="sound-volume" title="Sound volume">
        <span>VOL</span>
        <input id="kirionSoundVolume" type="range" min="1" max="100" value="${Math.round(volume * 200)}">
      </label>`;
    host.prepend(wrap);
    wrap.querySelector('#kirionSoundMode').addEventListener('click', cycleMode);
    wrap.querySelector('#kirionSoundVolume').addEventListener('input', event => setVolume(Number(event.target.value) / 200));
    renderControl();
  }

  function observeWorkbench() {
    const target = document.querySelector('#lastEventType');
    if (!target) return;
    new MutationObserver(reactToWorkbenchEvent).observe(target, { childList: true, characterData: true, subtree: true });
  }

  root.addEventListener('pointerdown', () => {
    if (mode !== 'off') ensureContext();
  }, { once: true });
  root.addEventListener('storage', event => {
    if (event.key === 'kirion-audio-mode' && MODES.includes(event.newValue)) {
      mode = event.newValue;
      if (mode !== 'off') ensureContext();
      syncAmbient();
      renderControl();
    }
    if (event.key === 'kirion-audio-volume') {
      const next = Number(event.newValue);
      if (Number.isFinite(next)) {
        volume = Math.min(0.5, Math.max(0.02, next));
        if (master && context) master.gain.setTargetAtTime(volume, context.currentTime, 0.015);
        renderControl();
      }
    }
  });

  root.KirionAudio = { play, setMode, getMode: () => mode, setVolume, getVolume: () => volume, ensureContext };
  mountControl();
  mountTrafficMeter();
  observeWorkbench();
})(window);
