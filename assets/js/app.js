// Neegy-Talk :: app
// Wires the socket-free Chat state to the DOM. Everything user-visible is
// built here; all user text goes through rich() which never parses HTML.

import { CONFIG } from './config.js';
import { EMOJI, AVATAR_EMOJI, QUICK_REACTIONS, TIPS, levelByNumber, levelFor } from './data.js';
import { Chat } from './chat.js';
import { ME } from './me.js';
import { Socket, STATUS, wsUrl } from './socket.js';
import { LocalSocket } from './local.js';
import { el, clear, raf, startOfDay } from './dom.js';
import { plain } from './rich.js';
import {
  avatarEl, roomRow, personRow, memberRow, dayDivider, messageEl, toast, modal, openLayer, svgIcon
} from './ui.js';
import { roomId as toRoomId, validName, MAX_TEXT } from './protocol.js';

const $ = (id) => document.getElementById(id);

const LAST_ROOM = 'neegy.room.v2';
const THEME_KEY = 'neegy.theme.v2';

const state = {
  activeRoom: null,
  search: '',
  reply: null,
  editing: null,
  atBottom: true,
  unseen: 0,
  members: [],
  messages: [],
  local: false,
  ready: false
};

/* ── boot ─────────────────────────────────────────────── */

async function boot() {
  initTheme();
  const daily = ME.tick();
  ME.subscribe(onMeChange);
  buildEmojiPicker();
  wireChrome();
  wireComposer();

  const transport = await pickTransport();
  state.local = transport instanceof LocalSocket;

  const chat = new Chat({
    transport,
    me: ME,
    onError: (err) => {
      toast({ kind: 'err', title: labelForError(err), sub: err.message && err.code !== err.message ? err.message : '' });
    }
  });
  state.chat = chat;

  chat.on('ready', ({ room }) => {
    state.ready = true;
    state.activeRoom = room?.id || 'general';
    state.unseen = 0;
    if (room) {
      state.chat.markRead(room.id);
      if (ME.markRoom(room.id)) ME.award('room');
    }
    renderAll({ scroll: true });
    raf(() => $('input')?.focus());
    if (daily.fresh) {
      toast({ kind: 'level', title: `Day ${daily.streak} · +${daily.visit} XP`, sub: 'Streak carries. Keep showing up.', ms: 4800 });
    }
  });

  chat.on('rooms', renderRooms);
  chat.on('room', () => { renderHeader(); renderSide(); });
  chat.on('room-created', (room) => {
    toast({ kind: 'ok', title: `#${room.name} is open`, sub: 'You are the first one here.' });
    chat.join(room.id);
  });
  chat.on('messages', (list) => {
    state.messages = list;
    renderMessages();
  });
  chat.on('presence', (members) => {
    state.members = members;
    renderPeople();
    renderHeader();
    renderSide();
  });
  chat.on('typing', renderTyping);
  chat.on('status', renderStatus);
  chat.on('latency', renderLatency);
  chat.on('react', ({ msg, emoji, by, on }) => {
    if (by === chat.selfId && on) ME.award('reactionGiven');
    if (msg?.author?.id === ME.state.id && on && by !== ME.state.id) ME.award('reactionReceived', 0, { emoji });
    renderMessages();
  });
  chat.on('delete', () => renderMessages());
  chat.on('message', (m) => {
    if (!m.mine && !nearBottom($('log'))) {
      state.unseen += 1;
      updateJump();
    }
  });

  const saved = localStorage.getItem(LAST_ROOM);
  const start = chat.roomById(saved) ? saved : 'general';
  chat.start(start);
  syncLayout();

  // Keep the ratchet honest: refresh presence clocks and the daily counter.
  setInterval(() => {
    if (ME.state.xpDay !== todayKey()) ME.tick();
    chat.setTyping(false);
  }, 60_000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      chat.markRead(state.activeRoom);
      if (nearBottom($('log'))) state.unseen = 0;
      renderRooms();
    }
  });

  window.addEventListener('beforeunload', () => chat.setTyping(false));
  window.addEventListener('resize', () => {
    if (!window.matchMedia('(hover: none)').matches) return;
    syncLayout();
  });

  setTimeout(() => {
    if (state.ready && !sessionStorage.getItem('neegy.tip')) {
      sessionStorage.setItem('neegy.tip', '1');
      toast({ title: TIPS[Math.floor(Math.random() * TIPS.length)], ms: 6000 });
    }
  }, 9000);
}

