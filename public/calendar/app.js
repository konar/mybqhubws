/* ═══════════════════════════════════════════════════════════════════
   Ambient Kiosk — app.js
   CSV parser · Timer loop · SleepGuard · localStorage fallback
   ═══════════════════════════════════════════════════════════════════ */

// ─── Configuration ─────────────────────────────────────────────────
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQMqjbvzDcd8XVCtJgn0hdP9-aAthnrfLIKyQxHs5STm3ZwpySVlcnQEMaVyhe9iKx-47J-hFwNy7-X/pub?output=csv';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_TASK_CHARS = 35;
const STORAGE_KEY = 'ambientKiosk_schedule';

// ─── DOM References ────────────────────────────────────────────────
const DOM = {
  overlay:       document.getElementById('activate-overlay'),
  guardStatus:   document.getElementById('guard-status'),
  guardText:     document.querySelector('#guard-status .guard-text'),
  dataStatus:    document.getElementById('data-status'),
  dateDisplay:   document.getElementById('date-display'),
  clockHH:       document.getElementById('clock-hh'),
  clockMM:       document.getElementById('clock-mm'),
  clockSS:       document.getElementById('clock-ss'),
  nowBadgeTime:  document.getElementById('now-time-range'),
  nowTitle:      document.getElementById('now-title'),
  progressFill:  document.getElementById('progress-fill'),
  progressGlow:  document.getElementById('progress-glow'),
  timeRemaining: document.getElementById('time-remaining'),
  nextBadgeTime: document.getElementById('next-time-range'),
  nextTitle:     document.getElementById('next-title'),
};


/* ═══════════════════════════════════════════════════════════════════
   1. SleepGuard — Anti-Sleep for Portal Plus
      Canvas-stream video + inaudible WebAudio white noise.
      Replicated from mybqhubws/public/time/script.js
   ═══════════════════════════════════════════════════════════════════ */
class SleepGuard {
  constructor() {
    this.canvas = null;
    this.video = null;
    this.audioCtx = null;
    this.wakeLock = null;
    this.active = false;
  }

  /** Activate the full keep-awake stack (call on first user gesture). */
  activate() {
    if (this.active) return;
    this.active = true;

    // ── 1. Canvas "heartbeat" source ──
    this.canvas = document.createElement('canvas');
    this.canvas.width = 10;
    this.canvas.height = 10;
    const ctx = this.canvas.getContext('2d');

    // Toggle pixel every second so the stream stays "alive"
    setInterval(() => {
      ctx.fillStyle = ctx.fillStyle === '#000000' ? '#111111' : '#000000';
      ctx.fillRect(0, 0, 10, 10);
    }, 1000);

    // ── 2. Capture stream at 1 FPS ──
    let stream;
    try {
      stream = this.canvas.captureStream(1);
    } catch (e) {
      console.warn('[SleepGuard] captureStream failed:', e);
      this._updateStatus('Stream fail', false);
      this._tryWakeLockAPI();
      return;
    }

    // ── 3. Hidden video element ──
    this.video = document.createElement('video');
    Object.assign(this.video.style, {
      position: 'fixed', bottom: '0', right: '0',
      width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none',
    });
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('loop', '');
    this.video.setAttribute('muted', '');
    this.video.muted = true;
    this.video.srcObject = stream;
    document.body.appendChild(this.video);

    // ── 4. Play ──
    this.video.play()
      .then(() => this._updateStatus('Active 24/7', true))
      .catch(e => {
        console.warn('[SleepGuard] play blocked:', e);
        this._updateStatus('Play blocked', false);
      });

    // ── 5. Inaudible white-noise audio (keeps audio session alive) ──
    this._activateAudio();

    // ── 6. Standard Wake Lock API (laptops / modern browsers) ──
    this._tryWakeLockAPI();
  }

  /** Near-silent white noise through WebAudio. */
  _activateAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      const sr = this.audioCtx.sampleRate;
      const buf = this.audioCtx.createBuffer(1, 2 * sr, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 0.0001;

      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.audioCtx.destination);
      src.start();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    } catch (e) {
      console.warn('[SleepGuard] audio fail:', e);
    }
  }

  /** Screen Wake Lock API — works on Chrome/Edge on laptops. */
  async _tryWakeLockAPI() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this._tryWakeLockAPI();
          }, { once: true });
        });
      }
    } catch (e) {
      console.warn('[SleepGuard] wakeLock fail:', e);
    }
  }

  _updateStatus(text, isActive) {
    DOM.guardText.textContent = text;
    DOM.guardStatus.classList.toggle('active', isActive);
  }
}

const sleepGuard = new SleepGuard();


/* ═══════════════════════════════════════════════════════════════════
   2. CSV Parser
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Parse a CSV string into an array of objects keyed by header names.
 * Handles quoted fields and trims whitespace.
 */
