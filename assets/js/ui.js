// Neegy-Talk :: views
// Pure builders: state in, DOM out. No fetches, no globals, no listeners
// beyond the callbacks passed in.

import { el, initials, fmtTime, fmtDay } from './dom.js';
import { rich, plain } from './rich.js';

const TOUCH = window.matchMedia('(hover: none)').matches;

export function ringFor(level) {
  if (level >= 10) return '3';
  if (level >= 6) return '2';
  return null;
}

export function avatarEl(user, { size = 'md', ring = true } = {}) {
  const level = Number(user?.level) || 1;
  const hue = Number(user?.hue) || 250;
  const node = el('span', {
    class: 'avatar',
    dataset: {
      ...(size !== 'md' ? { size } : {}),
      ...(ring && ringFor(level) ? { ring: ringFor(level) } : {}),
      ...(user?.emoji ? { emoji: 'true' } : {})
    }
  });
  node.style.setProperty('--a-hue', String(hue));
  node.textContent = user?.emoji || initials(user?.name || '?');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function roomRow(room, { active, unread, onSelect }) {
  const btn = el(
    'button',
    {
      class: 'room',
      type: 'button',
      dataset: { active: String(!!active), unread: String(!!unread) },
      'aria-current': active ? 'true' : null
    },
    el('span', { class: 'room-icon', 'aria-hidden': 'true' }, room.icon || '#'),
    el(
      'span',
      { class: 'room-body' },
      el('span', { class: 'room-name' }, room.name),
      el('span', { class: 'room-sub' }, room.last ? `${room.last.author}: ${room.last.text}` : room.topic || 'No messages yet')
    ),
    el(
      'span',
      { class: 'room-meta' },
      room.last ? el('span', { class: 'room-time' }, fmtTime(room.last.ts)) : null,
      unread ? el('span', { class: 'badge dot', 'aria-label': 'unread' }) : null
    )
  );
  btn.addEventListener('click', () => onSelect(room));
  return el('li', null, btn);
}

export function personRow(member, selfId) {
  return el(
    'li',
    null,
    el(
      'div',
      { class: 'person', dataset: { self: String(member.id === selfId) } },
      avatarEl(member, { size: 'sm', ring: false }),
      el('span', { class: 'person-name' }, member.id === selfId ? `${member.name} (you)` : member.name),
      el('span', { class: 'person-level' }, String(member.level || 1))
    )
  );
}

export function memberRow(member, selfId) {
  return el(
    'li',
    null,
    el(
      'div',
      { class: 'member', dataset: { self: String(member.id === selfId) } },
      avatarEl(member, { size: 'sm' }),
      el('span', { class: 'member-name' }, member.name),
      member.id === selfId ? el('span', { class: 'member-tag' }, 'you') : el('span', { class: 'member-lvl' }, String(member.level || 1))
    )
  );
}

export function dayDivider(ts) {
  return el('li', { class: 'day', role: 'separator' }, fmtDay(ts));
}

/**
 * @param {object} msg
 * @param {object} ctx
 * @param {string[]} ctx.names
 * @param {string} ctx.selfId
 * @param {boolean} ctx.grouped
 * @param {object} ctx.handlers
 */
export function messageEl(msg, ctx) {
  const { selfId, names, grouped, handlers } = ctx;
  const mine = msg.author?.id === selfId;
  const level = Number(msg.author?.level) || 1;
  const li = el('li', {
    class: 'msg',
    dataset: {
      id: msg.id,
      mine: String(mine),
      grouped: String(!!grouped),
      pending: String(!!msg.pending),
      failed: String(!!msg.failed)
    }
  });
  li.tabIndex = -1;

  const gutter = el('div', { class: 'msg-gutter' });
  if (grouped) {
    gutter.append(el('span', { class: 'msg-time-float' }, fmtTime(msg.ts)));
  } else {
    gutter.append(avatarEl(msg.author));
  }

  const body = el('div', { class: 'msg-body' });

  if (!grouped) {
    const head = el('div', { class: 'msg-head' });
    const name = el('button', { class: 'msg-name', type: 'button', title: `Level ${level}` }, msg.author?.name || 'someone');
    name.addEventListener('click', () => handlers.onProfile?.(msg.author));
    head.append(name);
    if (level > 1) head.append(el('span', { class: 'msg-level' }, 'lv ' + level));
    else head.append(el('span', { class: 'msg-level' }, 'lv 1'));
    head.append(el('span', { class: 'msg-time' }, fmtTime(msg.ts)));
    if (msg.edited) head.append(el('span', { class: 'msg-tag' }, 'edited'));
    body.append(head);
  } else if (msg.edited) {
    body.append(el('div', { class: 'msg-head' }, el('span', { class: 'msg-tag' }, 'edited')));
  }

  if (msg.replyTo) {
    const target = ctx.byId?.(msg.replyTo);
    body.append(
      el(
        'div',
        { class: 'msg-reply' },
        el('b', null, target?.author?.name || 'someone'),
        el('span', null, target ? plain(target.text, 90) : 'message unavailable')
      )
    );
  }

  const text = el('div', { class: 'msg-text' });
  text.append(rich(msg.text, { names: new Set(names) }));
  body.append(text);

  const reactions = Object.entries(msg.reactions || {}).filter(([, who]) => who?.length);
  if (reactions.length) {
    const row = el('div', { class: 'msg-reactions' });
    for (const [emoji, who] of reactions.sort((a, b) => b[1].length - a[1].length)) {
      const btn = el(
        'button',
        {
          class: 'reaction',
          type: 'button',
          dataset: { mine: String(who.includes(selfId)) },
          'aria-label': `${emoji} ${who.length} ${who.length === 1 ? 'reaction' : 'reactions'}`,
          'aria-pressed': String(who.includes(selfId))
        },
        el('span', { class: 'emoji', 'aria-hidden': 'true' }, emoji),
        el('span', null, String(who.length))
      );
      btn.addEventListener('click', () => handlers.onReact?.(msg, emoji, !who.includes(selfId)));
      row.append(btn);
    }
    body.append(row);
  }

  const tools = toolsFor(msg, mine, handlers, li);
  li.append(gutter, body);
  if (TOUCH) body.append(tools);
  else li.append(tools);
  return li;
}

function toolsFor(msg, mine, handlers, li) {
  const tools = el('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Message actions' });

  const reply = iconButton('i-reply', 'Reply', () => handlers.onReply?.(msg));
  tools.append(reply);

  const react = el('button', { class: 'icon-btn react-btn', type: 'button', title: 'React', 'aria-label': 'React' }, '☺');
  react.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onOpenReactions?.(msg, react);
  });
  tools.append(react);

  if (mine) {
    tools.append(iconButton('i-edit', 'Edit', () => handlers.onEdit?.(msg)));
    tools.append(iconButton('i-trash', 'Delete', () => handlers.onDelete?.(msg)));
  }

  tools.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') li.focus();
  });
  return tools;
}