function syncLayout() {
  const app = $('app');
  if (window.innerWidth >= 1180) app.dataset.side = 'open';
  else app.dataset.side = 'closed';
  if (app.dataset.rail === 'open' && window.innerWidth >= 900) app.dataset.rail = 'closed';
  $('scrim').hidden = app.dataset.rail !== 'open' && app.dataset.side !== 'open' || window.innerWidth >= 1180;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function pickTransport() {
  const mode = CONFIG.chat.mode || 'auto';
  if (mode === 'local') return new LocalSocket({});
  const ok = await probe();
  if (ok) return new Socket({ url: wsUrl() });
  if (mode === 'server') {
    // Explicit server mode still reports failure through the socket status.
    return new Socket({ url: wsUrl() });
  }
  return new LocalSocket({});
}

function probe() {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), 2600);
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      finish(false);
      return;
    }
    ws.addEventListener('open', () => finish(true));
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
  });
}

/* ── render ───────────────────────────────────────────── */

function renderAll({ scroll = false } = {}) {
  const chat = state.chat;
  const room = chat.room || { id: 'general', name: 'general', topic: '', icon: '#' };
  state.activeRoom = room.id;
  document.title = `#${room.name} · Neegy-Talk`;
  $('roomName').textContent = '#' + room.name;
  $('roomTopic').textContent = room.topic || 'No topic yet.';
  $('input').placeholder = `Message #${room.name}`;
  $('emptyRoom').textContent = '#' + room.name;
  $('sideName').textContent = '#' + room.name;
  $('sideTopic').textContent = room.topic || 'No topic yet.';
  $('sideIcon').textContent = room.icon || '#';
  renderRooms();
  renderPeople();
  renderMessages({ force: true });
  renderSide();
  renderMe();
  renderStatus(chat.status);
  if (scroll) scrollToBottom(false);
}

function renderRooms() {
  const chat = state.chat;
  if (!chat) return;
  const list = $('roomList');
  const filter = state.search.trim().toLowerCase();
  const rooms = chat.rooms.filter((r) => !filter || r.name.toLowerCase().includes(filter) || (r.topic || '').toLowerCase().includes(filter));
  clear(list);
  for (const room of rooms) {
    list.append(
      roomRow(room, {
        active: room.id === state.activeRoom,
        unread: chat.unread.get(room.id) || 0,
        onSelect: () => selectRoom(room.id)
      })
    );
  }
  $('roomEmpty').hidden = rooms.length > 0;
}

function renderMessages({ force = false } = {}) {
  const log = $('log');
  const skull = $('bootSkel');
  if (skull && !skull.hidden) skull.hidden = true;
  const atBottom = force || nearBottom(log);
  const prevTop = log.scrollTop;
  clear(log);

  const msgs = state.messages;
  if (!msgs.length) {
    $('logEmpty').hidden = false;
  } else {
    $('logEmpty').hidden = true;
  }

  const names = new Set();
  for (const m of msgs) if (m.author?.name) names.add(m.author.name);
  for (const p of state.members) if (p.name) names.add(p.name);
  const byId = new Map(msgs.map((m) => [m.id, m]));

  let lastDay = '';
  let prev = null;
  const frag = document.createDocumentFragment();

  for (const msg of msgs) {
    const day = startOfDay(msg.ts);
    if (day !== lastDay) {
      frag.append(dayDivider(msg.ts));
      lastDay = day;
      prev = null;
    }
    const grouped =
      prev &&
      prev.author?.id === msg.author?.id &&
      msg.ts - prev.ts < 5 * 60_000 &&
      !msg.replyTo &&
      prev.author?.id === msg.author?.id;
    frag.append(
      messageEl(msg, {
        selfId: state.chat.selfId || ME.state.id,
        names: [...names],
        grouped,
        byId: (id) => byId.get(id),
        handlers: {
          onReply: startReply,
          onEdit: startEdit,
          onDelete: deleteMessage,
          onReact: (m, emoji, on) => state.chat.react(m.id, emoji, on),
          onOpenReactions: openReactionPop,
          onProfile: showProfileOf
        }
      })
    );
    prev = msg;
  }

  log.append(frag);
  if (atBottom) scrollToBottom(false);
  else log.scrollTop = prevTop;
  updateJump();
}

