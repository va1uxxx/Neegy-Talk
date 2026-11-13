// Neegy-Talk :: app shell

import { CONFIG } from './config.js';
import { LEVELS, MAX_LEVEL, LORE, PLACES, XP } from './data.js';
import { respond, detectTopics, detectName } from './dialogue.js';
import { createStore, todayKey } from './store.js';
import { createRoom, mountRoom, unmountRoom, endRoom, setVolume, RoomError } from './room.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const LOG_KEY = 'neegy.log.v1';
const store = createStore();

let typing = false;
let levelQueue = [];
let levelOpen = false;
let log = [];
let room = { sessionId: null, adminToken: null, open: false, mounted: false, startedAt: 0, timer: null, tick: null, startUrl: CONFIG.room.startUrl };

/* ── sound ─────────────────────────────────────────────────── */
let audioCtx = null;
function beep(freq, dur = 0.08, type = 'sine', gain = 0.045) {
  if (!store.state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(gain, audioCtx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur + 0.02);
  } catch (e) { /* audio is optional */ }
}
function chordSequence(notes) {
  notes.forEach((n, i) => setTimeout(() => beep(n, 0.16, 'triangle', 0.05), i * 95));
}

/* ── toasts ────────────────────────────────────────────────── */
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  }, 2100);
}

/* ── chat log persistence ──────────────────────────────────── */
function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    log = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(log)) log = [];
  } catch (e) { log = []; }
}
function saveLog() {
  log = log.slice(-60);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch (e) { /* ignore */ }
}

