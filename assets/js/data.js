// Neegy-Talk :: static data
// Levels, XP rates, seed rooms, emoji. Tune the numbers here and nowhere else.

export const LEVELS = [
  { n: 1,  name: 'Stranger',        xp: 0,     hue: 232, perk: 'You can post.' },
  { n: 2,  name: 'Heard',           xp: 120,   hue: 240, perk: 'Avatar emoji unlocked.' },
  { n: 3,  name: 'Regular',         xp: 300,   hue: 252, perk: 'You can create rooms.' },
  { n: 4,  name: 'Familiar',        xp: 580,   hue: 264, perk: 'Name gets a halo.' },
  { n: 5,  name: 'Confidant',       xp: 950,   hue: 190, perk: 'Confidant badge.' },
  { n: 6,  name: 'Kept',            xp: 1420,  hue: 176, perk: 'Avatar ring, level 2.' },
  { n: 7,  name: 'Anchor',          xp: 2050,  hue: 158, perk: 'Anchor badge.' },
  { n: 8,  name: 'Signal',          xp: 2800,  hue: 130, perk: 'Name glows on hover.' },
  { n: 9,  name: 'Kindred',         xp: 3750,  hue: 96,   perk: 'Kindred badge.' },
  { n: 10, name: 'Resonance',       xp: 4900,  hue: 48,   perk: 'Avatar ring, level 3.' },
  { n: 11, name: 'Luminary',        xp: 6250,  hue: 30,   perk: 'Your messages tint warm.' },
  { n: 12, name: 'Constellation',   xp: 7800,  hue: 340, perk: 'Constellation badge.' },
  { n: 13, name: 'Static Saint',    xp: 9600,  hue: 320, perk: 'Static Saint badge.' },
  { n: 14, name: "Neegy's Own",     xp: 11700, hue: 300, perk: "Neegy's Own badge." },
  { n: 15, name: 'Same Wavelength', xp: 14200, hue: 280, perk: 'Permanent glow.' }
];

export const MAX_LEVEL = LEVELS[LEVELS.length - 1].n;

export function levelFor(xp) {
  let found = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.xp) found = l;
  return found;
}

export function levelByNumber(n) {
  return LEVELS.find((l) => l.n === n) || LEVELS[0];
}

export function nextLevel(n) {
  return LEVELS.find((l) => l.n === n + 1) || null;
}

export function progress(xp) {
  const cur = levelFor(xp);
  const nxt = nextLevel(cur.n);
  if (!nxt) return { pct: 1, into: 0, span: 0, left: 0 };
  const span = nxt.xp - cur.xp;
  const into = xp - cur.xp;
  return { pct: Math.max(0, Math.min(1, into / span)), into, span, left: nxt.xp - xp };
}

// XP is earned by being in the room with people. All local to the browser.
export const XP = {
  message: 4,
  messageCooldownMs: 20_000,
  messageDailyCap: 200,
  newRoomBonus: 10,
  reactionGiven: 1,
  reactionGivenDailyCap: 30,
  reactionReceived: 3,
  reactionReceivedDailyCap: 60,
  dailyVisit: 15,
  streakBonus: 5,
  streakCap: 50
};

export const SEED_ROOMS = [
  { id: 'general',  name: 'general',  icon: '💬', topic: 'Anything. Start here.',           pinned: true },
  { id: 'intros',   name: 'intros',   icon: '👋', topic: 'Who you are, once.',              pinned: true },
  { id: 'offtopic', name: 'off-topic', icon: '🌀', topic: 'The other ninety percent.',      pinned: true },
  { id: 'music',    name: 'music',    icon: '🎧', topic: 'What is on loop right now.',      pinned: false },
  { id: 'help',     name: 'help',     icon: '🛠️', topic: 'Ask, answer, move on.',           pinned: false }
];

export const QUICK_REACTIONS = ['🔥', '😂', '👀', '💜', '✅', '😭'];

export const EMOJI = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚',
  '😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖',
  '😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔',
  '🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴',
  '🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','🤖','🎃',
  '😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','👋','🤚','✋','🖖','👌','🤌','✌️','🤞',
  '🫶','🤝','🙏','💪','🧠','👀','🔥','✨','💥','💫','⭐','🌟','🌈','☀️','🌙','⚡','❄️','💧','🌊','🍀',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','🎉'
];

export const AVATAR_EMOJI = [
  '😎','🦊','🐺','🐱','🐸','🦉','🐙','🦋','🌵','🍄','🪐','🌙','⚡','🔥','🌊','🍜','🎧','🎸','🕹️','🧩',
  '🛰️','🧪','🪄','🗿','👾','🤖','🦈','🐝','🍒','🧊'
];

export const TIPS = [
  'Shift + Enter starts a new line. Enter sends.',
  'Hover a message to react, reply, edit, or delete.',
  'Type @ to mention someone in the room.',
  'Ctrl / Cmd + K jumps between rooms.',
  'React with 🔥 on anything you want to see again.',
  'Your level is local to this browser. The messages are shared.',
  'Create a room from the + next to Rooms once you hit level 3.'
];