function renderPeople() {
  const list = $('peopleList');
  clear(list);
  const selfId = state.chat?.selfId || ME.state.id;
  const members = state.members.length ? state.members : [{ id: ME.state.id, name: ME.state.name, hue: ME.state.hue, emoji: ME.state.emoji, level: ME.level.n }];
  const sorted = [...members].sort((a, b) => (Number(b.level) || 1) - (Number(a.level) || 1) || a.name.localeCompare(b.name));
  for (const m of sorted.slice(0, 40)) list.append(personRow(m, selfId));
  $('onlineCount').textContent = String(members.length);
}

function renderHeader() {
  const stack = $('headStack');
  clear(stack);
  const list = state.members.slice(0, 4);
  for (const m of list) stack.append(avatarEl(m, { size: 'xs', ring: false }));
  if (state.members.length > 4) stack.append(el('span', { class: 'more' }, `+${state.members.length - 4}`));
}

function renderSide() {
  const chat = state.chat;
  if (!chat) return;
  const list = $('memberList');
  clear(list);
  const selfId = chat.selfId || ME.state.id;
  const members = state.members.length ? state.members : [{ id: ME.state.id, name: ME.state.name, hue: ME.state.hue, emoji: ME.state.emoji, level: ME.level.n }];
  for (const m of [...members].sort((a, b) => (Number(b.level) || 1) - (Number(a.level) || 1) || a.name.localeCompare(b.name))) {
    list.append(memberRow(m, selfId));
  }
  $('sideCount').textContent = String(members.length);
  renderLevelCard();
}

function renderLevelCard() {
  const lvl = ME.level;
  const p = ME.progress;
  $('levelNum').textContent = String(lvl.n);
  $('levelName').textContent = lvl.name;
  $('levelPerk').textContent = lvl.perk;
  $('levelXp').style.width = `${Math.round(p.pct * 100)}%`;
  $('levelFoot').textContent = ME.isMax ? `${ME.state.xp.toLocaleString()} XP · max` : `${p.left.toLocaleString()} XP to ${ME.next.name}`;
}

function renderMe() {
  const s = ME.state;
  const lvl = ME.level;
  const av = $('meAvatar');
  av.className = 'avatar';
  av.dataset.emoji = s.emoji ? 'true' : 'false';
  if (s.emoji) av.dataset.emoji = 'true';
  else delete av.dataset.emoji;
  av.style.setProperty('--a-hue', String(s.hue));
  av.textContent = s.emoji || initialsOf(s.name);
  av.setAttribute('aria-hidden', 'true');
  $('meName').textContent = s.name;
  $('meLevelName').textContent = lvl.name;
  $('meBadge').textContent = String(lvl.n);
  const light = document.documentElement.dataset.theme === 'light';
  const accent = light ? `hsl(${lvl.hue} 72% 46%)` : `hsl(${lvl.hue} 88% 70%)`;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-soft', `hsl(${lvl.hue} 85% 65% / ${light ? 0.14 : 0.16})`);
  $('meXp').style.width = `${Math.round(ME.progress.pct * 100)}%`;
  renderLevelCard();
}

function renderTyping() {
  const chat = state.chat;
  const line = $('typingLine');
  const others = [...chat.typing.entries()].filter(([id]) => id !== chat.selfId);
  if (!others.length) {
    line.hidden = true;
    return;
  }
  const names = others.map(([id, v]) => v.name || state.members.find((m) => m.id === id)?.name || 'someone');
  line.hidden = false;
  $('typingText').textContent =
    names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : `${names.length} people are typing`;
}