/* ── message rendering ─────────────────────────────────────── */
function timeString(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderMessage(entry, animate = false) {
  const logEl = $('#log');
  if (entry.r === 's') {
    const el = document.createElement('div');
    el.className = 'sysline';
    el.innerHTML = entry.t;
    logEl.appendChild(el);
    return el;
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (entry.r === 'u' ? 'user' : 'neegy');
  if (!animate) wrap.style.animation = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = entry.t;

  const stamp = document.createElement('span');
  stamp.className = 'stamp';
  stamp.textContent = timeString(entry.ts);

  if (entry.r === 'u') { wrap.append(stamp, bubble); }
  else { wrap.append(bubble, stamp); }

  logEl.appendChild(wrap);
  return wrap;
}

function scrollLog() {
  const logEl = $('#log');
  logEl.scrollTop = logEl.scrollHeight;
}

function pushMessage(role, text, persist = true) {
  const entry = { r: role, t: text, ts: Date.now() };
  renderMessage(entry, true);
  if (persist) { log.push(entry); saveLog(); }
  scrollLog();
  return entry;
}

function sysline(html, persist = true) {
  const entry = { r: 's', t: html, ts: Date.now() };
  renderMessage(entry, true);
  if (persist) { log.push(entry); saveLog(); }
  scrollLog();
  return entry;
}

function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg neegy';
  wrap.id = 'typingRow';
  wrap.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
  $('#log').appendChild(wrap);
  scrollLog();
  $('#chatHeadText').textContent = 'Neegy is typing…';
}
function hideTyping() {
  const el = $('#typingRow');
  if (el) el.remove();
  $('#chatHeadText').textContent = 'Neegy is here';
}

/* ── theme + rail ──────────────────────────────────────────── */
function applyTheme() {
  const { level: lv } = store.levelInfo();
  document.documentElement.style.setProperty('--accent', lv.accent);
}

const MOOD_STATUS = {
  warm: ['signal acquired', 'listening', 'here', 'the room is warm'],
  quiet: ['sitting with it', 'not going anywhere', 'low frame rate, high attention'],
  glow: ['rendering at full brightness', 'warm pipeline', 'do not look directly at it'],
  sharp: ['damage control', 'still here', 'low power, sharp edges'],
  amused: ['enjoying itself', 'bad idea incoming', 'delighted, unfortunately']
};

function setMood(mood) {
  const stage = $('#avatarStage');
  stage.dataset.mood = mood;
  $('#neegyStatus').textContent = rand(MOOD_STATUS[mood] || MOOD_STATUS.warm);
}

function renderRail() {
  const { level: lv, next, prog } = store.levelInfo();
  const s = store.state;

  $('#lvlNum').textContent = lv.n;
  $('#lvlName').textContent = lv.name;
  $('#lvlSub').textContent = `level ${lv.n} of ${MAX_LEVEL}`;
  $('#xpFill').style.width = `${(prog.pct * 100).toFixed(1)}%`;
  $('#xpBar').setAttribute('aria-valuenow', Math.round(prog.pct * 100));
  $('#xpText').textContent = `${s.xp.toLocaleString()} xp`;
  $('#xpLeft').textContent = next ? `${prog.left.toLocaleString()} to ${next.name}` : 'maxed';
  $('#pillText').textContent = `Lv ${lv.n} · ${lv.name}`;

  $('#statStreak').textContent = s.checkin.streak;
  $('#statMsgs').textContent = s.stats.msgs;
  $('#statTopics').textContent = s.topics.length;
  $('#statLore').textContent = `${s.lore.length}/${LORE.length}`;

  const checked = store.checkedInToday();
  const btn = $('#checkinBtn');
  btn.disabled = checked;
  btn.querySelector('span').textContent = checked ? 'Checked in' : 'Check in';
  $('#checkinSub').textContent = checked
    ? `${s.checkin.streak} day${s.checkin.streak === 1 ? '' : 's'}`
    : `+${XP.checkin + Math.min(XP.checkinStreakCap, s.checkin.streak * XP.checkinStreakBonus)} xp`;

  const unlocked = store.roomUnlocked();
  const roomBtn = $('#roomBtn');
  roomBtn.disabled = !unlocked;
  $('#roomBtnText').textContent = unlocked ? "Open Neegy's Room" : "Neegy's Room — locked";
  $('#roomHint').textContent = unlocked
    ? 'a browser Neegy lives in'
    : `unlocks at level ${store.roomAvailableAt()}`;

  $('#xpRateHint').textContent = `+${XP.chat} xp a message`;
}

function renderQuests() {
  const q = store.quests();
  const list = $('#questList');
  list.innerHTML = '';
  for (const item of q.list) {
    const li = document.createElement('li');
    li.className = 'quest' + (item.done ? ' done' : '');
    li.innerHTML = `
      <div class="quest-top">
        <span class="quest-check">✓</span>
        <span class="quest-label">${item.label}</span>
        <span class="quest-xp">+${item.xp}</span>
      </div>
      <div class="quest-bar"><i style="width:${Math.round((item.progress / item.target) * 100)}%"></i></div>
      <div class="quest-count">${Math.min(item.progress, item.target)} / ${item.target}</div>`;
    list.appendChild(li);
  }
  const done = q.list.filter((x) => x.done).length;
  $('#questFoot').textContent = done === q.list.length
    ? 'All three done. New ones at midnight.'
    : `${done} of ${q.list.length} done · resets at midnight`;
}

function renderLevels() {
  const cur = store.state.level;
  const ol = $('#levelList');
  ol.innerHTML = '';
  for (const l of LEVELS) {
    const li = document.createElement('li');
    li.className = 'level-item'
      + (l.n <= cur ? ' unlocked' : '')
      + (l.n === cur ? ' current' : '');
    li.innerHTML = `
      <span class="n">${l.n}</span>
      <span class="nm">${l.name}</span>
      <span class="req">${l.n === cur ? 'now' : l.xp.toLocaleString() + ' xp'}</span>`;
    li.title = l.perk;
    ol.appendChild(li);
  }
}

function renderLore() {
  const ul = $('#loreList');
  ul.innerHTML = '';
  for (const entry of LORE) {
    const unlocked = entry.at <= store.state.level;
    const read = store.isLoreRead(entry.id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'lore-item' + (read ? ' read' : '');
    btn.disabled = !unlocked;
    btn.innerHTML = `
      <span class="lore-glyph">${unlocked ? (read ? '◉' : '○') : '⌧'}</span>
      <span class="t">${unlocked ? entry.title : 'Sealed fragment'}</span>
      <span class="s">${unlocked ? (read ? 'read' : '+' + XP.lore + ' xp') : 'lv ' + entry.at}</span>`;
    if (unlocked) btn.addEventListener('click', () => openLore(entry));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderAll() {
  applyTheme();
  renderRail();
  renderQuests();
  renderLevels();
  renderLore();
}

/* ── modal ─────────────────────────────────────────────────── */
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

function openLore(entry) {
  const first = !store.isLoreRead(entry.id);
  const got = store.readLore(entry.id);
  const paras = entry.body.split('\n').map((p) => `<p>${p}</p>`).join('');
  openModal(`
    <div class="eyebrow">fragment · level ${entry.at}</div>
    <h2>${entry.title}</h2>
    ${paras}
    ${first ? `<div class="row-actions"><button class="btn btn-primary" id="loreOk">+${got} xp · close</button></div>` : `<div class="row-actions"><button class="btn btn-ghost" id="loreOk">close</button></div>`}
  `);
  const ok = $('#loreOk');
  if (ok) ok.addEventListener('click', closeModal);
  if (first) { toast(`+${got} xp · lore`, 'xp'); beep(660, 0.12, 'triangle'); }
  renderRail();
  renderLore();
  renderQuests();
}

function openSettings() {
  const s = store.state;
  openModal(`
    <div class="eyebrow">settings</div>
    <h2>Neegy-Talk</h2>
    <p style="font-size:13px;color:var(--muted)">Progress lives in this browser only. Nothing is uploaded. Neegy's Room is the one exception: it opens a session on Hyperbeam through your own proxy.</p>

    <h3>Preferences</h3>
    <label style="display:flex;align-items:center;gap:9px;margin:8px 0">
      <input type="checkbox" id="optSound" ${s.settings.sound ? 'checked' : ''} />
      <span style="font-size:13px">Sound</span>
    </label>

    <h3>Progress</h3>
    <div class="row-actions">
      <button class="btn btn-ghost" id="optExport">Export JSON</button>
      <button class="btn btn-ghost" id="optImport">Import JSON</button>
      <button class="btn btn-danger" id="optReset">Reset</button>
    </div>
    <input type="file" id="optFile" accept="application/json" hidden />

    <h3>Room service</h3>
    <p style="font-size:12.5px;color:var(--muted-2)">Proxy: <code style="font-size:11px">${CONFIG.apiBase || '(same origin)'}/api/room</code></p>
    <p style="font-size:12.5px;color:var(--muted-2)">Key: set <code style="font-size:11px">HYPERBEAM_API_KEY</code> on the server. Never in the browser.</p>
  `);

  $('#optSound').addEventListener('change', (e) => {
    store.setSetting('sound', e.target.checked);
    $('#soundBtn').setAttribute('aria-pressed', String(e.target.checked));
    if (e.target.checked) beep(520);
  });

  $('#optExport').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `neegy-progress-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#optImport').addEventListener('click', () => $('#optFile').click());
  $('#optFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      store.importJSON(text);
      renderAll();
      toast('progress restored');
      closeModal();
    } catch (err) {
      toast('that file did not parse');
    }
  });

  $('#optReset').addEventListener('click', () => {
    if (!confirm('Wipe all progress, lore and the conversation?')) return;
    store.reset();
    log = [];
    saveLog();
    $('#log').innerHTML = '';
    renderAll();
    closeModal();
    bootGreeting(true);
    toast('wiped clean');
  });
}

/* ── level up ──────────────────────────────────────────────── */
store.on('levelup', (lv) => {
  if (!lv) return;
  levelQueue.push(lv);
  applyTheme();
  renderAll();
  chordSequence([523.25, 659.25, 783.99, 1046.5]);
});

function drainLevelQueue() {
  if (levelOpen || !levelQueue.length || typing) return;
  const lv = levelQueue.shift();
  levelOpen = true;
  $('#luNum').textContent = lv.n;
  $('#luName').textContent = lv.name;
  $('#luPerk').textContent = lv.perk;
  $('#levelup').hidden = false;
  applyTheme();
}

$('#luBtn').addEventListener('click', () => {
  $('#levelup').hidden = true;
  levelOpen = false;
  renderAll();
  sysline(`<b>Level ${store.state.level}</b> · ${store.levelInfo().level.name}`);
  setTimeout(drainLevelQueue, 220);
});

/* ── store reactions ───────────────────────────────────────── */
store.on('xp', ({ amount }) => {
  if (amount >= 12) toast(`+${amount} xp`, 'xp');
});

store.on('questDone', (q) => {
  toast(`quest done · +${q.xp} xp`, 'xp');
  beep(880, 0.14, 'triangle');
  renderQuests();
});

store.on('change', () => {
  renderRail();
});

/* ── chat ──────────────────────────────────────────────────── */
function composeReplyDelay(text) {
  const base = clamp(text.length * 16, CONFIG.chat.minTypingMs, CONFIG.chat.maxTypingMs);
  return base + Math.random() * 260;
}

async function sendMessage(raw) {
  const text = raw.trim();
  if (!text || typing) return;

  beep(600, 0.05, 'square', 0.03);
  pushMessage('u', text);

  store.recordMessage(text, Date.now());

  const nameGuess = detectName(text);
  if (nameGuess && !store.state.name) store.setName(nameGuess);

  const found = detectTopics(text);
  const fresh = found.filter((id) => !store.state.topics.includes(id));
  if (fresh.length) store.recordTopics(fresh);

  typing = true;
  $('#sendBtn').disabled = true;
  showTyping();

  const reply = respond(text, { state: store.state, returning: false });
  await new Promise((r) => setTimeout(r, composeReplyDelay(reply.text)));

  hideTyping();
  typing = false;
  $('#sendBtn').disabled = false;

  pushMessage('n', reply.text);
  setMood(reply.mood);
  beep(430 + Math.random() * 60, 0.07, 'sine', 0.03);

  renderRail();
  renderQuests();
  drainLevelQueue();
  $('#input').focus();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#input');
  const value = input.value;
  input.value = '';
  autosize(input);
  sendMessage(value);
});

$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 148) + 'px';
}
$('#input').addEventListener('input', (e) => autosize(e.target));

/* ── check in ──────────────────────────────────────────────── */
$('#checkinBtn').addEventListener('click', () => {
  const res = store.checkIn();
  if (!res.ok) { toast('already checked in today'); return; }
  toast(`checked in · +${res.xp} xp · ${res.streak} day streak`, 'xp');
  chordSequence([587.33, 739.99]);
  renderAll();
  sysline(`<b>Day ${res.streak}</b> · check-in logged`);
  drainLevelQueue();
});

/* ── tabs ──────────────────────────────────────────────────── */
$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    $$('.pane').forEach((p) => p.classList.toggle('is-active', p.id === 'pane-' + btn.dataset.tab));
    beep(520, 0.04, 'sine', 0.02);
  });
});

$('#levelPill').addEventListener('click', () => {
  const btn = $('.tabs button[data-tab="levels"]');
  if (btn) btn.click();
  $('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ── room ──────────────────────────────────────────────────── */
function roomStatus(html) {
  const el = $('#roomStatus');
  el.hidden = false;
  el.innerHTML = `<div class="inner">${html}</div>`;
}
function roomStatusHide() { $('#roomStatus').hidden = true; }

function setupDocs() {
  return `
    <h3>The room service is not wired up yet</h3>
    <p>Neegy's Room opens a real virtual browser through Hyperbeam. It needs one thing: an API key on a server, never in this page.</p>
    <code>grab a key at hyperbeam.com/dashboard
export HYPERBEAM_API_KEY=hbr_...
python3 server.py</code>
    <p style="font-size:12px">Deployed on GitHub Pages? Point <code>apiBase</code> in <code>assets/js/config.js</code> at a small proxy — <code>api/room.js</code> is included for Vercel.</p>
  `;
}

async function openRoom() {
  if (!store.roomUnlocked()) {
    toast(`Neegy's Room unlocks at level ${store.roomAvailableAt()}`);
    return;
  }
  $('#roomOverlay').hidden = false;
  $('#roomPlace').textContent = 'connecting…';
  roomStatus('<div class="spinner"></div><p>Neegy is opening the room…</p>');
  room.open = true;

  try {
    const session = await createRoom({ startUrl: room.startUrl });
    room.sessionId = session.sessionId;
    room.adminToken = session.adminToken;
    room.mounted = true;
    room.startedAt = Date.now();

    await mountRoom($('#hbContainer'), session.embedUrl, {
      volume: 0.35,
      adminToken: session.adminToken,
      onDisconnect: () => { roomStatus('<p>Session closed.</p>'); room.mounted = false; },
      onState: (st) => { $('#roomMeta').textContent = st === 'playing' ? 'connected' : st; }
    }).then((c) => { room.client = c; });

    roomStatusHide();
    const place = PLACES.find((p) => p.url === room.startUrl) || PLACES[0];
    $('#roomPlace').textContent = place.title;

    const earned = store.markRoomOpen();
    if (earned) toast(`+${earned} xp · room opened`, 'xp');
    beep(392, 0.12, 'triangle');
    renderRail();

    room.tick = setInterval(() => {
      if (!room.open) return;
      const mins = Math.floor((Date.now() - room.startedAt) / 60000);
      const secs = Math.floor((Date.now() - room.startedAt) / 1000);
      $('#roomClock').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')} in the room`;
      $('#roomMeta').textContent = `minutes counted: ${store.state.room.minutesToday}`;
      if (mins >= 1 && mins > (room.lastMinute || 0)) {
        room.lastMinute = mins;
        store.addRoomMinutes(1);
        renderRail();
        renderQuests();
      }
    }, 1000);
  } catch (err) {
    console.warn('[neegy] room failed', err);
    const code = err instanceof RoomError ? err.code : 'unknown';
    if (code === 'not_configured' || code === 'network' || code === 'bad_response') {
      roomStatus(setupDocs());
    } else if (code === 'unauthorized') {
      roomStatus('<h3>Key rejected</h3><p>Hyperbeam did not accept the API key on the server. Check <code>HYPERBEAM_API_KEY</code>.</p>');
    } else if (code.startsWith && code.startsWith('http_5')) {
      roomStatus('<h3>The room is busy</h3><p>Hyperbeam answered with an error. Try again in a moment.</p>');
    } else {
      roomStatus(`<h3>Could not open the room</h3><p>${String(err.message || err)}</p>`);
    }
    $('#roomPlace').textContent = 'offline';
  }
}

function closeRoom({ end = true } = {}) {
  room.open = false;
  clearInterval(room.tick);
  room.tick = null;
  room.lastMinute = 0;
  $('#roomOverlay').hidden = true;
  $('#hbContainer').innerHTML = '';
  roomStatusHide();
  unmountRoom();
  if (end && room.sessionId) endRoom(room.sessionId);
  room.sessionId = null;
  room.mounted = false;
  room.client = null;
}

$('#roomBtn').addEventListener('click', openRoom);
$('#roomCloseBtn').addEventListener('click', () => closeRoom({ end: true }));
$('#roomEndBtn').addEventListener('click', () => {
  closeRoom({ end: true });
  sysline('<b>Room</b> · session ended');
});

$('#volume').addEventListener('input', (e) => setVolume(e.target.value / 100));

function renderPlaces() {
  const box = $('#places');
  box.innerHTML = '';
  for (const p of PLACES) {
    const b = document.createElement('button');
    b.className = 'place-chip' + (p.url === room.startUrl ? ' active' : '');
    b.textContent = p.title;
    b.title = p.note;
    b.addEventListener('click', () => {
      room.startUrl = p.url;
      renderPlaces();
      if (room.mounted && room.adminToken && room.client?.tabs) {
        room.client.tabs.update({ url: p.url }).catch(() => toast('could not navigate the room'));
        $('#roomPlace').textContent = p.title;
      } else if (room.open) {
        toast('next session will start there');
      }
    });
    box.appendChild(b);
  }
}

/* ── settings ──────────────────────────────────────────────── */
$('#settingsBtn').addEventListener('click', openSettings);
$('#modalX').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal').hidden) closeModal();
    else if (!$('#roomOverlay').hidden) closeRoom({ end: true });
  }
});