function parseCSV(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 1) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

/** Split a single CSV line respecting quoted fields. */
function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}


/* ═══════════════════════════════════════════════════════════════════
   3. Schedule Data
   ═══════════════════════════════════════════════════════════════════ */
let schedule = []; // { day, start, end, task, startMin, endMin }

/**
 * Normalize parsed rows into a sorted schedule with minutes-of-day fields.
 */
function buildSchedule(rows) {
  const result = [];

  for (const row of rows) {
    const dayRaw  = row['day'] || row['date'] || '';
    const startRaw = row['starttime'] || row['start time'] || row['start'] || '';
    const endRaw   = row['endtime']   || row['end time']   || row['end']   || '';
    const task     = row['task'] || row['title'] || row['task title'] || '';

    if (!startRaw || !task) continue; // skip empty rows

    result.push({
      day:      dayRaw,
      start:    startRaw,
      end:      endRaw,
      task:     task,
      startMin: timeToMinutes(startRaw),
      endMin:   timeToMinutes(endRaw),
    });
  }

  // Sort by start time
  result.sort((a, b) => a.startMin - b.startMin);
  return result;
}

/**
 * Convert "HH:MM" or "H:MM AM/PM" to minutes-of-day (0-1439).
 */
function timeToMinutes(str) {
  if (!str) return 0;
  str = str.trim().toUpperCase();

  // Try 12-hour format first
  const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (ampm[3] === 'PM' && h !== 12) h += 12;
    if (ampm[3] === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }

  // 24-hour format
  const parts = str.split(':');
  if (parts.length >= 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  return 0;
}

/** Format minutes-of-day back to "h:mm AM/PM". */
function minutesToDisplay(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${suffix}`;
}


/* ═══════════════════════════════════════════════════════════════════
   4. Data Fetching & Caching
   ═══════════════════════════════════════════════════════════════════ */
async function fetchSchedule() {
  try {
    const url = `${CSV_URL}&_t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const rows = parseCSV(text);
    schedule = buildSchedule(rows);

    // Cache to localStorage
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
    DOM.dataStatus.textContent = `Synced ${new Date().toLocaleTimeString()}`;
    DOM.dataStatus.style.color = 'rgba(74,222,128,0.4)';
  } catch (e) {
    console.warn('[Fetch] Error:', e);
    DOM.dataStatus.textContent = 'Offline (cached)';
    DOM.dataStatus.style.color = 'rgba(251,191,36,0.4)';
    loadCachedSchedule();
  }
}

function loadCachedSchedule() {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      schedule = JSON.parse(cached);
    }
  } catch (e) {
    console.warn('[Cache] Parse error:', e);
  }
}

// Initial load + polling
loadCachedSchedule();          // show cached data immediately
fetchSchedule();               // then fetch fresh
setInterval(fetchSchedule, POLL_INTERVAL_MS);


/* ═══════════════════════════════════════════════════════════════════
   5. Clock & Display Loop
   ═══════════════════════════════════════════════════════════════════ */

/** Truncate text to MAX_TASK_CHARS with ellipsis. */
function truncate(text) {
  if (!text) return '';
  return text.length > MAX_TASK_CHARS ? text.slice(0, MAX_TASK_CHARS - 1) + '…' : text;
}

/** Get today's day-of-week name (e.g. "Monday"). */
function todayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' });
}

/** Filter schedule to today's tasks. */
function todayTasks() {
  const today = todayName().toLowerCase();
  // If Day column is populated, filter by it; otherwise show all tasks
  const hasDayCol = schedule.some(t => t.day && t.day.trim().length > 0);
  if (!hasDayCol) return schedule;
  return schedule.filter(t => t.day.toLowerCase() === today);
}

let lastNowKey = '';
let lastNextKey = '';