function renderStatus(status) {
  const pill = $('connPill');
  const bar = $('statusBar');
  const map = {
    [STATUS.OPEN]: ['open', 'live'],
    [STATUS.CONNECTING]: ['connecting', 'connecting'],
    [STATUS.RECONNECTING]: ['reconnecting', 'reconnecting'],
    [STATUS.CLOSED]: ['closed', 'offline'],
    local: ['local', 'this browser only']
  };
  const [key, label] = map[status] || ['idle', 'connecting'];
  pill.dataset.state = key;
  pill.lastElementChild.textContent = label;

  if (key === 'reconnecting') {
    bar.hidden = false;
    $('statusText').textContent = 'Connection lost — retrying. Messages will send when it is back.';
  } else if (key === 'closed') {
    bar.hidden = false;
    $('statusText').textContent = 'Disconnected.';
  } else if (key === 'local') {
    bar.hidden = false;
    $('statusText').textContent = 'Local mode — no chat server reached. Tabs in this browser can see each other; other devices cannot. Run server.py or set CONFIG.wsUrl to go live.';
  } else {
    bar.hidden = true;
  }
}

function renderLatency(ms) {
  const pill = $('connPill');
  if (pill.dataset.state === 'open') pill.title = `${ms} ms round trip`;
}

function updateJump() {
  const jump = $('jump');
  if (state.unseen > 0 && !state.atBottom) {
    jump.hidden = false;
    $('jumpText').textContent = state.unseen === 1 ? '1 new message' : `${state.unseen} new messages`;
  } else {
    jump.hidden = true;
  }
}

/* ── scrolling ────────────────────────────────────────── */

function nearBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 90;
}

function scrollToBottom(smooth = true) {
  const log = $('log');
  if (!log) return;
  if (smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  else log.scrollTop = log.scrollHeight;
  state.atBottom = true;
  state.unseen = 0;
  updateJump();
}

/* ── interactions ─────────────────────────────────────── */

function selectRoom(id) {
  if (state.chat.room?.id === id) {
    closeDrawers();
    return;
  }
  closeDrawers();
  state.reply = null;
  state.editing = null;
  state.unseen = 0;
  clearStrip();
  localStorage.setItem(LAST_ROOM, id);
  state.chat.join(id);
  $('log').scrollTop = 0;
}

function startReply(msg) {
  state.editing = null;
  state.reply = msg;
  setStrip('Replying to ' + (msg.author?.name || 'someone'), plain(msg.text, 120));
  $('input').focus();
}

function startEdit(msg) {
  if (msg.author?.id !== (state.chat.selfId || ME.state.id)) return;
  state.reply = null;
  state.editing = msg;
  setStrip('Editing message', plain(msg.text, 120));
  const input = $('input');
  input.value = msg.text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoGrow();
  updateCounter();
}

function deleteMessage(msg) {
  state.chat.remove(msg.id);
  toast({ kind: 'ok', title: 'Message deleted', ms: 2000 });
}

function setStrip(label, text) {
  $('strip').hidden = false;
  $('stripLabel').textContent = label;
  $('stripText').textContent = text;
}

function clearStrip() {
  $('strip').hidden = true;
  $('stripLabel').textContent = '';
  $('stripText').textContent = '';
}

function openReactionPop(msg, anchor) {
  const existing = anchor.parentElement.querySelector('.react-pop');
  if (existing) {
    existing.remove();
    return;
  }
  const pop = el('div', { class: 'picker react-pop', role: 'menu', 'aria-label': 'React' });
  const grid = el('div', { class: 'picker-grid' });
  grid.style.gridTemplateColumns = 'repeat(6, 1fr)';
  for (const emoji of QUICK_REACTIONS) {
    const b = el('button', { type: 'button', role: 'menuitem' }, emoji);
    b.addEventListener('click', () => {
      state.chat.react(msg.id, emoji, true);
      pop.remove();
    });
    grid.append(b);
  }
  pop.append(grid);
  pop.style.width = '224px';
  pop.style.left = 'auto';
  pop.style.right = '0';
  anchor.parentElement.append(pop);
  setTimeout(() => {
    const off = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        document.removeEventListener('click', off, true);
      }
    };
    document.addEventListener('click', off, true);
  }, 0);
}