// mirror sound state on boot
$('#soundBtn').addEventListener('click', () => {
  const next = !store.state.settings.sound;
  store.setSetting('sound', next);
  $('#soundBtn').setAttribute('aria-pressed', String(next));
  if (next) beep(560, 0.09);
});

/* ── boot ──────────────────────────────────────────────────── */
function bootGreeting(fresh = false) {
  const returning = !fresh && store.state.visits > 1;
  const greeting = respond('hey', { state: store.state, returning });

  if (fresh || !returning) {
    pushMessage('n', greeting.text, false);
    sysline('Neegy is awake. Say something, or <b>check in</b> for a head start.');
  } else {
    pushMessage('n', greeting.text, false);
  }
  setMood(greeting.mood);
}

function bootRenderedLog() {
  loadLog();
  if (log.length) {
    for (const entry of log) renderMessage(entry, false);
    scrollLog();
    setMood('warm');
  } else {
    bootGreeting();
  }
}

function init() {
  store.init();
  applyTheme();
  renderAll();
  renderPlaces();
  bootRenderedLog();
  $('#soundBtn').setAttribute('aria-pressed', String(store.state.settings.sound));

  if (CONFIG.art) {
    const frame = $('#avatarFrame');
    frame.innerHTML = `<img src="${CONFIG.art}" alt="Neegy" />`;
  }

  // gentle ambient check: new day = new quests
  setInterval(() => {
    store.quests();
    renderQuests();
  }, 60000);

  console.info('%cneegy · online', 'color:#7c7cf0');
}

init();
