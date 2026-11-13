// Neegy-Talk :: rich text
// Converts a plain string into DOM nodes. No innerHTML anywhere, so a message
// can never introduce markup. Links and mentions are found first; inline
// emphasis is applied inside each remaining text run.

const TOKEN = /(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]|@[\p{L}\p{N}_.-]{1,32})/gu;
const INLINE = /(`[^`\n]{1,400}`|\*\*[^*\n]{1,600}\*\*|~~[^~\n]{1,600}~~|(?:^|[\s(])\*[^*\n]{1,600}\*(?=$|[\s).,!?]))/;

function mentionEl(name) {
  const s = document.createElement('span');
  s.className = 'mention';
  s.textContent = '@' + name;
  return s;
}

function linkEl(href) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = href.replace(/^https?:\/\//, '');
  a.rel = 'noopener noreferrer nofollow ugc';
  a.target = '_blank';
  a.className = 'link';
  return a;
}

function wrap(tag, text, depth, names) {
  const node = document.createElement(tag);
  inlineInto(node, text, depth + 1, names);
  return node;
}

function inlineInto(parent, text, depth, names) {
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 200) {
    const m = INLINE.exec(rest);
    if (!m) {
      parent.append(document.createTextNode(rest));
      return;
    }
    let full = m[0];
    let lead = '';
    if (m.index > 0 || (full[0] !== '`' && full[0] !== '*' && full[0] !== '~')) {
      const at = rest.indexOf(full);
      if (at > 0) {
        parent.append(document.createTextNode(rest.slice(0, at)));
        rest = rest.slice(at);
      }
    }
    if (full.startsWith('`')) {
      const c = document.createElement('code');
      c.textContent = full.slice(1, -1);
      parent.append(c);
    } else if (full.startsWith('**')) {
      parent.append(depth < 2 ? wrap('strong', full.slice(2, -2), depth, names) : document.createTextNode(full));
    } else if (full.startsWith('~~')) {
      parent.append(depth < 2 ? wrap('del', full.slice(2, -2), depth, names) : document.createTextNode(full));
    } else if (full.startsWith('*') || full.startsWith(' *') || full.startsWith('\t*')) {
      lead = full.startsWith('*') ? '' : full[0];
      const inner = full.slice(lead.length + 1, -1);
      if (lead) parent.append(document.createTextNode(lead));
      parent.append(depth < 2 ? wrap('em', inner, depth, names) : document.createTextNode(inner));
    } else {
      parent.append(document.createTextNode(full));
    }
    rest = rest.slice(full.length);
  }
  if (rest) parent.append(document.createTextNode(rest));
}

/**
 * @param {string} raw
 * @param {{names?: Set<string>}} [ctx] known display names, for mention styling
 * @returns {DocumentFragment}
 */
export function rich(raw, ctx = {}) {
  const frag = document.createDocumentFragment();
  const src = String(raw ?? '');
  const names = ctx.names || new Set();
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    if (m.index > last) inlineInto(frag, src.slice(last, m.index), 0, names);
    const tok = m[0];
    if (tok.startsWith('@')) {
      const name = tok.slice(1);
      const known = [...names].some((n) => n.toLowerCase() === name.toLowerCase());
      frag.append(known ? mentionEl(name) : document.createTextNode(tok));
    } else {
      frag.append(linkEl(tok));
    }
    last = m.index + tok.length;
  }
  if (last < src.length) inlineInto(frag, src.slice(last), 0, names);
  return frag;
}

/** Plain previews for notifications/titles. */
export function plain(raw, limit = 120) {
  const s = String(raw ?? '')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*|~~|\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}