function showProfileOf(author) {
  if (!author) return;
  const lvl = levelByNumber(Number(author.level) || levelFor(0).n);
  const body = el(
    'div',
    null,
    el(
      'div',
      { class: 'profile-head' },
      avatarEl({ ...author, level: author.level }, { size: 'md' }),
      el(
        'div',
        null,
        el('div', { class: 'profile-name' }, author.name),
        el('div', { class: 'profile-sub' }, `Level ${author.level || 1} · ${lvl.name}`)
      )
    ),
    el('p', { class: 'profile-sub' }, author.id === (state.chat.selfId || ME.state.id) ? 'This is you.' : 'Levels are local to each browser. Names are not unique.')
  );
  modal({ title: 'Profile', body });
}

function openProfileEditor() {
  const s = ME.state;
  const nameField = el('label', { class: 'field' }, el('span', null, 'Display name'));
  const nameInput = el('input', { type: 'text', value: s.name, maxlength: '24', autocomplete: 'off', spellcheck: 'false' });
  nameField.append(nameInput, el('small', null, '2–24 characters. Letters, numbers, spaces, dots, dashes.'));

  const hueWrap = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Avatar colour' });
  let hue = s.hue;
  for (let h = 0; h < 360; h += 30) {
    const b = el('button', { class: 'swatch hue', type: 'button', dataset: { on: String(h === Math.round(hue / 30) * 30) }, style: { '--h': h }, 'aria-label': `Hue ${h}` }, '');
    b.addEventListener('click', () => {
      hue = h;
      hueWrap.querySelectorAll('.swatch').forEach((n) => (n.dataset.on = 'false'));
      b.dataset.on = 'true';
    });
    hueWrap.append(b);
  }

  const emojiWrap = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Avatar icon' });
  const none = el('button', { class: 'swatch', type: 'button', dataset: { on: String(!s.emoji) }, 'aria-label': 'Initials' }, 'AB');
  let emoji = s.emoji;
  none.addEventListener('click', () => {
    emoji = null;
    emojiWrap.querySelectorAll('.swatch').forEach((n) => (n.dataset.on = 'false'));
    none.dataset.on = 'true';
  });
  emojiWrap.append(none);
  for (const e of AVATAR_EMOJI) {
    const b = el('button', { class: 'swatch', type: 'button', dataset: { on: String(s.emoji === e) }, 'aria-label': e }, e);
    b.addEventListener('click', () => {
      emoji = e;
      emojiWrap.querySelectorAll('.swatch').forEach((n) => (n.dataset.on = 'false'));
      b.dataset.on = 'true';
    });
    emojiWrap.append(b);
  }

  const stats = el(
    'div',
    { class: 'stat-row' },
    el('div', { class: 'stat' }, el('b', null, String(ME.level.n)), el('span', null, 'level')),
    el('div', { class: 'stat' }, el('b', null, ME.state.xp.toLocaleString()), el('span', null, 'xp')),
    el('div', { class: 'stat' }, el('b', null, String(ME.state.streak)), el('span', null, 'day streak'))
  );

  const body = el(
    'div',
    null,
    stats,
    nameField,
    el('label', { class: 'field' }, el('span', null, 'Colour'), hueWrap),
    el('label', { class: 'field' }, el('span', null, 'Icon'), emojiWrap)
  );

  modal({
    title: 'Your profile',
    sub: 'Stored in this browser. Nobody else can see your XP.',
    body,
    actions: [
      {
        label: 'Reset progress',
        kind: 'ghost',
        onClick: (close) => {
          close();
          confirmReset();
        }
      },
      {
        label: 'Save',
        kind: 'primary',
        onClick: (close) => {
          const next = nameInput.value.trim();
          if (!validName(next)) {
            nameInput.focus();
            nameInput.style.borderColor = 'var(--danger)';
            toast({ kind: 'err', title: 'Pick a longer name', sub: 'At least 2 characters, starting with a letter or number.' });
            return;
          }
          ME.setName(next);
          ME.setHue(hue);
          ME.setEmoji(emoji);
          state.chat?.pushProfile();
          close();
          renderMe();
          renderMessages();
          toast({ kind: 'ok', title: 'Saved', sub: 'Your profile is updated.' });
        }
      }
    ]
  });
}

