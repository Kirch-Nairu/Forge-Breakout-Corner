'use strict';

(function initKirionAudio(root) {
  const MODES = ['off', 'minimal', 'reactive'];
  let mode = localStorage.getItem('kirion-audio-mode') || 'off';
  if (!MODES.includes(mode)) mode = 'off';
  let volume = Number(localStorage.getItem('kirion-audio-volume') || 0.16);
  if (!Number.isFinite(volume)) volume = 0.16;
  volume = Math.min(0.5, Math.max(0.02, volume));
  let context = null;
  let master = null;
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
    return context;
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    localStorage.setItem('kirion-audio-mode', mode);
    if (mode !== 'off') ensureContext();
    renderControl();
  }

  function cycleMode() {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  function setVolume(next) {
    volume = Math.min(0.5, Math.max(0.02, Number(next) || 0.16));
    localStorage.setItem('kirion-audio-volume', String(volume));
    if (master) master.gain.setTargetAtTime(volume, context.currentTime, 0.015);
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
    const throttle = highFrequencyKinds.has(kind) ? 26 : 60;
    if (now - lastToneAt < throttle && kind !== 'error' && kind !== 'complete') return;
    lastToneAt = now;
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));

    if (kind === 'compare') return envelopeTone({ frequency: 260 + normalized * 620, duration: 0.022, type: 'sine', gain: 0.055 });
    if (kind === 'swap') return envelopeTone({ frequency: 420 + normalized * 420, duration: 0.036, type: 'square', gain: 0.045, slideTo: 650 + normalized * 300 });
    if (kind === 'write') return envelopeTone({ frequency: 330 + normalized * 300, duration: 0.03, type: 'triangle', gain: 0.04 });
    if (kind === 'pivot') return envelopeTone({ frequency: 740, duration: 0.055, type: 'triangle', gain: 0.06, slideTo: 520 });
    if (kind === 'start') return envelopeTone({ frequency: 250, duration: 0.07, type: 'sine', gain: 0.07, slideTo: 430 });
    if (kind === 'query') return envelopeTone({ frequency: 510, duration: 0.045, type: 'triangle', gain: 0.055, slideTo: 660 });
    if (kind === 'commit') {
      envelopeTone({ frequency: 330, duration: 0.055, type: 'sine', gain: 0.065 });
      return envelopeTone({ frequency: 495, duration: 0.07, type: 'sine', gain: 0.055, delay: 0.035 });
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

  function soundForWorkbenchEvent() {
    const type = document.querySelector('#lastEventType')?.textContent || '';
    if (!type || type === 'WAITING') return;
    if (/FAILED|ABORT|DENY|ERROR/.test(type)) return play('error');
    if (/SEED_COMPLETE|BENCHMARK_COMPLETE/.test(type)) return play('complete');
    if (/BATCH_COMMIT|RECORD_COMMIT/.test(type)) return play('commit');
    if (/QUERY_COMPLETE/.test(type)) return play('query');
    if (/SEED_BEGIN|WRITE_ACTION_BEGIN/.test(type)) return play('start');
  }

  function renderControl() {
    const button = document.querySelector('#kirionSoundMode');
    if (button) {
      button.dataset.mode = mode;
      button.textContent = `SOUND ${mode.toUpperCase()}`;
      button.title = 'Cycle sound mode: off → minimal → reactive';
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
    new MutationObserver(soundForWorkbenchEvent).observe(target, { childList: true, characterData: true, subtree: true });
  }

  root.KirionAudio = { play, setMode, getMode: () => mode, setVolume, getVolume: () => volume, ensureContext };
  mountControl();
  observeWorkbench();
})(window);