function iconButton(icon, label, onClick) {
  const b = el('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + icon);
  svg.append(use);
  b.append(svg);
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/* ── overlays ─────────────────────────────────────────── */

let toastTimer = 0;

export function toast({ kind = 'info', title, sub = '', ms = 3600 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const icon = kind === 'level' ? svgIcon('i-spark') : el('span', null, kind === 'err' ? '!' : kind === 'ok' ? '✓' : 'i');
  const node = el(
    'div',
    { class: 'toast', dataset: { kind }, role: 'status' },
    el('span', { class: 'toast-icon' }, icon),
    el('div', { class: 'toast-body' }, el('div', { class: 'toast-title' }, title), sub ? el('div', { class: 'toast-sub' }, sub) : null)
  );
  host.append(node);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    node.style.transition = 'opacity .18s ease, transform .18s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 200);
  }, ms);
  return node;
}

export function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

export function openLayer(content, { onClose, className = '' } = {}) {
  const layer = document.getElementById('layer');
  layer.hidden = false;
  layer.replaceChildren();
  if (className) layer.classList.add(className);
  layer.append(content);
  const close = () => {
    layer.hidden = true;
    layer.replaceChildren();
    onClose?.();
  };
  layer.addEventListener('click', (ev) => {
    if (ev.target === layer) close();
  });
  const esc = (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
      document.removeEventListener('keydown', esc, true);
    }
  };
  document.addEventListener('keydown', esc, true);
  return { close, node: layer };
}

export function modal({ title, sub, body, actions = [], wide = false }) {
  const head = el('div', { class: 'modal-head' }, el('div', null, el('h2', null, title), sub ? el('p', null, sub) : null));
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  if (wide) card.style.width = 'min(560px, 100%)';

  let handle;
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, svgIcon('i-close'));
  head.append(closeBtn);

  const foot = actions.length
    ? el(
        'div',
        { class: 'modal-foot' },
        ...actions.map((a) => {
          const b = el('button', { class: 'btn ' + (a.kind ? 'btn-' + a.kind : ''), type: 'button' }, a.label);
          b.addEventListener('click', () => a.onClick?.(handle.close));
          return b;
        })
      )
    : null;

  card.append(head, el('div', { class: 'modal-body' }, body), ...(foot ? [foot] : []));
  handle = openLayer(card);
  closeBtn.addEventListener('click', () => handle.close());

  const first = card.querySelector('input, textarea, button.btn-primary');
  setTimeout(() => first?.focus(), 40);
  return handle;
}

export { el };