function confirmReset() {
  modal({
    title: 'Reset everything?',
    sub: 'Your level, streak and saved rooms go back to zero. Messages you already sent stay.',
    body: el('p', { class: 'profile-sub' }, 'This cannot be undone.'),
    actions: [
      { label: 'Keep it', kind: 'ghost', onClick: (close) => close() },
      {
        label: 'Reset',
        kind: 'danger',
        onClick: (close) => {
          ME.reset();
          close();
          renderMe();
          toast({ kind: 'ok', title: 'Reset', sub: 'Back to Stranger.' });
        }
      }
    ]
  });
}

function openCreateRoom() {
  if (ME.level.n < 3) {
    toast({ kind: 'err', title: 'Rooms unlock at level 3', sub: `You are level ${ME.level.n}. Keep talking.` });
    return;
  }
  const nameInput = el('input', { type: 'text', placeholder: 'design', maxlength: '24', autocomplete: 'off', spellcheck: 'false' });
  const topicInput = el('input', { type: 'text', placeholder: 'What is this room for?', maxlength: '80', autocomplete: 'off' });
  const icons = ['💬', '🎨', '🎮', '📚', '🔧', '🌙', '☕', '🧠', '🎵', '🌿'];
  let icon = icons[0];
  const iconWrap = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Room icon' });
  for (const i of icons) {
    const b = el('button', { class: 'swatch', type: 'button', dataset: { on: String(i === icon) }, 'aria-label': i }, i);
    b.addEventListener('click', () => {
      icon = i;
      iconWrap.querySelectorAll('.swatch').forEach((n) => (n.dataset.on = 'false'));
      b.dataset.on = 'true';
    });
    iconWrap.append(b);
  }

  const preview = el('small', null, 'This becomes #your-name in the sidebar.');
  const body = el(
    'div',
    null,
    el('label', { class: 'field' }, el('span', null, 'Room name'), nameInput, preview),
    el('label', { class: 'field' }, el('span', null, 'Topic'), topicInput),
    el('label', { class: 'field' }, el('span', null, 'Icon'), iconWrap)
  );

  nameInput.addEventListener('input', () => {
    const id = toRoomId(nameInput.value);
    preview.textContent = id ? `This becomes #${id} in the sidebar.` : 'Letters and numbers, at least two.';
  });

  modal({
    title: 'New room',
    sub: 'Rooms are shared. Anyone here can join.',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (close) => close() },
      {
        label: 'Create',
        kind: 'primary',
        onClick: (close) => {
          const name = nameInput.value.trim();
          const id = toRoomId(name);
          if (id.length < 2) {
            nameInput.focus();
            toast({ kind: 'err', title: 'Give it a longer name' });
            return;
          }
          if (state.chat.rooms.some((r) => r.id === id)) {
            toast({ kind: 'err', title: 'That room already exists' });
            return;
          }
          state.chat.createRoom({ name, topic: topicInput.value.trim(), icon });
          close();
        }
      }
    ]
  });
}