function updateDisplay() {
  const now = new Date();

  // ── Clock ──
  DOM.clockHH.textContent = now.getHours().toString().padStart(2, '0');
  DOM.clockMM.textContent = now.getMinutes().toString().padStart(2, '0');
  DOM.clockSS.textContent = now.getSeconds().toString().padStart(2, '0');

  // ── Date ──
  DOM.dateDisplay.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  // ── Find current & next tasks ──
  const currentMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const tasks = todayTasks();

  let currentTask = null;
  let nextTask = null;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (currentMin >= t.startMin && currentMin < t.endMin) {
      currentTask = t;
      nextTask = tasks[i + 1] || null;
      break;
    }
    if (currentMin < t.startMin) {
      // We're before this task — it's the "next" task, no current task
      nextTask = t;
      break;
    }
  }

  // If we're past all tasks
  const pastAllTasks = tasks.length > 0 && currentMin >= tasks[tasks.length - 1].endMin;

  // ── Render NOW ──
  const nowKey = currentTask ? currentTask.task + currentTask.start : (pastAllTasks ? '__done__' : '__free__');
  const shouldAnimateNow = nowKey !== lastNowKey;
  lastNowKey = nowKey;

  if (currentTask) {
    DOM.nowBadgeTime.textContent = `${minutesToDisplay(currentTask.startMin)} – ${minutesToDisplay(currentTask.endMin)}`;
    DOM.nowTitle.textContent = truncate(currentTask.task);
    DOM.nowTitle.className = shouldAnimateNow ? 'fade-in' : '';

    // Progress
    const elapsed = currentMin - currentTask.startMin;
    const total = currentTask.endMin - currentTask.startMin;
    const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
    DOM.progressFill.style.width = `${pct}%`;
    DOM.progressGlow.style.left = `calc(${pct}% - 18px)`;

    const remainMin = Math.max(0, Math.ceil(total - elapsed));
    if (remainMin >= 60) {
      const rh = Math.floor(remainMin / 60);
      const rm = remainMin % 60;
      DOM.timeRemaining.textContent = `${rh}h ${rm}m left`;
    } else {
      DOM.timeRemaining.textContent = `${remainMin}m left`;
    }
  } else if (pastAllTasks) {
    DOM.nowBadgeTime.textContent = '';
    DOM.nowTitle.textContent = 'DAY COMPLETE — REST';
    DOM.nowTitle.className = 'day-complete' + (shouldAnimateNow ? ' fade-in' : '');
    DOM.progressFill.style.width = '100%';
    DOM.progressGlow.style.left = 'calc(100% - 18px)';
    DOM.timeRemaining.textContent = '';
  } else {
    // Free time / buffer
    DOM.nowTitle.textContent = 'FREE TIME / BUFFER';
    DOM.nowTitle.className = 'free-time' + (shouldAnimateNow ? ' fade-in' : '');
    DOM.progressFill.style.width = '0%';
    DOM.progressGlow.style.left = '-18px';

    if (nextTask) {
      const untilMin = Math.ceil(nextTask.startMin - currentMin);
      DOM.nowBadgeTime.textContent = `Next in ${untilMin}m`;
      DOM.timeRemaining.textContent = `${untilMin}m until next`;
    } else {
      DOM.nowBadgeTime.textContent = '';
      DOM.timeRemaining.textContent = '';
    }
  }

  // ── Render UP NEXT ──
  const nextKey = nextTask ? nextTask.task + nextTask.start : '__none__';
  const shouldAnimateNext = nextKey !== lastNextKey;
  lastNextKey = nextKey;

  if (nextTask) {
    DOM.nextBadgeTime.textContent = `${minutesToDisplay(nextTask.startMin)} – ${minutesToDisplay(nextTask.endMin)}`;
    DOM.nextTitle.textContent = truncate(nextTask.task);
    DOM.nextTitle.className = shouldAnimateNext ? 'fade-in' : '';
  } else {
    DOM.nextBadgeTime.textContent = '';
    DOM.nextTitle.textContent = pastAllTasks ? '—' : 'Nothing scheduled';
    DOM.nextTitle.className = 'no-next';
  }

  requestAnimationFrame(updateDisplay);
}


/* ═══════════════════════════════════════════════════════════════════
   6. Fullscreen — cross-browser, bulletproof
   ═══════════════════════════════════════════════════════════════════ */

function goFullscreen(el) {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
  return Promise.reject('No fullscreen API');
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  if (document.msExitFullscreen) return document.msExitFullscreen();
  return Promise.reject('No fullscreen API');
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}

function toggleFullscreen() {
  if (isFullscreen()) {
    exitFullscreen().catch(() => {});
  } else {
    goFullscreen(document.documentElement).catch((err) => {
      console.error('[Fullscreen] failed:', err);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════════
   7. Interactions — activation & fullscreen
   ═══════════════════════════════════════════════════════════════════ */

function activateGuard() {
  try {
    if (!sleepGuard.active) sleepGuard.activate();
    DOM.overlay.classList.add('hidden');
  } catch (e) {
    console.warn('[Guard] activation error:', e);
    DOM.overlay.classList.add('hidden');
  }
}

// Overlay: single click activates guard
DOM.overlay.addEventListener('click', () => activateGuard());

// ENTIRE DOCUMENT: double-click toggles fullscreen
document.addEventListener('dblclick', (e) => {
  e.preventDefault();
  // Fullscreen FIRST — must happen before anything that could throw
  toggleFullscreen();
  // Then activate guard (safe — wrapped in try-catch)
  activateGuard();
});


/* ═══════════════════════════════════════════════════════════════════
   8. Boot
   ═══════════════════════════════════════════════════════════════════ */
requestAnimationFrame(updateDisplay);
