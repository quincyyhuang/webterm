// Terminal bell (BEL, "\a"): flash the terminal, mark the tab title while you're elsewhere,
// and optionally beep. Everything here works over plain HTTP (no Notification API).

const SOUND_KEY = 'webterm.bellSound';
const CLAIM_KEY = 'webterm.bellAt';
const BEEP_GAP_MS = 400; // at most one beep per this interval, across all tabs

const soundEnabled = () => localStorage.getItem(SOUND_KEY) === '1';

let audioCtx = null;

// Browsers only let audio start after a user gesture, so create/resume the audio context
// on the first key press or tap once sound is enabled.
function unlockAudio() {
  if (!soundEnabled()) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    /* no Web Audio */
  }
}

function beep() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.16);
}

// A shared shell rings the bell in every open tab; only one of them should beep. The tab
// you're looking at claims it right away, others wait briefly so it wins the claim.
function beepOnce() {
  const looking = !document.hidden && document.hasFocus();
  setTimeout(
    () => {
      const now = Date.now();
      if (now - Number(localStorage.getItem(CLAIM_KEY) || 0) < BEEP_GAP_MS) return;
      localStorage.setItem(CLAIM_KEY, String(now));
      beep();
    },
    looking ? 0 : 80 + Math.random() * 60,
  );
}

/**
 * @param {object} o
 * @param {import('/xterm.js').Terminal} o.term
 * @param {HTMLElement} o.termEl       element to flash
 * @param {(on: boolean) => void} o.setMarker  show/hide the bell marker in the tab title
 */
export function initBell({ term, termEl, setMarker }) {
  const away = () => document.hidden || !document.hasFocus();

  term.onBell(() => {
    // Restart the flash animation even if the previous one is still running.
    termEl.classList.remove('bell');
    void termEl.offsetWidth;
    termEl.classList.add('bell');

    if (away()) setMarker(true);
    if (soundEnabled()) beepOnce();
  });
  termEl.addEventListener('animationend', () => termEl.classList.remove('bell'));

  const back = () => {
    if (!away()) setMarker(false);
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);

  window.addEventListener('keydown', unlockAudio, { capture: true });
  window.addEventListener('pointerdown', unlockAudio, { capture: true });

  const checkbox = document.getElementById('bell-sound');
  checkbox.checked = soundEnabled();
  checkbox.addEventListener('change', () => {
    localStorage.setItem(SOUND_KEY, checkbox.checked ? '1' : '0');
    if (checkbox.checked) beep(); // preview, and unlocks audio (this is a user gesture)
  });
  // The setting may have been changed in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key === SOUND_KEY) checkbox.checked = soundEnabled();
  });
}