function openPalette() {
  const input = el('input', { type: 'text', placeholder: 'Jump to a room…', 'aria-label': 'Search rooms', autocomplete: 'off' });
  const list = el('div', { class: 'palette-list', role: 'listbox' });
  const card = el('div', { class: 'modal palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Room switcher' });
  card.append(el('div', { class: 'palette-input' }, svgIcon('i-search'), input), list);

  let shown = [];
  let cursor = 0;

  const paint = () => {
    const q = input.value.trim().toLowerCase();
    shown = state.chat.rooms.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.topic || '').toLowerCase().includes(q)).slice(0, 8);
    cursor = Math.min(cursor, Math.max(0, shown.length - 1));
    clear(list);
    if (!shown.length) {
      list.append(el('div', { class: 'palette-empty' }, 'No room matches that.'));
      return;
    }
    shown.forEach((room, i) => {
      const item = el(
        'button',
        { class: 'palette-item', type: 'button', dataset: { on: String(i === cursor) }, role: 'option' },
        el('span', { class: 'room-icon' }, room.icon || '#'),
        el('span', null, '#' + room.name),
        el('small', null, room.topic || '')
      );
      item.addEventListener('click', () => {
        handle.close();
        selectRoom(room.id);
      });
      list.append(item);
    });
  };

  const handle = openLayer(card);
  input.addEventListener('input', () => {
    cursor = 0;
    paint();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      cursor = Math.min(cursor + 1, shown.length - 1);
      paint();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      cursor = Math.max(0, cursor - 1);
      paint();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const room = shown[cursor];
      if (room) {
        handle.close();
        selectRoom(room.id);
      }
    }
  });
  paint();
  setTimeout(() => input.focus(), 30);
}

/* ── composer ─────────────────────────────────────────── */

function wireComposer() {
  const input = $('input');
  const form = $('composer');
  const send = $('sendBtn');

  const update = () => {
    autoGrow();
    updateCounter();
    send.disabled = !input.value.trim();
    if (input.value.trim()) state.chat?.setTyping(true);
    else state.chat?.setTyping(false);
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      if (state.reply || state.editing) {
        ev.preventDefault();
        cancelStrip();
      }
    } else if (ev.key === 'ArrowUp' && !input.value) {
      const last = [...state.messages].reverse().find((m) => (m.author?.id === (state.chat?.selfId || ME.state.id)) && !m.pending);
      if (last) {
        ev.preventDefault();
        startEdit(last);
      }
    }
  });
  input.addEventListener('paste', () => setTimeout(update, 0));

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });

  $('stripClose').addEventListener('click', cancelStrip);
  $('jump').addEventListener('click', () => scrollToBottom(true));
  $('emojiBtn').addEventListener('click', toggleEmoji);

  $('log').addEventListener('scroll', () => {
    state.atBottom = nearBottom($('log'));
    if (state.atBottom) {
      state.unseen = 0;
      updateJump();
    }
  });

  update();
}

function submit() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.chat?.ready) return;

  if (state.editing) {
    state.chat.edit(state.editing.id, text);
    state.editing = null;
    clearStrip();
  } else {
    const msg = state.chat.send(text, state.reply?.id || null);
    if (msg) {
      state.reply = null;
      clearStrip();
      ME.award('message');
      if (ME.markRoom(state.activeRoom)) ME.award('room');
    }
  }

  input.value = '';
  autoGrow();
  updateCounter();
  $('sendBtn').disabled = true;
  state.chat.setTyping(false);
  scrollToBottom(true);
  input.focus();
}

function cancelStrip() {
  state.reply = null;
  state.editing = null;
  clearStrip();
  if (state.editing) {
    $('input').value = '';
    autoGrow();
    updateCounter();
  }
  $('input').focus();
}

function autoGrow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
}

function updateCounter() {
  const n = $('input').value.length;
  const counter = $('counter');
  counter.dataset.show = String(n > MAX_TEXT * 0.8);
  counter.textContent = `${n}/${MAX_TEXT}`;
  if (n > MAX_TEXT) counter.textContent = `${MAX_TEXT - n}`;
}

function buildEmojiPicker() {
  const wrap = el('div', { class: 'picker', id: 'picker', hidden: true, role: 'dialog', 'aria-label': 'Emoji' });
  const head = el('div', { class: 'picker-head' }, el('span', null, 'Emoji'));
  const grid = el('div', { class: 'picker-grid' });
  for (const e of EMOJI) {
    const b = el('button', { type: 'button' }, e);
    b.addEventListener('click', () => insertAtCaret(e));
    grid.append(b);
  }
  wrap.append(head, grid);
  document.querySelector('.composer-box').append(wrap);
}

function toggleEmoji() {
  const picker = $('picker');
  const open = !picker.hidden;
  closeEmoji();
  if (open) return;
  picker.hidden = false;
  $('emojiBtn').setAttribute('aria-expanded', 'true');

  const off = (ev) => {
    if (picker.contains(ev.target) || ev.target.closest('#emojiBtn')) return;
    closeEmoji();
    document.removeEventListener('click', off, true);
  };
  setTimeout(() => document.addEventListener('click', off, true), 0);
  $('input').focus();
}

function closeEmoji() {
  const picker = $('picker');
  if (!picker) return;
  picker.hidden = true;
  $('emojiBtn').setAttribute('aria-expanded', 'false');
}

function insertAtCaret(text) {
  const input = $('input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  autoGrow();
  updateCounter();
  $('sendBtn').disabled = !input.value.trim();
  state.chat?.setTyping(true);
}

/* ── chrome ───────────────────────────────────────────── */

function wireChrome() {
  $('menuBtn').addEventListener('click', () => toggleRail(true));
  $('railClose').addEventListener('click', () => toggleRail(false));
  $('sideBtn')?.addEventListener('click', () => toggleSide());
  $('sideBtn2')?.addEventListener('click', () => toggleSide());
  $('sideClose').addEventListener('click', () => toggleSide(false));
  $('scrim').addEventListener('click', () => {
    toggleRail(false);
    toggleSide(false);
  });

  $('meCard').addEventListener('click', openProfileEditor);
  $('newRoomBtn').addEventListener('click', openCreateRoom);
  $('themeBtn').addEventListener('click', toggleTheme);

  $('roomSearch').addEventListener('input', (ev) => {
    state.search = ev.target.value;
    renderRooms();
  });
  $('roomSearch').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.target.value = '';
      state.search = '';
      renderRooms();
      ev.target.blur();
    }
  });

  document.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      openPalette();
      return;
    }
    if (ev.key === 'Escape') {
      if (document.getElementById('layer').hidden === false) return;
      toggleRail(false);
      toggleSide(false);
      closeEmoji();
    }
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#composer')) closeEmoji();
  });

  const log = $('log');
  log.addEventListener('scroll', () => {
    state.atBottom = nearBottom(log);
  }, { passive: true });

  // Keep the host element scrollable on iOS without rubber-banding the page.
  document.body.addEventListener('touchmove', () => {}, { passive: true });
}

function toggleRail(open) {
  const app = $('app');
  const next = open ?? app.dataset.rail !== 'open';
  app.dataset.rail = next ? 'open' : 'closed';
  $('scrim').hidden = !next && app.dataset.side !== 'open';
}

function toggleSide(open) {
  const app = $('app');
  const next = open ?? app.dataset.side !== 'open';
  app.dataset.side = next ? 'open' : 'closed';
  $('scrim').hidden = !next && app.dataset.rail !== 'open';
}

function closeDrawers() {
  const app = $('app');
  if (window.innerWidth < 900) app.dataset.rail = 'closed';
  if (window.innerWidth < 1180) app.dataset.side = 'closed';
  $('scrim').hidden = true;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const theme = saved || (prefersLight ? 'light' : 'dark');
  applyTheme(theme);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('app').dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fc' : '#08090f');
}

/* ── me changes ───────────────────────────────────────── */

function onMeChange(_s, detail) {
  renderMe();
  if (detail?.levelUp) {
    const lvl = levelByNumber(detail.levelUp);
    toast({ kind: 'level', title: `Level ${lvl.n} — ${lvl.name}`, sub: lvl.perk, ms: 5200 });
  }
}

/* ── helpers ──────────────────────────────────────────── */

function initialsOf(name) {
  const parts = String(name).trim().split(/[\s_.-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function labelForError(err) {
  switch (err?.code) {
    case 'rate':
      return 'Slow down a moment';
    case 'muted':
      return 'You are muted in this room';
    case 'too_long':
      return 'That message is too long';
    case 'room_exists':
      return 'That room already exists';
    case 'room_limit':
      return 'Too many rooms';
    case 'bad_room':
      return 'That room name will not work';
    case 'offline':
      return 'Not connected';
    default:
      return 'Something did not go through';
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
