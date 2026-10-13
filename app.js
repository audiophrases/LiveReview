// Live Watch: follows a Lichess player and shows their games live through the
// public streaming API, with Stockfish analysis on top.
//
// Lichess delays the public game stream by three plies for spectators. When the
// game is featured on a Lichess TV channel, the channel feed is real-time, so we
// listen to it as well and slot each position in by ply number; the delayed
// stream then fills in whatever the TV feed skipped.

const API = 'https://lichess.org';
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = 'abcdefgh';
const USER_POLL_MS = 4000;
const TV_CHECK_MS = 10000;
const RATE_LIMIT_WAIT_MS = 60000;
const LAST_USER_KEY = 'livewatch.user';
const SOURCE_KEY = 'livewatch.source';  // what was watched last: 'user' or 'folder'
const ENGINE_KEY = 'livewatch.engine';
const SOUND_KEY = 'livewatch.sound';
const OPTS_KEY = 'livewatch.opts';
const SWEEP_DEPTH = 12;  // every position, two lines, for the move symbols
const SWEEP_LINES = 2;
const ANALYSABLE = ['standard', 'fromPosition', 'chess960'];

const FOLDER_POLL_MS = 200;
const THEME_KEY = 'livewatch.theme';

const KINDS = {
  brilliant: { sym: '!!', word: 'Brilliant' },
  great: { sym: '!', word: 'Great move' },
  best: { sym: '★', word: 'Best move' },
  interesting: { sym: '!?', word: 'Interesting' },
  inaccuracy: { sym: '?!', word: 'Inaccuracy' },
  mistake: { sym: '?', word: 'Mistake' },
  blunder: { sym: '??', word: 'Blunder' },
};

const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'), barTop: $('barTop'), barBottom: $('barBottom'),
  status: $('status'), meta: $('meta'), moves: $('moves'), open: $('open'),
  live: $('live'), flip: $('flip'), sound: $('sound'),
  userForm: $('userForm'), userInput: $('userInput'), folderBtn: $('folderBtn'), themeToggle: $('themeToggle'),
  engine: $('engine'), engineToggle: $('engineToggle'), bestToggle: $('bestToggle'),
  altToggle: $('altToggle'), tacticsToggle: $('tacticsToggle'), subopts: $('tacticOpts'), legend: $('legend'), worst: $('worst'), worstTitle: $('worstTitle'), tally: $('tally'),
  settings: $('settings'), boardwrap: document.querySelector('.boardwrap'),
  evalbar: $('evalbar'), evalfill: $('evalfill'), evaltext: $('evaltext'),
};

const state = {
  user: null,          // { name, id } of the player being followed
  session: 0,          // bumped whenever the followed player changes, so stale callbacks drop out
  gameCtrl: null,      // AbortController for the game stream
  tvCtrl: null,        // AbortController for the TV channel feed, while the game is featured
  pollTimer: null,
  tvTimer: null,
  folder: null,        // { handle, timer, file, mtime, size, lines } while following a folder of .jsonl files
  game: null,
  view: null,          // ply index being viewed, or null to follow live
  orientation: 'white',
  flipped: false,
  sound: true,
  analysis: true,
  opts: {
    bar: true, arrow: true, alts: true, lines: true, symbols: true, worst: true,
    tactics: false, tMate: true, tUndefended: true, tPinned: true, tCheckable: true, tQueen: true, tCapture: false,
    tFork: true, tPin: true, tSkewer: true, tDiscovered: true, tPressure: true, tRemoval: true, tZwischen: true,
    threats: false, depth: 18, multipv: 3,
  },
};
try {
  state.analysis = localStorage.getItem(ENGINE_KEY) !== 'off';
  state.sound = localStorage.getItem(SOUND_KEY) !== 'off';
  const saved = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') || {};
  Object.assign(state.opts, saved);
  // Carry the old arrow preferences into their replacement position badges.
  if (!('tUndefended' in saved) && ('tHanging' in saved || 'tTrade' in saved)) {
    state.opts.tUndefended = (saved.tHanging ?? true) || (saved.tTrade ?? true);
  }
  if (!('tPinned' in saved) && 'tPin' in saved) state.opts.tPinned = !!saved.tPin;
  if (!('tCheckable' in saved) && 'tCheck' in saved) state.opts.tCheckable = !!saved.tCheck;
  for (const retired of ['tHanging', 'tTrade', 'tCheck']) delete state.opts[retired];
} catch { /* optional */ }

function saveOpts() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(state.opts)); } catch { /* optional */ }
}

// ---------- streaming ----------

async function streamNdjson(url, signal, onObj) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/x-ndjson' } });
  if (res.status === 429) throw Object.assign(new Error('rate limited'), { rateLimited: true });
  if (res.status === 404) throw Object.assign(new Error('not found'), { notFound: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onObj(JSON.parse(line));
    }
  }
}

function isAbort(err) {
  return err && err.name === 'AbortError';
}

// ---------- following a player ----------

function watchUser(name) {
  stopFolder();
  state.session++;
  closeGame();
  clearTimeout(state.pollTimer);
  state.user = { name, id: name.toLowerCase() };
  state.game = null;
  state.view = null;
  state.flipped = false;
  el.userInput.value = name;
  try {
    localStorage.setItem(LAST_USER_KEY, name);
    localStorage.setItem(SOURCE_KEY, 'user');
  } catch { /* optional */ }
  clearResume();
  history.replaceState(null, '', `${location.pathname}?user=${encodeURIComponent(name)}`);
  document.title = `${name} · Live Watch`;
  setStatus(`Looking for ${name}…`);
  scheduleRender();
  pollUser(state.session, true);
}

async function pollUser(session, firstLook) {
  clearTimeout(state.pollTimer);
  const name = state.user.name;
  try {
    const res = await fetch(`${API}/api/users/status?ids=${encodeURIComponent(name)}&withGameIds=true`);
    if (session !== state.session) return;
    if (res.status === 429) {
      setStatus('Lichess asked us to slow down. Retrying in a minute…');
      state.pollTimer = setTimeout(() => pollUser(session), RATE_LIMIT_WAIT_MS);
      return;
    }
    const [user] = await res.json();
    if (session !== state.session) return;
    if (!user) {
      setStatus(`No Lichess player called “${name}”.`);
      return;
    }
    state.user = { name: user.name, id: user.id };
    document.title = `${user.name} · Live Watch`;

    const finishedHere = state.game?.over && state.game.id === user.playingId;
    if (user.playingId && !finishedHere && state.game?.id !== user.playingId) {
      openGame(user.playingId, session);
      return;
    }
    // Not playing: show their most recent game while we wait for the next one.
    if (firstLook && !state.game) await openLastGame(session);
    if (session !== state.session) return;
    if (!state.game || state.game.over) {
      const where = user.online ? 'online, not playing right now' : 'offline';
      setWaiting(`${user.name} is ${where}. Their next game opens here as soon as it starts.`);
    }
  } catch (err) {
    if (session !== state.session) return;
    setStatus('Could not reach Lichess. Trying again…');
  }
  state.pollTimer = setTimeout(() => pollUser(session), USER_POLL_MS);
}

async function openLastGame(session) {
  try {
    const res = await fetch(`${API}/api/user/${encodeURIComponent(state.user.id)}/current-game?moves=false&pgnInJson=false`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok || session !== state.session) return;
    const game = await res.json();
    if (game?.id && session === state.session) await openGame(game.id, session, { quiet: true });
  } catch { /* no previous game to show */ }
}

function closeGame() {
  state.gameCtrl?.abort();
  state.gameCtrl = null;
  stopTv();
  clearTimeout(state.tvTimer);
  state.tvTimer = null;
}

async function openGame(id, session, { quiet = false } = {}) {
  closeGame();
  const ctrl = new AbortController();
  state.gameCtrl = ctrl;
  const game = {
    id, info: null, plies: [], base: null, over: false, result: null,
    receivedAt: 0, lastLineAt: 0, waiting: null, version: 0, realtime: false,
  };
  state.game = game;
  state.view = null;
  state.orientation = 'white';
  evals.clear();
  el.open.href = `${API}/${id}`;
  if (!quiet) setStatus('Loading game…');
  scheduleRender();

  try {
    await streamNdjson(`${API}/api/stream/game/${id}`, ctrl.signal, (obj) => {
      if (state.game !== game) return;
      if (obj.id && obj.players) {
        game.info = { ...game.info, ...obj };
        state.orientation = obj.players.black?.user?.id === state.user.id ? 'black' : 'white';
        if (obj.status && !['created', 'started'].includes(obj.status.name ?? obj.status)) finish(game);
      } else if (obj.fen) {
        addPosition(game, obj);
        if (!quiet && !game.over && !state.tvTimer) state.tvTimer = setTimeout(() => checkTv(game), 500);
      }
      scheduleRender();
    });
    if (state.game === game) finish(game);
  } catch (err) {
    if (isAbort(err) || state.game !== game) return;
    if (err.rateLimited) setStatus('Lichess asked us to slow down. Wait a minute and try again.');
    else if (!quiet) setStatus('The game stream dropped.');
    game.over = true;
  }
  stopTv();
  scheduleRender();

  // A live game just ended: start looking for the next one.
  if (!quiet && state.game === game && session === state.session) {
    state.pollTimer = setTimeout(() => pollUser(session), 2000);
  }
}

function finish(game) {
  if (game.over) return;
  game.over = true;
  game.result = resultText(game);
  if (state.game === game) stopTv();
}

// ---------- following a folder of .jsonl files ----------
// Another program appends one JSON object per line as a game goes on:
//   { t, fen, turn, playerColor, gameUrl }
// We follow the newest .jsonl file in a folder the user picks. The folder is remembered (its handle is
// kept in IndexedDB), so the next session picks up where this one left off: straight away when the
// browser still allows reading it, otherwise after one click on "Resume" (browsers only re-grant
// access to a folder from a click).

async function pickFolder() {
  if (resumeHandle) return resumeFolder();
  if (!window.showDirectoryPicker) {
    setStatus('Your browser can’t open folders. Use Chrome, Edge or another Chromium browser (served from localhost).');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'livewatch-games', mode: 'read' });
  } catch {
    return;  // cancelled
  }
  watchFolder(handle);
}

// A tiny IndexedDB key-value store: folder handles can't go in localStorage.
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('livewatch', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
const saveFolderHandle = (handle) => idb('readwrite', (store) => store.put(handle, 'folder')).catch(() => {});
const loadFolderHandle = () => idb('readonly', (store) => store.get('folder')).catch(() => null);

// A remembered folder the browser wants a click before reading again.
let resumeHandle = null;

function offerResume(handle) {
  resumeHandle = handle;
  el.folderBtn.textContent = `Resume “${handle.name}”`;
  el.folderBtn.classList.add('resume');
  el.folderBtn.title = `Keep watching the folder ${handle.name} from last time`;
  setStatus(`Last time you watched the folder “${handle.name}”. Click Resume to carry on (your browser asks once).`);
}

function clearResume() {
  resumeHandle = null;
  el.folderBtn.textContent = 'Watch folder…';
  el.folderBtn.classList.remove('resume');
  el.folderBtn.title = 'Review a game live from the newest .jsonl file in a folder';
}

async function resumeFolder() {
  const handle = resumeHandle;
  let granted = false;
  try {
    granted = (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch { /* the folder may be gone */ }
  clearResume();
  if (granted) {
    watchFolder(handle);
  } else {
    setStatus(`No access to “${handle.name}”. Use Watch folder… to pick it again.`);
  }
}

// On startup: carry on with the folder from last time if that's what was being watched.
// Returns true when the folder took over (watching, or waiting for the Resume click).
async function restoreFolder() {
  let source = null;
  try { source = localStorage.getItem(SOURCE_KEY); } catch { /* optional */ }
  if (source !== 'folder' || !window.showDirectoryPicker) return false;
  const handle = await loadFolderHandle();
  if (!handle) return false;
  let permission = 'prompt';
  try { permission = await handle.queryPermission({ mode: 'read' }); } catch { /* treat as prompt */ }
  if (permission === 'granted') watchFolder(handle);
  else offerResume(handle);
  return true;
}

function stopFolder() {
  if (state.folder) clearTimeout(state.folder.timer);
  state.folder = null;
  el.open.textContent = 'Open on Lichess';
}

function watchFolder(handle) {
  state.session++;
  closeGame();
  clearTimeout(state.pollTimer);
  stopFolder();
  state.user = null;
  state.game = null;
  state.view = null;
  state.flipped = false;
  state.folder = { handle, timer: null, file: null, mtime: 0, size: -1, lines: 0 };
  clearResume();
  saveFolderHandle(handle);
  try { localStorage.setItem(SOURCE_KEY, 'folder'); } catch { /* optional */ }
  el.userInput.value = '';
  el.open.removeAttribute('href');
  history.replaceState(null, '', location.pathname);
  document.title = `${handle.name} · Live Watch`;
  setStatus(`Looking for .jsonl files in ${handle.name}…`);
  scheduleRender();
  pollFolder(state.folder);
}

// File names start with the time the game began (yyyymmddhhmm), so the newest game
// has the greatest name. Files without that prefix rank below, ordered by modified time.
async function newestJsonl(dir) {
  let best = null;
  let bestKey = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !name.toLowerCase().endsWith('.jsonl')) continue;
    const file = await h.getFile();
    const stamp = /^\d{12}/.exec(name)?.[0] || '';
    const key = [stamp, stamp ? name : '', file.lastModified];
    if (!best || compareKeys(key, bestKey) > 0) {
      best = { name, file };
      bestKey = key;
    }
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

async function pollFolder(f) {
  try {
    const found = await newestJsonl(f.handle);
    if (state.folder !== f) return;
    if (!found) {
      if (!state.game) setStatus(`No .jsonl files in ${f.handle.name} yet. Waiting…`);
    } else {
      const { name, file } = found;
      if (name !== f.file || file.lastModified !== f.mtime || file.size !== f.size) {
        const text = await file.text();
        if (state.folder !== f) return;
        const sameFile = name === f.file;
        f.file = name;
        f.mtime = file.lastModified;
        f.size = file.size;
        loadJsonl(f, text, sameFile);
      }
    }
  } catch (err) {
    if (state.folder !== f) return;
    setStatus(`Could not read ${f.handle.name}: ${err.message || err}`);
  }
  if (state.folder === f) f.timer = setTimeout(() => pollFolder(f), FOLDER_POLL_MS);
}

function loadJsonl(f, text, sameFile) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      if (i < lines.length - 1) rows.push(null);  // corrupt line in the middle: skip it
      // a half-written last line is left for the next read
    }
  }
  const done = rows.length;
  let game = state.game;
  // A different file, a shorter file, or a position that goes back in time means a new game.
  const restart = !game || game.source !== f.file || !sameFile || done < f.lines;
  if (restart) {
    const first = rows.find((r) => r?.fen);
    if (!first) return;
    game = newFileGame(f.file, first);
    state.game = game;
    state.view = null;
    evals.clear();
    f.lines = 0;
  }
  const rowsNow = rows.slice(f.lines);
  f.lines = done;
  for (const row of rowsNow) {
    if (!row?.fen) continue;
    if (row.playerColor === 'white' || row.playerColor === 'black') applyPlayerColor(game, row.playerColor);
    if (row.gameUrl && row.gameUrl !== game.url) {
      game.url = row.gameUrl;
      el.open.href = row.gameUrl;
    }
    const ply = fenPly(row.fen);
    const prev = game.plies[ply - game.base - 1];
    // A snapshot is the position only; work out the move that led to it.
    addPosition(game, { fen: row.fen, lm: prev ? inferMove(prev.fen, row.fen) : null });
  }
  const last = game.plies[game.plies.length - 1];
  const t = last && terminal(last.fen);
  if (t && !game.over) {
    game.over = true;
    game.result = t === 'draw' ? '½-½ · Stalemate.' : `${t === 'w' ? '0-1' : '1-0'} · Checkmate.`;
  } else if (!t && game.over) {
    game.over = false;
    game.result = null;
  }
  game.version++;
  scheduleRender();
}

function newFileGame(name, first) {
  el.open.textContent = 'Open game';
  el.open.removeAttribute('href');
  const game = {
    id: `file:${name}:${Date.now()}`, source: name, url: null,
    info: { variant: { key: 'standard', name: 'Standard' }, players: {}, fileName: name },
    plies: [], base: null, over: false, result: null,
    receivedAt: 0, lastLineAt: 0, waiting: null, version: 0, realtime: false,
  };
  applyPlayerColor(game, first.playerColor);
  return game;
}

function applyPlayerColor(game, color) {
  if (color !== 'white' && color !== 'black') return;
  if (game.info.playerColor === color) return;
  game.info.playerColor = color;
  game.info.players = {
    white: { user: { name: color === 'white' ? 'You' : 'Opponent' } },
    black: { user: { name: color === 'black' ? 'You' : 'Opponent' } },
  };
  state.orientation = color;
}

// The move that turns one position into the next, as UCI, or null if it isn't a single legal move.
function inferMove(prevFen, fen) {
  if (!chess.load(prevFen)) return null;
  const want = fen.split(' ').slice(0, 2).join(' ');
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const got = chess.fen().split(' ').slice(0, 2).join(' ');
    chess.undo();
    if (got === want) return m.from + m.to + (m.promotion || '');
  }
  return null;
}

// ---------- real-time moves from Lichess TV ----------

async function checkTv(game) {
  state.tvTimer = null;
  if (state.game !== game || game.over) return;
  if (!state.tvCtrl) {
    try {
      const res = await fetch(`${API}/api/tv/channels`);
      const channels = res.ok ? await res.json() : {};
      const channel = Object.keys(channels).find((k) => channels[k]?.gameId === game.id);
      if (channel && state.game === game && !game.over && !state.tvCtrl) listenTv(game, channel);
    } catch { /* try again on the next check */ }
  }
  if (state.game === game && !game.over) state.tvTimer = setTimeout(() => checkTv(game), TV_CHECK_MS);
}

async function listenTv(game, channel) {
  const ctrl = new AbortController();
  state.tvCtrl = ctrl;
  try {
    await streamNdjson(`${API}/api/tv/${channel}/feed`, ctrl.signal, (msg) => {
      if (state.game !== game || state.tvCtrl !== ctrl) return;
      if (msg.t === 'featured') {
        if (msg.d.id !== game.id) {
          stopTv();
          return;
        }
        game.realtime = true;
        const secs = Object.fromEntries((msg.d.players || []).map((p) => [p.color, p.seconds]));
        addPosition(game, { fen: msg.d.fen, wc: secs.white, bc: secs.black });
      } else if (msg.t === 'fen' && game.realtime) {
        addPosition(game, msg.d);
      }
      scheduleRender();
    });
  } catch { /* fall back to the delayed stream */ }
  if (state.tvCtrl === ctrl) stopTv();
}

function stopTv() {
  state.tvCtrl?.abort();
  state.tvCtrl = null;
  if (state.game?.realtime) {
    state.game.realtime = false;
    scheduleRender();
  }
}

// ---------- game data ----------

const chess = new Chess();

// Plies since the start of the game, read from the FEN's move counter and side to move.
function fenPly(fen) {
  const parts = fen.split(' ');
  return ((+parts[5] || 1) - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
}

// Store a position at its ply. Positions can arrive out of order (TV feed ahead,
// delayed stream behind), so game.plies may have gaps until both catch up.
function addPosition(game, line) {
  const ply = fenPly(line.fen);
  if (game.base == null) game.base = ply;
  const idx = ply - game.base;
  if (idx < 0) return;
  const plies = game.plies;
  const oldLength = plies.length;
  const existing = plies[idx];
  if (existing) {
    // The TV feed's first position has no last move; the stream can supply it.
    if (!existing.lm && line.lm) {
      existing.lm = line.lm;
      existing.san = plies[idx - 1] ? toSan(plies[idx - 1].fen, line.lm) : null;
      game.version++;
    }
    return;
  }
  const entry = { fen: line.fen, lm: line.lm || null, san: null, wc: line.wc, bc: line.bc };
  if (entry.lm && plies[idx - 1]) entry.san = toSan(plies[idx - 1].fen, entry.lm);
  plies[idx] = entry;
  const after = plies[idx + 1];
  if (after?.lm && !after.san) after.san = toSan(entry.fen, after.lm);
  if (idx < oldLength) {
    game.version++;   // filled a gap
    return;
  }
  const now = performance.now();
  // The stream first replays the whole game in one burst; only chime for moves that arrive on their own.
  if (entry.lm && game.lastLineAt && now - game.lastLineAt > 400) playMoveSound(entry.san);
  game.lastLineAt = now;
  game.receivedAt = now;
}

// Lichess sometimes sends castling as king-takes-own-rook; turn it into the king's real move.
function castleFix(fen, uci) {
  if (!uci || !chess.load(fen)) return uci;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const piece = chess.get(from);
  const target = chess.get(to);
  if (piece?.type === 'k' && target?.type === 'r' && target.color === piece.color) {
    return from + (to[0] > from[0] ? 'g' : 'c') + from[1];
  }
  return uci;
}

function toSan(fen, uci) {
  const fixed = castleFix(fen, uci);
  if (!chess.load(fen)) return uci;
  const move = chess.move({ from: fixed.slice(0, 2), to: fixed.slice(2, 4), promotion: fixed[4] });
  return move ? move.san : uci;
}

function resultText(game) {
  const info = game.info || {};
  const status = info.status?.name ?? info.status;
  const winner = info.winner;
  const score = winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : status && status !== 'aborted' ? '½-½' : '';
  const why = {
    mate: 'Checkmate', resign: 'Resignation', outoftime: 'Time out', timeout: 'Opponent left',
    draw: 'Draw', stalemate: 'Stalemate', aborted: 'Game aborted', noStart: 'Game never started',
    cheat: 'Cheat detected', variantEnd: 'Variant ending', insufficientMaterialClaim: 'Insufficient material',
  }[status];
  if (!status) return 'Game over.';
  return [score, why].filter(Boolean).join(' · ') + '.';
}

// ---------- engine ----------
// Single-threaded Stockfish 16 in a Worker, spoken to over UCI. One search runs
// at a time; asking for a new one stops the current search first.

const engine = (() => {
  let worker = null;
  let ready = false;
  let failed = false;
  let current = null;   // job being searched
  let pending = null;   // job to start once the current one stops
  let multipv = 1;
  let chess960 = false;

  function boot() {
    if (worker || failed) return;
    try {
      worker = new Worker('engine/stockfish-nnue-16-single.js');
    } catch {
      failed = true;
      return;
    }
    worker.onerror = () => {
      failed = true;
      scheduleRender();
    };
    worker.onmessage = (e) => handle(String(e.data));
    worker.postMessage('uci');
  }

  function handle(line) {
    if (line === 'uciok') {
      worker.postMessage('setoption name MultiPV value 1');
      worker.postMessage('isready');
    } else if (line === 'readyok') {
      if (!ready) {
        ready = true;
        next();
      }
    } else if (line.startsWith('info ') && current && !current.stopping) {
      const info = parseInfo(line);
      if (info) current.onInfo(info);
    } else if (line.startsWith('bestmove')) {
      const job = current;
      current = null;
      if (job && !job.stopping) job.onDone();
      next();
    }
  }

  function parseInfo(line) {
    const t = line.split(' ');
    const info = { depth: 0, multipv: 1, cp: null, mate: null, pv: [] };
    for (let i = 1; i < t.length; i++) {
      if (t[i] === 'depth') info.depth = +t[++i];
      else if (t[i] === 'multipv') info.multipv = +t[++i];
      else if (t[i] === 'score') {
        const kind = t[++i];
        const v = +t[++i];
        if (kind === 'cp') info.cp = v;
        else info.mate = v;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') return null;
      } else if (t[i] === 'pv') {
        info.pv = t.slice(i + 1);
        break;
      }
    }
    return info.pv.length && (info.cp != null || info.mate != null) ? info : null;
  }

  function next() {
    if (!ready || current || !pending) return;
    const job = pending;
    pending = null;
    current = job;
    if (job.multipv !== multipv) {
      worker.postMessage(`setoption name MultiPV value ${job.multipv}`);
      multipv = job.multipv;
    }
    if (job.chess960 !== chess960) {
      worker.postMessage(`setoption name UCI_Chess960 value ${job.chess960}`);
      chess960 = job.chess960;
    }
    worker.postMessage(`position fen ${job.fen}`);
    worker.postMessage(`go depth ${job.depth}`);
  }

  function stopCurrent() {
    if (current && !current.stopping) {
      current.stopping = true;
      worker.postMessage('stop');
    }
  }

  return {
    get failed() { return failed; },
    // The job being searched, unless it has been told to stop.
    get active() { return current && !current.stopping ? current : null; },
    run(job) {
      boot();
      if (failed) return;
      pending = job;
      if (current) stopCurrent();
      else next();
    },
    halt() {
      pending = null;
      if (worker) stopCurrent();
    },
  };
})();

// fen -> { depth, multipv, lines: [{ depth, cp, mate, pv }] }, scores from White's side.
const evals = new Map();

function canAnalyse(game) {
  const key = game?.info?.variant?.key || 'standard';
  return state.analysis && !engine.failed && ANALYSABLE.includes(key);
}

function pumpEngine() {
  const game = state.game;
  if (!game || !canAnalyse(game) || !game.plies.length) {
    engine.halt();
    return;
  }
  const chess960 = game.info?.variant?.key === 'chess960';
  const want = (fen, depth, multipv) => {
    const e = evals.get(fen);
    return !terminal(fen) && (!e || e.depth < depth || e.multipv < multipv);
  };
  const start = (fen, depth, multipv) => {
    const a = engine.active;
    if (a && a.fen === fen && a.depth === depth && a.multipv === multipv) return;
    engine.run({
      fen, depth, multipv, chess960,
      onInfo: (info) => recordInfo(fen, info),
      onDone: () => {
        const e = evals.get(fen) || newEval(fen);
        e.depth = Math.max(e.depth, depth);
        e.multipv = Math.max(e.multipv, multipv);
        scheduleRender();
      },
    });
  };

  // The position on screen comes first, then a sweep back through the game.
  const viewFen = viewedFen();
  const { depth } = state.opts;
  const multipv = Math.max(state.opts.multipv, state.opts.alts ? 3 : 1);
  if (want(viewFen, depth, multipv)) return start(viewFen, depth, multipv);
  for (let i = game.plies.length - 1; i >= 0; i--) {
    const p = game.plies[i];
    if (p && want(p.fen, SWEEP_DEPTH, SWEEP_LINES)) return start(p.fen, SWEEP_DEPTH, SWEEP_LINES);
  }
}

function newEval(fen) {
  const e = { depth: 0, multipv: 0, lines: [] };
  evals.set(fen, e);
  return e;
}

function recordInfo(fen, info) {
  const e = evals.get(fen) || newEval(fen);
  const sign = fen.split(' ')[1] === 'b' ? -1 : 1;
  const line = {
    depth: info.depth,
    cp: info.cp == null ? null : info.cp * sign,
    mate: info.mate == null ? null : info.mate * sign,
    pv: info.pv,
  };
  // A new search restarts at depth 1; don't let it replace a deeper result for the same slot.
  const old = e.lines[info.multipv - 1];
  if (!old || line.depth >= old.depth) e.lines[info.multipv - 1] = line;
  if (fen === viewedFen()) scheduleRender();
  else scheduleMovesRender();
}

function viewedFen() {
  const idx = currentIndex();
  return idx >= 0 ? state.game.plies[idx].fen : null;
}

// 'w' or 'b' for the side that has been mated, 'draw' for stalemate, null otherwise.
const terminalCache = new Map();
function terminal(fen) {
  if (terminalCache.has(fen)) return terminalCache.get(fen);
  let result = null;
  if (chess.load(fen)) {
    if (chess.in_checkmate()) result = chess.turn();
    else if (chess.in_stalemate()) result = 'draw';
  }
  if (terminalCache.size > 5000) terminalCache.clear();
  terminalCache.set(fen, result);
  return result;
}

// Winning chances from White's side, -1..1 (Lichess's curve).
function winChances(line) {
  if (line.mate != null) return line.mate > 0 ? 1 : -1;
  return 2 / (1 + Math.exp(-0.00368208 * line.cp)) - 1;
}

function positionChances(fen) {
  const t = terminal(fen);
  if (t === 'w') return -1;
  if (t === 'b') return 1;
  if (t === 'draw') return 0;
  const line = evals.get(fen)?.lines[0];
  return line ? winChances(line) : null;
}

// Does the move leave the moved piece where the opponent can win material by taking it?
const sacCache = new Map();
function isSacrifice(fen, uci) {
  const key = `${fen}|${uci}`;
  if (sacCache.has(key)) return sacCache.get(key);
  let result = false;
  const fixed = castleFix(fen, uci);
  if (chess.load(fen)) {
    const m = chess.move({ from: fixed.slice(0, 2), to: fixed.slice(2, 4), promotion: fixed[4] });
    const value = m ? VALUE[m.promotion || m.piece] : 0;
    if (m && value >= 3) {
      const gained = m.captured ? VALUE[m.captured] : 0;
      for (const reply of chess.moves({ verbose: true })) {
        if (reply.to !== m.to) continue;
        chess.move(reply);
        const recapture = chess.moves({ verbose: true }).some((x) => x.to === m.to);
        chess.undo();
        // What the mover nets if the opponent takes: what it captured, minus the piece, plus any recapture.
        if (gained - value + (recapture ? VALUE[reply.piece] : 0) <= -2) {
          result = true;
          break;
        }
      }
    }
  }
  if (sacCache.size > 5000) sacCache.clear();
  sacCache.set(key, result);
  return result;
}

// Winning chances thrown away by the move that produced ply i, from the mover's
// point of view (0 = kept everything, up to 2), or null while not analysed yet.
function moveLoss(i) {
  const plies = state.game?.plies;
  if (!plies || i < 1 || !canAnalyse(state.game)) return null;
  const prev = plies[i - 1];
  const cur = plies[i];
  if (!prev || !cur?.lm) return null;
  const before = positionChances(prev.fen);
  const after = positionChances(cur.fen);
  if (before == null || after == null) return null;
  return (before - after) * (prev.fen.split(' ')[1] === 'w' ? 1 : -1);
}

// What kind of move produced ply i: one of KINDS, or null for an ordinary good move.
function classify(i) {
  const lost = moveLoss(i);
  if (lost == null) return null;
  const prev = state.game.plies[i - 1];
  const cur = state.game.plies[i];
  const before = positionChances(prev.fen);
  const after = positionChances(cur.fen);
  const s = prev.fen.split(' ')[1] === 'w' ? 1 : -1;  // mover's point of view
  if (lost >= 0.3) return 'blunder';
  if (lost >= 0.2) return 'mistake';
  if (lost >= 0.1) return 'inaccuracy';

  const prevLines = evals.get(prev.fen)?.lines || [];
  const bestUci = prevLines[0] ? castleFix(prev.fen, prevLines[0].pv[0]) : null;
  const isBest = castleFix(prev.fen, cur.lm) === bestUci || lost < 0.01;
  const sac = isSacrifice(prev.fen, cur.lm);
  const moverBefore = before * s;
  const moverAfter = after * s;
  if (sac && isBest && moverAfter > -0.1 && moverBefore < 0.95) return 'brilliant';
  if (isBest && prevLines[1] && moverBefore < 0.95 &&
      (winChances(prevLines[0]) - winChances(prevLines[1])) * s >= 0.25) return 'great';
  if (sac && lost < 0.1) return 'interesting';
  if (isBest) return 'best';
  return null;
}

// The same position with the other side to move (a "null move").
function passTurn(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

// Squares holding pieces of one type and colour in the position loaded into `chess`.
function findPieces(type, color) {
  const out = [];
  for (const f of FILES) {
    for (let r = 1; r <= 8; r++) {
      const p = chess.get(f + r);
      if (p && p.type === type && p.color === color) out.push(f + r);
    }
  }
  return out;
}

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Squares of `color`'s pieces that attack `sq` on a fenGrid board (pins ignored).
function attackersOf(grid, sq, color) {
  const f0 = sq.charCodeAt(0) - 97;
  const r0 = +sq[1] - 1;
  const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? grid[7 - r][f] : null);
  const is = (p, types) => p && (p === p.toUpperCase()) === (color === 'w') && types.includes(p.toLowerCase());
  const out = [];
  const add = (f, r) => out.push(FILES[f] + (r + 1));
  const pawnRank = r0 + (color === 'w' ? -1 : 1);
  for (const df of [-1, 1]) if (is(at(f0 + df, pawnRank), 'p')) add(f0 + df, pawnRank);
  for (const [df, dr] of KNIGHT_STEPS) if (is(at(f0 + df, r0 + dr), 'n')) add(f0 + df, r0 + dr);
  for (const [df, dr] of KING_STEPS) {
    if (is(at(f0 + df, r0 + dr), 'k')) add(f0 + df, r0 + dr);
    for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
      const p = grid[7 - r][f];
      if (!p) continue;
      if (is(p, df && dr ? 'qb' : 'qr')) add(f, r);
      break;
    }
  }
  return out;
}

// A copy of a fenGrid board with a chess.js verbose move played on it.
function playOnGrid(grid, m) {
  const g = grid.map((row) => row.slice());
  const at = (sq) => g[8 - +sq[1]][sq.charCodeAt(0) - 97];
  const put = (sq, p) => { g[8 - +sq[1]][sq.charCodeAt(0) - 97] = p; };
  const rank = m.from[1];
  const piece = m.promotion ? (m.color === 'w' ? m.promotion.toUpperCase() : m.promotion) : at(m.from);
  put(m.from, null);
  put(m.to, piece);
  if (m.flags.includes('e')) put(m.to[0] + rank, null);
  if (m.flags.includes('k')) { put('f' + rank, at('h' + rank)); put('h' + rank, null); }
  if (m.flags.includes('q')) { put('d' + rank, at('a' + rank)); put('a' + rank, null); }
  return g;
}

// Tactics open to the side to move, flagged by kind so each can be shown or hidden on its own.
// Only ideas that matter are kept: each one has to win material (or mate) by the exchange count below,
// and then hold up against the opponent's best reply (see forcedWins()).
//   mate        checkmate in one (mates in two come from forcedWins())
//   fork        the moved piece attacks two or more targets it would win (or the king), and survives there
//   skewer      a bishop, rook or queen hits a big piece (or the king); once it moves, the piece behind falls
//   hanging     wins a piece (minor or bigger) that nothing defends
//   removal     captures a piece that was guarding another, which can then be won
//   discovered  moving a piece opens a line onto a valuable target while the moved piece threatens too
//   trade       wins material by capturing a defended piece, once every recapture is played out
//   pin         a bishop, rook or queen pins a piece to a bigger one (or the king) and the pinned piece can be won
//   pressure    adds an attacker so that a defended piece can now be won (attackers vs defenders)
// Forcing moves that win nothing by themselves are only offered when nothing above is on, and only if safe:
//   check       gives check
//   queen       makes a new attack on the enemy queen with a cheaper piece (discovered attacks included)
//   capture     any other capture
// The zwischenzug needs the engine and is worked out separately (see zwischenzug()).
const TACTIC_RANK = {
  capture: 1, queen: 2, check: 3, pressure: 4, pin: 5, trade: 6,
  discovered: 7, removal: 8, hanging: 9, skewer: 10, fork: 11, mate: 12,
};
const TACTIC_OPT = {
  mate: 'tMate', fork: 'tFork', skewer: 'tSkewer', removal: 'tRemoval',
  discovered: 'tDiscovered', pin: 'tPin', pressure: 'tPressure',
  queen: 'tQueen', capture: 'tCapture', zwischen: 'tZwischen',
};
const BADGE_OPT = { undefended: 'tUndefended', pinned: 'tPinned', checkable: 'tCheckable', mate: 'tMate', mateStatus: 'tMate' };
// Keep these detectors for evaluating combinations, but position badges replace their arrows.
const BADGED_TACTICS = new Set(['hanging', 'trade', 'check']);
const SEE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

// Static exchange evaluation: what the mover nets by making the capture m on its square when both
// sides keep recapturing there with their cheapest piece (stopping whenever that is better).
// Hidden attackers that line up behind a piece that has just taken come into play (x-rays).
function exchangeGain(grid, m) {
  const g = playOnGrid(grid, m);
  const gain = [SEE_VALUE[m.captured]];
  let onTarget = SEE_VALUE[m.promotion || m.piece];
  let side = m.color === 'w' ? 'b' : 'w';
  for (let d = 1; d < 32; d++) {
    const attackers = attackersOf(g, m.to, side);
    if (!attackers.length) break;
    let from = attackers[0];
    let cost = Infinity;
    for (const sq of attackers) {
      const v = SEE_VALUE[g[8 - +sq[1]][sq.charCodeAt(0) - 97].toLowerCase()];
      if (v < cost) { cost = v; from = sq; }
    }
    gain.push(onTarget - gain[d - 1]);
    onTarget = cost;
    g[8 - +from[1]][from.charCodeAt(0) - 97] = null;
    side = side === 'w' ? 'b' : 'w';
  }
  for (let d = gain.length - 1; d > 0; d--) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

// ----- board geometry on fenGrid boards (grid[0] is rank 8) -----
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHOGONALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const cellAt = (g, sq) => g[8 - +sq[1]][sq.charCodeAt(0) - 97];
const sqName = (f, r) => FILES[f] + (r + 1);
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const colorOf = (p) => (p === p.toUpperCase() ? 'w' : 'b');
const typeOf = (p) => p.toLowerCase();

// Directions a piece slides in, or null for pawns, knights and kings.
function slideDirs(type) {
  if (type === 'b') return DIAGONALS;
  if (type === 'r') return ORTHOGONALS;
  if (type === 'q') return [...DIAGONALS, ...ORTHOGONALS];
  return null;
}

// Squares attacked by the piece on sq (sliders stop at, and include, the first piece in the way).
function attacksFrom(g, sq) {
  const p = cellAt(g, sq);
  if (!p) return [];
  const f0 = sq.charCodeAt(0) - 97;
  const r0 = +sq[1] - 1;
  const t = typeOf(p);
  const out = [];
  if (t === 'p') {
    const dr = colorOf(p) === 'w' ? 1 : -1;
    for (const df of [-1, 1]) if (onBoard(f0 + df, r0 + dr)) out.push(sqName(f0 + df, r0 + dr));
  } else if (t === 'n' || t === 'k') {
    for (const [df, dr] of t === 'n' ? KNIGHT_STEPS : KING_STEPS) if (onBoard(f0 + df, r0 + dr)) out.push(sqName(f0 + df, r0 + dr));
  } else {
    for (const [df, dr] of slideDirs(t)) {
      for (let f = f0 + df, r = r0 + dr; onBoard(f, r); f += df, r += dr) {
        out.push(sqName(f, r));
        if (g[7 - r][f]) break;
      }
    }
  }
  return out;
}

// The occupied squares met walking from sq (exclusive) in one direction, nearest first.
function piecesAlong(g, sq, df, dr, max = 2) {
  const out = [];
  for (let f = sq.charCodeAt(0) - 97 + df, r = +sq[1] - 1 + dr; onBoard(f, r) && out.length < max; f += df, r += dr) {
    if (g[7 - r][f]) out.push(sqName(f, r));
  }
  return out;
}

// Exchange result for the piece on `from` capturing the piece on `to` (see exchangeGain).
function captureGain(g, from, to) {
  const p = cellAt(g, from);
  const q = cellAt(g, to);
  return exchangeGain(g, { from, to, piece: typeOf(p), captured: typeOf(q), color: colorOf(p), flags: 'c' });
}

// The most the opponent can win by capturing the piece on sq (0 or less: it is safe there).
function pieceAtRisk(g, sq) {
  const them = colorOf(cellAt(g, sq)) === 'w' ? 'b' : 'w';
  let worst = -Infinity;
  for (const a of attackersOf(g, sq, them)) worst = Math.max(worst, captureGain(g, a, sq));
  return worst;
}

// The best `color` can do by capturing on sq: the exchange result of its best capture there.
function bestCaptureOn(g, sq, color) {
  let best = { gain: -Infinity, from: null };
  for (const a of attackersOf(g, sq, color)) {
    const gain = captureGain(g, a, sq);
    if (gain > best.gain) best = { gain, from: a };
  }
  return best;
}

// Each detector returns { lines, gain, key } or null when the move isn't that tactic (or isn't worth it):
// lines are the extra lines drawn with the move ([{ from, to, dash }]), gain is the material it wins
// (pawns), key names the idea so two moves doing the same thing are shown once.
// `grid` is the board before the move m, `after` the board once it is played, `me` the side moving.

// The squares holding pieces of the other side that the piece on sq attacks, with what taking each would win.
function targetsOf(g, sq, me) {
  const out = [];
  for (const t of attacksFrom(g, sq)) {
    const p = cellAt(g, t);
    if (!p || colorOf(p) === me) continue;
    out.push({ sq: t, king: typeOf(p) === 'k', gain: typeOf(p) === 'k' ? Infinity : captureGain(g, sq, t) });
  }
  return out;
}

function detectFork(after, m, me) {
  if (pieceAtRisk(after, m.to) > 0) return null;  // the forking piece would just be taken
  const targets = targetsOf(after, m.to, me).filter((t) => t.king || (SEE_VALUE[typeOf(cellAt(after, t.sq))] >= 3 && t.gain > 0));
  if (targets.length < 2) return null;
  // The opponent saves the most valuable target (or answers the check); the next one falls.
  const gains = targets.map((t) => t.gain).sort((x, y) => y - x);
  const captured = m.captured && !m.flags.includes('e') ? SEE_VALUE[m.captured] : 0;
  return {
    lines: targets.map((t) => ({ from: m.to, to: t.sq })),
    gain: gains[1] + captured,
    key: `fork:${targets.map((t) => t.sq).sort().join()}`,
  };
}

// Pins and skewers made by the moved bishop, rook or queen: { pin, skewer }.
function detectLine(after, m, me) {
  const mover = cellAt(after, m.to);
  const dirs = slideDirs(typeOf(mover));
  if (!dirs || pieceAtRisk(after, m.to) > 0) return {};
  const fx = m.from.charCodeAt(0) - m.to.charCodeAt(0);
  const fy = +m.from[1] - +m.to[1];
  const found = {};
  for (const [df, dr] of dirs) {
    if (fx * dr - fy * df === 0) continue;  // moved along this line: the pin or skewer was already there
    const [a, b] = piecesAlong(after, m.to, df, dr);
    if (!a || !b) continue;
    const A = cellAt(after, a);
    const B = cellAt(after, b);
    if (colorOf(A) === me || colorOf(B) === me) continue;
    const vA = SEE_VALUE[typeOf(A)];
    const vB = SEE_VALUE[typeOf(B)];
    if (vA < vB && vA >= 3) {
      // A pin matters when the pinned piece, which can't step aside, can now be won.
      const gain = bestCaptureOn(after, a, me).gain;
      if (gain >= 1 && !(found.pin?.gain >= gain)) found.pin = { lines: [{ from: m.to, to: b }], gain, key: `pin:${a}` };
    } else if (vA > vB && vB >= 3) {
      // A skewer: once the front piece gets out of the way, the one behind is taken.
      const g2 = after.map((row) => row.slice());
      g2[8 - +a[1]][a.charCodeAt(0) - 97] = null;
      const gain = captureGain(g2, m.to, b);
      if (gain >= 2 && !(found.skewer?.gain >= gain)) found.skewer = { lines: [{ from: m.to, to: b }], gain, key: `skewer:${b}` };
    }
  }
  return found;
}

// A bishop, rook or queen behind the moved piece now hits something, while the moved piece threatens too
// (or gives a discovered check while it captures or attacks something).
function detectDiscovered(grid, after, m, me) {
  if (m.flags.includes('k') || m.flags.includes('q')) return null;
  // What the moved piece achieves on its own: a capture, or a second target it would win.
  const moverHits = targetsOf(after, m.to, me).filter((t) => !t.king && t.gain >= 2);
  let best = null;
  for (const [df, dr] of [...DIAGONALS, ...ORTHOGONALS]) {
    const [behind] = piecesAlong(after, m.from, -df, -dr, 1);
    if (!behind || behind === m.to) continue;  // the moved piece itself is not a discovery
    const S = cellAt(after, behind);
    if (colorOf(S) !== me || !slideDirs(typeOf(S))?.some(([x, y]) => x === df && y === dr)) continue;
    const [target] = piecesAlong(after, m.from, df, dr, 1);
    if (!target || target === m.to) continue;
    const T = cellAt(after, target);
    if (colorOf(T) === me) continue;
    const check = typeOf(T) === 'k';
    const hits = moverHits.filter((t) => t.sq !== target);
    const captured = m.captured && !m.flags.includes('e')
      ? (check ? SEE_VALUE[m.captured] : exchangeGain(grid, m)) : 0;
    const moverGain = Math.max(captured, ...hits.map((t) => t.gain), 0);
    // A discovered check lets the moved piece take or win what it hits; otherwise the opponent saves the bigger piece.
    const gain = check ? moverGain : Math.min(captureGain(after, behind, target), moverGain);
    if (gain < 1 || (best && best.gain >= gain)) continue;
    const lines = [{ from: behind, to: target }];
    const hit = hits.sort((x, y) => y.gain - x.gain)[0];
    if (hit && hit.gain >= captured) lines.push({ from: m.to, to: hit.sq });
    best = { lines, gain, key: `disc:${behind}${target}` };
  }
  return best;
}

// The move adds an attacker so that a defended piece, safe until now, can be won (attackers vs defenders).
function detectPressure(grid, after, m, me) {
  if (pieceAtRisk(after, m.to) > 0) return null;
  const them = me === 'w' ? 'b' : 'w';
  let best = null;
  for (const sq of attacksFrom(after, m.to)) {
    const p = cellAt(after, sq);
    if (!p || colorOf(p) === me || typeOf(p) === 'k' || SEE_VALUE[typeOf(p)] < 3) continue;
    const attackers = attackersOf(after, sq, me);
    const defenders = attackersOf(after, sq, them);
    if (attackers.length < 2 || !defenders.length) continue;
    if (bestCaptureOn(grid, sq, me).gain > 0) continue;  // already winnable: this move isn't what does it
    const gain = bestCaptureOn(after, sq, me).gain;
    if (gain < 1 || (best && best.gain >= gain)) continue;
    best = {
      lines: [
        ...attackers.filter((x) => x !== m.to).map((x) => ({ from: x, to: sq })),
        { from: m.to, to: sq },
        ...defenders.map((x) => ({ from: x, to: sq, dash: true })),
      ],
      gain,
      key: `pressure:${sq}`,
    };
  }
  return best;
}

// Capturing a piece that guarded another, which can then be won.
function detectRemoval(grid, after, m, me) {
  if (!m.captured || m.flags.includes('e')) return null;
  const first = exchangeGain(grid, m);
  if (first < 0) return null;
  let best = null;
  for (const sq of attacksFrom(grid, m.to)) {
    const T = cellAt(grid, sq);
    if (!T || colorOf(T) === me || typeOf(T) === 'k' || SEE_VALUE[typeOf(T)] < 3) continue;
    if (bestCaptureOn(grid, sq, me).gain >= 2) continue;  // already winnable: nothing needed removing
    const next = bestCaptureOn(after, sq, me);
    if (next.gain < 2 || (best && best.gain >= next.gain + first)) continue;
    best = { lines: [{ from: next.from, to: sq, dash: true }], gain: next.gain + first, key: `removal:${sq}` };
  }
  return best;
}

// Every tactical idea for the side to move, whatever the settings:
// [{ from, to, cost, kinds: [...], extra: { kind: { lines, gain, key, safe } } }].
const FORCING_KINDS = new Set(['check', 'queen', 'capture']);
const tacticsCache = new Map();
function tacticMoves(fen) {
  if (tacticsCache.has(fen)) return tacticsCache.get(fen);
  const found = new Map();  // keyed by from+to, so the four promotions count once
  if (chess.load(fen)) {
    const me = chess.turn();
    const them = me === 'w' ? 'b' : 'w';
    const grid = fenGrid(fen);
    const queens = findPieces('q', them);
    // Pieces already hitting the queen don't count as new attacks.
    const before = new Set(queens.flatMap((q) => attackersOf(grid, q, me)));
    for (const m of chess.moves({ verbose: true })) {
      const after = playOnGrid(grid, m);
      const safe = pieceAtRisk(after, m.to) <= 0;
      const extra = {};
      const note = (kind, info) => { if (info) extra[kind] = info; };
      if (m.san.endsWith('#')) note('mate', { lines: [], gain: 1000, key: `mate:${m.from}${m.to}` });
      else if (m.san.endsWith('+')) note('check', { lines: [], gain: 0, key: `check:${m.from}${m.to}`, safe });
      if (m.captured) {
        note('capture', { lines: [], gain: 0, key: `capture:${m.from}${m.to}`, safe });
        if (!m.flags.includes('e')) {
          const defended = attackersOf(after, m.to, them).length > 0;
          if (!defended && SEE_VALUE[m.captured] >= 3) {
            note('hanging', { lines: [], gain: SEE_VALUE[m.captured], key: `win:${m.to}` });
          } else if (defended) {
            const gain = exchangeGain(grid, m);
            if (gain >= 1) note('trade', { lines: [], gain, key: `win:${m.to}` });
          }
        }
      }
      if (queens.length && m.captured !== 'q' && SEE_VALUE[m.piece] < 9) {
        if (queens.some((q) => attackersOf(after, q, me).some((sq) => !before.has(sq === m.to ? m.from : sq)))) {
          note('queen', { lines: [], gain: 0, key: `queen:${m.from}${m.to}`, safe });
        }
      }
      note('fork', detectFork(after, m, me));
      const line = detectLine(after, m, me);
      note('pin', line.pin);
      note('skewer', line.skewer);
      note('discovered', detectDiscovered(grid, after, m, me));
      note('pressure', detectPressure(grid, after, m, me));
      note('removal', detectRemoval(grid, after, m, me));
      const kinds = Object.keys(extra);
      if (!kinds.length) continue;
      const key = m.from + m.to;
      const old = found.get(key);
      if (old) {
        for (const k of kinds) if (!old.extra[k]) { old.extra[k] = extra[k]; old.kinds.push(k); }
      } else {
        found.set(key, { from: m.from, to: m.to, cost: SEE_VALUE[m.piece], kinds, extra });
      }
    }
  }
  const result = [...found.values()];
  if (tacticsCache.size > 2000) tacticsCache.clear();
  tacticsCache.set(fen, result);
  return result;
}

// Which of two candidate arrows is worth more: more material first, then the stronger kind, then the cheaper piece.
function strongerTactic(a, b) {
  if (a.gain !== b.gain) return a.gain > b.gain;
  if (TACTIC_RANK[a.kind] !== TACTIC_RANK[b.kind]) return TACTIC_RANK[a.kind] > TACTIC_RANK[b.kind];
  return a.cost < b.cost;
}

// What to draw for the side to move in `fen`: a mate if there is one (and nothing else), otherwise the
// `max` ideas that win the most, each idea once and each move once with its most valuable kind. When
// nothing wins material, one safe attack on the queen or optional capture may be offered.
// Every winning idea has to stand up to the opponent's best reply (see forcedWins()), which also
// turns up the mates in two the rules above don't see.
function tactics(fen, { max = 2, forcing = true } = {}) {
  const verdict = forcedWins(fen);
  const ideas = new Map();
  const consider = (c) => {
    if (!ideas.has(c.key) || strongerTactic(c, ideas.get(c.key))) ideas.set(c.key, c);
  };
  for (const t of tacticMoves(fen)) {
    let best = null;
    for (const kind of t.kinds) {
      if (BADGED_TACTICS.has(kind)) continue;
      if (!state.opts[TACTIC_OPT[kind]]) continue;
      const info = t.extra[kind];
      if (FORCING_KINDS.has(kind) && !info.safe) continue;
      let gain = info.gain;
      if (!FORCING_KINDS.has(kind)) {
        gain = verdict.gainOf(t.from + t.to);
        if (gain === null) continue;   // the reply refutes it
        if (gain === undefined) gain = info.gain;   // not checked in time: the rules decide
      }
      const c = { from: t.from, to: t.to, cost: t.cost, kind, lines: info.lines, gain, key: info.key };
      if (!best || strongerTactic(c, best)) best = c;
    }
    if (best) consider(best);
  }
  if (state.opts.tMate) {
    const grid = fenGrid(fen);
    for (const [move, gain] of verdict.wins) {
      if (gain !== MATE_IN_TWO) continue;
      const from = move.slice(0, 2);
      const to = move.slice(2, 4);
      consider({ from, to, cost: SEE_VALUE[typeOf(cellAt(grid, from))], kind: 'mate', lines: [], gain, key: `mate:${move}` });
    }
  }
  const all = [...ideas.values()].sort((a, b) => (strongerTactic(a, b) ? -1 : 1));
  const mates = all.filter((c) => c.kind === 'mate');
  if (mates.length) return withBackup(fen, mates.slice(0, 2));
  const winning = all.filter((c) => !FORCING_KINDS.has(c.kind) && c.gain >= 1).slice(0, max);
  if (winning.length || !forcing) return withBackup(fen, winning);
  return all.filter((c) => FORCING_KINDS.has(c.kind)).slice(0, 1);
}

// Adds to each idea's lines the pieces backing it up: ours guarding the square the move lands
// on, when the opponent attacks it (the queen behind a forking bishop, say).
const BACKED_KINDS = new Set(['mate', 'fork', 'skewer', 'pin', 'discovered', 'removal']);
function withBackup(fen, picked) {
  return picked.map((c) => {
    if (!BACKED_KINDS.has(c.kind)) return c;
    const extra = guardLines(fen, c.from, c.to).filter((g) => !c.lines.some((x) => x.from === g.from && x.to === g.to));
    return extra.length ? { ...c, lines: [...c.lines, ...extra] } : c;
  });
}

// The tactic the last move just carried out, if any (a fork, pin, skewer... now standing on the board):
// { kind, lines } for the most valuable enabled one.
function lastMoveTactic(idx) {
  const plies = state.game?.plies;
  const ply = plies?.[idx];
  const prev = plies?.[idx - 1];
  if (!ply?.lm || !prev) return null;
  const uci = castleFix(prev.fen, ply.lm);
  const t = tacticMoves(prev.fen).find((x) => x.from === uci.slice(0, 2) && x.to === uci.slice(2, 4));
  if (!t || forcedWins(prev.fen).gainOf(t.from + t.to) === null) return null;
  let best = null;
  for (const kind of ['fork', 'skewer', 'discovered', 'removal']) {
    const info = t.extra[kind];
    if (!info || !state.opts[TACTIC_OPT[kind]]) continue;
    if (!best || info.gain > best.gain) best = { kind, lines: info.lines, gain: info.gain };
  }
  return best;
}

// Zwischenzug: our piece was just captured and we can take back, but the engine's best move is
// something else first, with the recapture coming on our following move.
// { from, to, later } (later: the delayed recapture, as UCI), or null.
function zwischenzug(idx) {
  const plies = state.game?.plies;
  const ply = plies?.[idx];
  const prev = plies?.[idx - 1];
  if (!ply?.lm || !prev) return null;
  const sq = castleFix(prev.fen, ply.lm).slice(2, 4);
  const victim = cellAt(fenGrid(prev.fen), sq);
  const me = ply.fen.split(' ')[1];
  if (!victim || colorOf(victim) !== me) return null;
  const best = evals.get(ply.fen)?.lines[0];
  if (!best || best.depth < 10 || best.pv.length < 3) return null;
  const [first, , later] = best.pv;
  if (first.slice(2, 4) === sq || later.slice(2, 4) !== sq) return null;
  if (!chess.load(ply.fen) || !chess.moves({ verbose: true }).some((m) => m.to === sq)) return null;
  return { from: first.slice(0, 2), to: first.slice(2, 4), later };
}

// ---------- checking tactics against the reply ----------
// The rules above look one move deep. Before a winning idea is drawn it has to stand up to
// the opponent's best answer, checked by a material search of its own (no engine, so it keeps
// up with a fast live game): the move, every reply to it, then checks and captures until the
// exchanges settle. The same search turns up mates in two.
const MATE = 1000;
const MATE_IN_TWO = MATE - 1;
const Q_DEPTH = 8;            // plies of captures, enough to settle an exchange on one square
const NODE_BUDGET = 40000;    // per position, so a wild one can't stall the board
const OUT_OF_NODES = {};
const STEPS = { n: [33, 31, 18, 14, -14, -18, -31, -33], k: [1, 15, 16, 17, -1, -15, -16, -17] };
const RAYS = { b: [15, 17, -15, -17], r: [1, 16, -1, -16], q: [1, 15, 16, 17, -1, -15, -16, -17] };
const TYPE = {};
for (const t of 'pnbrqk') TYPE[t] = TYPE[t.toUpperCase()] = t;
let searchNodes = 0;

// Squares on the search's 0x88 board: index = rank * 16 + file.
const idx88 = (sq) => (+sq[1] - 1) * 16 + sq.charCodeAt(0) - 97;
const sq88 = (s) => FILES[s & 7] + ((s >> 4) + 1);
const sideOf = (p) => (p < 'a' ? 'w' : 'b');
const otherSide = (c) => (c === 'w' ? 'b' : 'w');
const own = (pos) => (pos.side === 'w' ? pos.mat : -pos.mat);
const slides = (type, d) => type === 'q' || type === (Math.abs(d) === 1 || Math.abs(d) === 16 ? 'r' : 'b');

// What each move wins by force: { wins, gainOf }. `wins` maps from+to to the pawns it wins
// (MATE for mate in one, MATE_IN_TWO for a mate in two) for the moves that win something;
// gainOf(from+to) gives that, null if the move wins nothing, or undefined if the search ran
// out of time before getting to it. A quiet move only counts if it wins more than the side
// to move wins anyway (threats the opponent can't parry even with a free move).
const winsCache = new Map();
function forcedWins(fen) {
  if (winsCache.has(fen)) return winsCache.get(fen);
  const wins = new Map();
  const checked = new Set();
  if (chess.load(fen)) {
    const roots = chess.moves({ verbose: true });
    const inCheck = chess.in_check();
    const pos = board88(fen);
    const us = pos.side;
    const base = own(pos);
    searchNodes = 0;
    try {
      let free = 0;
      if (!inCheck) {
        const ep = pos.ep;
        pos.side = otherSide(us);
        pos.ep = -1;
        free = Math.max(0, -bestReply(pos, -MATE, MATE) - base);
        pos.side = us;
        pos.ep = ep;
      }
      for (const rm of roots) {
        if (rm.promotion && rm.promotion !== 'q') continue;
        const key = rm.from + rm.to;
        if (rm.san.endsWith('#')) {
          wins.set(key, MATE);
        } else if (free < MATE / 2) {   // else mate comes anyway: only the mating moves count
          const need = base + 1 + (rm.captured ? 0 : free);
          const m = { from: idx88(rm.from), to: idx88(rm.to), promo: rm.promotion, ep: rm.flags.includes('e') };
          const u = makeMove(pos, m);
          const score = -bestReply(pos, -MATE, 1 - need);
          unmakeMove(pos, u);
          if (score >= need) wins.set(key, score >= MATE / 2 ? MATE_IN_TWO : score - base);
        }
        checked.add(key);
      }
    } catch (err) {
      if (err !== OUT_OF_NODES) throw err;   // out of time: the rest goes unchecked
    }
  }
  const verdict = { wins, gainOf: (move) => (wins.has(move) ? wins.get(move) : checked.has(move) ? null : undefined) };
  if (winsCache.size > 2000) winsCache.clear();
  winsCache.set(fen, verdict);
  return verdict;
}

// Our pieces guarding the square a move lands on, when the opponent attacks it there:
// [{ from, to }] lines.
function guardLines(fen, from, to) {
  const pos = board88(fen);
  const s = idx88(from);
  const t = idx88(to);
  const p = pos.b[s];
  if (!p || sideOf(p) !== pos.side) return [];
  const pawn = TYPE[p] === 'p';
  const u = makeMove(pos, { from: s, to: t, ep: pawn && (s & 7) !== (t & 7) && !pos.b[t], promo: pawn && (t >> 4) % 7 === 0 ? 'q' : undefined });
  const lines = isAttacked(pos.b, t, pos.side) ? attackersOn(pos.b, t, u.side).map((d) => ({ from: sq88(d), to })) : [];
  unmakeMove(pos, u);
  return lines;
}

// The search's board for `fen`, with material counted White minus Black.
function board88(fen) {
  const [placement, side, , ep] = fen.split(' ');
  const pos = { b: new Array(128).fill(null), side, ep: ep && ep !== '-' ? idx88(ep) : -1, king: {}, mat: 0 };
  placement.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        f += +ch;
        continue;
      }
      const s = (7 - i) * 16 + f++;
      pos.b[s] = ch;
      if (TYPE[ch] === 'k') pos.king[sideOf(ch)] = s;
      pos.mat += (ch < 'a' ? 1 : -1) * VALUE[TYPE[ch]];
    }
  });
  return pos;
}

// Is square s attacked by `by`'s pieces?
function isAttacked(b, s, by) {
  const w = by === 'w';
  const pawn = w ? 'P' : 'p';
  const back = w ? -16 : 16;   // pawns take forwards, so look one rank behind
  if (!((s + back - 1) & 0x88) && b[s + back - 1] === pawn) return true;
  if (!((s + back + 1) & 0x88) && b[s + back + 1] === pawn) return true;
  const knight = w ? 'N' : 'n';
  for (const d of STEPS.n) if (!((s + d) & 0x88) && b[s + d] === knight) return true;
  const king = w ? 'K' : 'k';
  for (const d of STEPS.k) if (!((s + d) & 0x88) && b[s + d] === king) return true;
  const queen = w ? 'Q' : 'q';
  for (const d of RAYS.q) {
    const line = slides('r', d) ? (w ? 'R' : 'r') : (w ? 'B' : 'b');
    for (let t = s + d; !(t & 0x88); t += d) {
      const p = b[t];
      if (!p) continue;
      if (p === queen || p === line) return true;
      break;
    }
  }
  return false;
}

function firstOnLine(b, s, d) {
  for (let t = s + d; !(t & 0x88); t += d) if (b[t]) return t;
  return -1;
}

// Squares of `by`'s pieces that attack square s.
function attackersOn(b, s, by) {
  const out = [];
  const w = by === 'w';
  const back = w ? -16 : 16;
  for (const t of [s + back - 1, s + back + 1]) if (!(t & 0x88) && b[t] === (w ? 'P' : 'p')) out.push(t);
  for (const type of ['n', 'k']) {
    for (const d of STEPS[type]) if (!((s + d) & 0x88) && b[s + d] === (w ? type.toUpperCase() : type)) out.push(s + d);
  }
  for (const d of RAYS.q) {
    const t = firstOnLine(b, s, d);
    if (t >= 0 && sideOf(b[t]) === by && slides(TYPE[b[t]], d)) out.push(t);
  }
  return out;
}

// Pseudo-legal moves for the side to move, captures first (the most valuable victim,
// then the cheapest attacker); with `loud`, only captures and promotions. No castling:
// the search below the first move does without it.
function genMoves(pos, loud) {
  const { b } = pos;
  const w = pos.side === 'w';
  const out = [];
  const push = (from, to, promo, ep) => {
    const victim = ep ? 1 : b[to] ? VALUE[TYPE[b[to]]] : 0;
    out.push({ from, to, promo, ep, victim, order: victim ? victim * 16 - VALUE[TYPE[b[from]]] : promo ? 8 : -1 });
  };
  for (let s = 0; s < 120; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = b[s];
    if (!p || (p < 'a') !== w) continue;
    const type = TYPE[p];
    if (type === 'p') {
      const d = w ? 16 : -16;
      const last = w ? 7 : 0;
      const one = s + d;
      if (!(one & 0x88) && !b[one]) {
        if (one >> 4 === last) push(s, one, 'q');
        else if (!loud) {
          push(s, one);
          if (s >> 4 === (w ? 1 : 6) && !b[one + d]) push(s, one + d);
        }
      }
      for (const to of [one - 1, one + 1]) {
        if (to & 0x88) continue;
        if (b[to] && (b[to] < 'a') !== w) push(s, to, to >> 4 === last ? 'q' : undefined);
        else if (to === pos.ep) push(s, to, undefined, true);
      }
    } else if (STEPS[type]) {
      for (const d of STEPS[type]) {
        const to = s + d;
        if (to & 0x88) continue;
        const q = b[to];
        if (q ? (q < 'a') !== w : !loud) push(s, to);
      }
    } else {
      for (const d of RAYS[type]) {
        for (let to = s + d; !(to & 0x88); to += d) {
          const q = b[to];
          if (!q) {
            if (!loud) push(s, to);
            continue;
          }
          if ((q < 'a') !== w) push(s, to);
          break;
        }
      }
    }
  }
  return out.sort((x, y) => y.order - x.order);
}

function makeMove(pos, m) {
  const { b } = pos;
  const piece = b[m.from];
  const w = piece < 'a';
  const capSq = m.ep ? m.to + (w ? -16 : 16) : m.to;
  const u = { m, piece, captured: b[capSq], capSq, ep: pos.ep, mat: pos.mat, side: pos.side, rook: null };
  if (u.captured) pos.mat += (w ? 1 : -1) * VALUE[TYPE[u.captured]];
  if (m.promo) pos.mat += (w ? 1 : -1) * (VALUE[m.promo] - 1);
  b[capSq] = null;
  b[m.from] = null;
  b[m.to] = m.promo ? (w ? m.promo.toUpperCase() : m.promo) : piece;
  if (TYPE[piece] === 'k') {
    pos.king[u.side] = m.to;
    if (Math.abs(m.to - m.from) === 2) {   // castling, which only the first move can be
      u.rook = m.to > m.from ? [m.from + 3, m.from + 1] : [m.from - 4, m.from - 1];
      b[u.rook[1]] = b[u.rook[0]];
      b[u.rook[0]] = null;
    }
  }
  pos.ep = TYPE[piece] === 'p' && Math.abs(m.to - m.from) === 32 ? (m.from + m.to) / 2 : -1;
  pos.side = w ? 'b' : 'w';
  return u;
}

function unmakeMove(pos, u) {
  const { b } = pos;
  const { m } = u;
  if (u.rook) {
    b[u.rook[0]] = b[u.rook[1]];
    b[u.rook[1]] = null;
  }
  b[m.to] = null;
  b[u.capSq] = u.captured;
  b[m.from] = u.piece;
  if (TYPE[u.piece] === 'k') pos.king[u.side] = m.from;
  pos.ep = u.ep;
  pos.mat = u.mat;
  pos.side = u.side;
}

const leavesKingSafe = (pos, u) => !isAttacked(pos.b, pos.king[u.side], pos.side);
const givesCheck = (pos, u) => isAttacked(pos.b, pos.king[pos.side], u.side);

// Material for the side to move if it stops here. If the opponent's last move left two
// of its pieces en prise at once (a fork of its own), only one can be saved: the smaller
// loss counts.
function standPat(pos) {
  const { b } = pos;
  const them = otherSide(pos.side);
  let first = 0;
  let second = 0;
  for (let s = 0; s < 120; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = b[s];
    if (!p || sideOf(p) !== pos.side || TYPE[p] === 'k' || !isAttacked(b, s, them)) continue;
    const g = exchangeOn(b, s, them);
    if (g > first) {
      second = first;
      first = g;
    } else if (g > second) {
      second = g;
    }
  }
  return own(pos) - second;
}

// What `by` nets by starting captures on square s, both sides recapturing with their
// cheapest piece while it pays (x-rays count, pins don't).
function exchangeOn(b, s, by) {
  const gain = [VALUE[TYPE[b[s]]]];
  const lifted = [];
  let side = by;
  let from = cheapestAttacker(b, s, side);
  if (from < 0 || (TYPE[b[from]] === 'k' && cheapestAttacker(b, s, otherSide(side)) >= 0)) return 0;
  for (;;) {
    const piece = b[from];
    lifted.push([from, piece]);
    b[from] = null;
    side = otherSide(side);
    const next = cheapestAttacker(b, s, side);
    if (next < 0 || (TYPE[b[next]] === 'k' && cheapestAttacker(b, s, otherSide(side)) >= 0)) break;
    gain.push(VALUE[TYPE[piece]] - gain[gain.length - 1]);
    from = next;
  }
  for (const [sq, p] of lifted) b[sq] = p;
  for (let d = gain.length - 1; d > 0; d--) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

function cheapestAttacker(b, s, by) {
  const w = by === 'w';
  const pawn = w ? 'P' : 'p';
  const back = w ? -16 : 16;
  if (!((s + back - 1) & 0x88) && b[s + back - 1] === pawn) return s + back - 1;
  if (!((s + back + 1) & 0x88) && b[s + back + 1] === pawn) return s + back + 1;
  const knight = w ? 'N' : 'n';
  for (const d of STEPS.n) if (!((s + d) & 0x88) && b[s + d] === knight) return s + d;
  let best = -1;
  for (const d of RAYS.q) {
    const t = firstOnLine(b, s, d);
    if (t < 0 || sideOf(b[t]) !== by) continue;
    const type = TYPE[b[t]];
    if (slides(type, d) && (best < 0 || VALUE[type] < VALUE[TYPE[b[best]]])) best = t;
  }
  if (best >= 0) return best;
  const king = w ? 'K' : 'k';
  for (const d of STEPS.k) if (!((s + d) & 0x88) && b[s + d] === king) return s + d;
  return -1;
}

// The opponent's turn after a candidate move: every legal reply, then checks and captures.
// Scores are material for the side to move.
function bestReply(pos, alpha, beta) {
  if (++searchNodes > NODE_BUDGET) throw OUT_OF_NODES;
  let best = -MATE;
  let moved = false;
  for (const m of genMoves(pos, false)) {
    const u = makeMove(pos, m);
    if (leavesKingSafe(pos, u)) {
      moved = true;
      const score = -quiesce(pos, -beta, -alpha, Q_DEPTH, true);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
    }
    unmakeMove(pos, u);
    if (alpha >= beta) break;
  }
  if (moved) return best;
  // Mated, or stalemated, which wins nothing beyond the material on the board.
  return isAttacked(pos.b, pos.king[pos.side], otherSide(pos.side)) ? -MATE : own(pos);
}

// Captures until the side to move would rather stop (every move while in check).
// `wary` is for the move right after the opponent's reply: checks count there too (a
// fork with check, a mate in two), and stopping has to reckon with whatever that reply
// set up to take next (a fork of its own, say).
function quiesce(pos, alpha, beta, depth, wary) {
  if (++searchNodes > NODE_BUDGET) throw OUT_OF_NODES;
  const check = isAttacked(pos.b, pos.king[pos.side], otherSide(pos.side));
  let best = -MATE;
  if (!check) {
    best = wary ? standPat(pos) : own(pos);
    if (best >= beta || !depth) return best;
    if (best > alpha) alpha = best;
  } else if (!depth) {
    return own(pos);
  }
  let moved = false;
  for (const m of genMoves(pos, !check && !wary)) {
    const quiet = !m.victim && !m.promo;
    // A capture that can't lift the score past alpha even if it went unanswered isn't worth a look.
    if (!check && !quiet && best + m.victim + (m.promo ? 8 : 0) < alpha) continue;
    const u = makeMove(pos, m);
    if (leavesKingSafe(pos, u) && (check || !quiet || givesCheck(pos, u))) {
      moved = true;
      const score = -quiesce(pos, -beta, -alpha, depth - 1, false);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
    }
    unmakeMove(pos, u);
    if (alpha >= beta) break;
  }
  return check && !moved ? -MATE : best;
}

function fmtEval(line) {
  if (!line) return '';
  if (line.mate != null) return `${line.mate > 0 ? '' : '-'}M${Math.abs(line.mate)}`;
  const v = line.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 0 : 1);
}

function describeAdvantage(chances) {
  const a = Math.abs(chances);
  if (a < 0.1) return 'Equal position';
  const side = chances > 0 ? 'White' : 'Black';
  if (a < 0.3) return `${side} is slightly better`;
  if (a < 0.6) return `${side} is better`;
  return `${side} is winning`;
}

function pvToSan(fen, pv, max = 10) {
  if (!chess.load(fen)) return pv.slice(0, max).join(' ');
  const out = [];
  const parts = fen.split(' ');
  let moveNo = +parts[5] || 1;
  let white = parts[1] === 'w';
  for (const uci of pv.slice(0, max)) {
    const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!m) break;
    if (white) out.push(`${moveNo}.${m.san}`);
    else out.push(out.length ? m.san : `${moveNo}…${m.san}`);
    if (!white) moveNo++;
    white = !white;
  }
  return out.join(' ');
}

// ---------- rendering ----------

const squares = [];
function buildBoard() {
  for (const color of ['white', 'black']) {
    for (const kind of Object.values(PIECE_NAMES)) new Image().src = `pieces/${color}-${kind}.png`;
  }
  for (let i = 0; i < 64; i++) {
    const sq = document.createElement('div');
    sq.className = 'sq';
    el.board.appendChild(sq);
    squares.push(sq);
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

let movesRenderQueued = false;
function scheduleMovesRender() {
  if (movesRenderQueued) return;
  movesRenderQueued = true;
  setTimeout(() => {
    movesRenderQueued = false;
    renderMarks();
    pumpEngine();
  }, 250);
}

function currentIndex() {
  const n = state.game?.plies.length || 0;
  if (!n) return -1;
  return state.view == null ? n - 1 : Math.min(state.view, n - 1);
}

function render() {
  const game = state.game;
  const idx = currentIndex();
  const ply = idx >= 0 ? game.plies[idx] : null;
  renderBoard(ply, idx);
  renderBars(ply, idx);
  renderMoves(idx);
  renderMeta();
  drawArrows(ply, renderAnalysis(ply, idx));
  renderWorst(idx);
  renderTally();
  syncSections();
  renderControls();
  if (game && ply) {
    if (game.source && !game.over) setStatus(state.view != null ? 'Reviewing. Press Live to catch up.' : `Live · following ${game.source}`);
    else if (game.over) setStatus([game.result || resultText(game), game.waiting].filter(Boolean).join(' '));
    else if (state.view != null) setStatus('Reviewing. Press Live to catch up.');
    else if (game.realtime) setStatus('Live · real time (featured on Lichess TV)');
    else setStatus('Live · Lichess shows spectators each move 3 plies late');
  }
}

function renderControls() {
  el.live.classList.toggle('on', state.view == null);
  el.engineToggle.classList.toggle('on', state.analysis);
  el.engineToggle.textContent = state.analysis ? 'Engine on' : 'Engine off';
  el.bestToggle.classList.toggle('on', state.opts.arrow);
  el.bestToggle.disabled = !state.analysis;
  el.altToggle.classList.toggle('on', state.opts.alts);
  el.altToggle.disabled = !state.analysis;
  el.tacticsToggle.classList.toggle('on', state.opts.tactics);
  el.legend.hidden = !state.opts.tactics;
  el.legend.classList.toggle('threats', state.opts.threats);
  for (const item of el.legend.querySelectorAll('[data-kind]')) {
    item.hidden = !state.opts[BADGE_OPT[item.dataset.kind] || TACTIC_OPT[item.dataset.kind]];
  }
  el.subopts.classList.toggle('off', !state.opts.tactics);
  for (const input of el.settings.querySelectorAll('[data-opt]')) {
    const v = state.opts[input.dataset.opt];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = String(v);
    input.disabled = !state.analysis && !('noengine' in input.dataset);
  }
}

function renderAnalysis(ply, idx) {
  const on = canAnalyse(state.game);
  const opts = state.opts;
  el.boardwrap.classList.toggle('off', !on || !ply || !opts.bar);
  pumpEngine();
  if (!state.analysis || !ply) {
    el.engine.innerHTML = '';
    return [];
  }
  if (engine.failed) {
    el.engine.innerHTML = '<div class="head">Stockfish couldn’t start in this browser.</div>';
    return [];
  }
  if (!on) {
    el.engine.innerHTML = `<div class="head">No engine analysis for ${esc(state.game.info.variant.name)}.</div>`;
    return [];
  }

  // Advantage bar
  const t = terminal(ply.fen);
  const e = evals.get(ply.fen);
  const best = e?.lines[0];
  const chances = positionChances(ply.fen);
  const whiteShare = chances == null ? 50 : (chances + 1) * 50;
  const blackBottom = (state.orientation === 'black') !== state.flipped;
  el.evalbar.classList.toggle('flipped', blackBottom);
  el.evalbar.classList.toggle('black-ahead', whiteShare < 50);
  el.evalfill.style.height = `${whiteShare}%`;
  el.evaltext.textContent = t === 'draw' ? '½' : t ? (t === 'w' ? '0-1' : '1-0') : best ? fmtEval(best).replace(/^[+-]/, '') : '';

  // Best move, plus the runners-up labelled with how much they give away.
  const s = ply.fen.split(' ')[1] === 'w' ? 1 : -1;
  const arrows = [];
  if (!t && best) {
    if (opts.alts) {
      for (const line of e.lines.slice(1, 3)) {
        if (line) arrows.push({ uci: line.pv[0], color: BEST_COLOR, width: 0.11, opacity: 0.5, label: dropLabel(best, line, s) });
      }
    }
    if (opts.arrow) arrows.push({ uci: best.pv[0], color: BEST_COLOR, width: 0.17, opacity: 0.8 });
  }

  // Who is winning, then the engine's lines
  const depth = e ? Math.max(0, ...e.lines.filter(Boolean).map((l) => l.depth)) : 0;
  const summary = t === 'draw' ? 'Stalemate' : t ? `Checkmate · ${t === 'w' ? 'Black' : 'White'} wins`
    : chances == null ? 'Thinking…' : `${describeAdvantage(chances)} (${fmtEval(best)})`;
  let html = `<div class="head"><span class="adv">${summary}</span><span>${t || !depth ? '' : `Stockfish 16 · depth ${depth}`}</span></div>`;
  if (opts.lines && !t) {
    (e?.lines || []).slice(0, opts.multipv).forEach((line, j) => {
      if (!line) return;
      const drop = j && best ? `<span class="drop" title="Compared with the best move">${dropLabel(best, line, s)}</span>` : '';
      html += `<div class="line"><span class="ev${winChances(line) < 0 ? ' neg' : ''}">${fmtEval(line)}</span>${drop}` +
        `<span class="pv">${esc(pvToSan(ply.fen, line.pv))}</span></div>`;
    });
  }

  // What the engine thinks of the move that led here
  if (opts.symbols) {
    const kind = idx >= 1 ? classify(idx) : null;
    if (kind) {
      const prevFen = state.game.plies[idx - 1].fen;
      const better = evals.get(prevFen)?.lines[0];
      const betterSan = better ? toSan(prevFen, better.pv[0]) : null;
      const bad = ['inaccuracy', 'mistake', 'blunder'].includes(kind);
      html += `<div class="note"><span class="sym k-${kind}">${KINDS[kind].sym}</span> ` +
        `<b>${esc(ply.san || ply.lm)}</b> is ${kind === 'best' ? 'the best move' : `${/^[aeiou]/i.test(KINDS[kind].word) ? 'an' : 'a'} ${KINDS[kind].word.toLowerCase()}`}` +
        (bad && betterSan ? `. Best was <b>${esc(betterSan)}</b> (${fmtEval(better)}).` : '.') + '</div>';
    }
  }
  el.engine.innerHTML = html;
  return arrows;
}

// How much worse an engine line is than the best one for the side to move
// (s = 1 for White, -1 for Black), in pawns. With a mate involved, the line's own score.
function dropLabel(best, alt, s) {
  if (best.mate != null || alt.mate != null) return fmtEval(alt);
  const d = Math.max(0, (best.cp - alt.cp) * s) / 100;
  return d < 0.05 ? '0.0' : `-${d.toFixed(d >= 10 ? 0 : 1)}`;
}

// Every blunder of the game so far, in move order, each as a little board that jumps there when clicked.
function blunderMoves() {
  const plies = state.game?.plies || [];
  const out = [];
  for (let i = 1; i < plies.length; i++) if (plies[i] && plies[i - 1] && classify(i) === 'blunder') out.push(i);
  return out;
}

function blunderCard(i, idx) {
  const game = state.game;
  const prev = game.plies[i - 1];
  const cur = game.plies[i];
  const better = evals.get(prev.fen)?.lines[0];
  const color = prev.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const name = game.info?.players?.[color]?.user?.name || cap(color);
  return `<button class="worst-card${idx === i ? ' cur' : ''}" data-ply="${i}" title="Show this move on the board">` +
    miniBoardHtml(cur.fen, cur.lm, castleFix(prev.fen, cur.lm).slice(2, 4), 'blunder') +
    '<span class="worst-info">' +
    `<span><span class="sym k-blunder">${KINDS.blunder.sym}</span> <b>${esc(moveLabel(i))}</b></span>` +
    `<span class="muted">${esc(name)}</span>` +
    `<span>${evalText(prev.fen)} → ${evalText(cur.fen)}</span>` +
    (better ? `<span class="muted">Best was <b>${esc(toSan(prev.fen, better.pv[0]))}</b></span>` : '') +
    '</span></button>';
}

let worstHtml = '';
function renderWorst(idx) {
  const game = state.game;
  let html = '';
  let count = 0;
  if (game && state.opts.worst && canAnalyse(game) && game.plies.length > 1) {
    const list = blunderMoves();
    count = list.length;
    html = count
      ? `<div class="worst-list">${list.map((i) => blunderCard(i, idx)).join('')}</div>`
      : '<p class="worst-none">No blunders yet.</p>';
  }
  if (html !== worstHtml) {
    el.worst.innerHTML = html;
    worstHtml = html;
  }
  el.worstTitle.textContent = count ? `Blunder previews (${count})` : 'Blunder previews';
}

function miniBoardHtml(fen, lm, hit, kind) {
  const black = (state.orientation === 'black') !== state.flipped;
  const grid = fenGrid(fen);
  const last = lm ? [lm.slice(0, 2), lm.slice(2, 4)] : [];
  let html = '';
  for (let i = 0; i < 64; i++) {
    const r = black ? 7 - Math.floor(i / 8) : Math.floor(i / 8);
    const f = black ? 7 - (i % 8) : i % 8;
    const name = FILES[f] + (8 - r);
    const piece = grid[r]?.[f];
    html += `<span class="sq${(r + f) % 2 ? ' d' : ''}${last.includes(name) ? ' last' : ''}${name === hit ? ` hit k-${kind}` : ''}">`;
    if (piece) html += `<img src="pieces/${piece === piece.toUpperCase() ? 'white' : 'black'}-${PIECE_NAMES[piece.toLowerCase()]}.png" alt="">`;
    html += '</span>';
  }
  return `<span class="thumb">${html}</span>`;
}

// "14…Qxb2" for the move that produced ply i.
function moveLabel(i) {
  const [, turn, , , , moveNo] = state.game.plies[i - 1].fen.split(' ');
  const san = state.game.plies[i].san || state.game.plies[i].lm;
  return `${moveNo}${turn === 'w' ? '.' : '…'}${san}`;
}

function evalText(fen) {
  const t = terminal(fen);
  if (t) return t === 'draw' ? '½-½' : t === 'w' ? '0-1' : '1-0';
  return fmtEval(evals.get(fen)?.lines[0]) || '…';
}

let tallyCache = '';
function renderTally() {
  const game = state.game;
  const html = game && state.analysis && state.opts.symbols && canAnalyse(game) ? tallyHtml() : '';
  if (html !== tallyCache) {
    el.tally.innerHTML = html;
    tallyCache = html;
  }
}

// Sections with nothing to show (feature off, no game yet) disappear instead of leaving an empty title.
function syncSections() {
  for (const box of [el.worst, el.engine, el.tally]) box.closest('.sec').hidden = !box.innerHTML;
}

// Remember which sections are open.
const SECTIONS_KEY = 'livewatch.sections';
function initSections() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}'); } catch { /* optional */ }
  for (const d of document.querySelectorAll('details.sec')) {
    if (d.dataset.sec in saved) d.open = saved[d.dataset.sec];
    d.addEventListener('toggle', () => {
      saved[d.dataset.sec] = d.open;
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(saved)); } catch { /* optional */ }
    });
  }
}

function tallyHtml() {
  const plies = state.game.plies;
  if (plies.length < 2) return '';
  const count = { w: {}, b: {} };
  let checked = 0;
  let total = 0;
  for (let i = 1; i < plies.length; i++) {
    if (!plies[i] || !plies[i - 1]) continue;
    total++;
    if (positionChances(plies[i].fen) == null || positionChances(plies[i - 1].fen) == null) continue;
    checked++;
    const kind = classify(i);
    const side = plies[i - 1].fen.split(' ')[1];
    if (kind) count[side][kind] = (count[side][kind] || 0) + 1;
  }
  const names = state.game.info?.players || {};
  const who = (c) => esc(names[c]?.user?.name || (c === 'white' ? 'White' : 'Black'));
  let rows = '';
  for (const [kind, k] of Object.entries(KINDS)) {
    rows += `<tr><td>${count.w[kind] || 0}</td><td><span class="sym k-${kind}">${k.sym}</span> ${k.word}</td><td>${count.b[kind] || 0}</td></tr>`;
  }
  const progress = checked < total ? `<div class="progress">Checked ${checked} of ${total} moves…</div>` : '';
  return `<table class="tally"><thead><tr><th>${who('white')}</th><th></th><th>${who('black')}</th></tr></thead><tbody>${rows}</tbody></table>${progress}`;
}

const BEST_COLOR = '#2f7fd8';
const TACTIC_COLOR = {
  mate: '#8e1b1b', fork: '#e91e63', skewer: '#3949ab', hanging: '#e58f2a', removal: '#6d4c41',
  discovered: '#ef6c00', trade: '#2e9d57', pin: '#00a3a3', pressure: '#546e7a',
  check: '#d6352b', queen: '#a24bd1', capture: '#6f6f78', zwischen: '#b8860b',
};
const BADGE_COLOR = { undefended: '#f15b6b', pinned: '#444844', checkable: '#287dce', mate: '#e83d4b' };
const BADGE_ICON = {
  undefended: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6Z" fill="currentColor"/><path d="m9 9 6 6m0-6-6 6" fill="none" stroke="var(--tactic-badge-color)" stroke-width="2" stroke-linecap="round"/></svg>',
  pinned: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v3h-2v5l3 3v2h-5v5h-2v-5H6v-2l3-3V6H7Z" fill="currentColor"/></svg>',
  checkable: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/></svg>',
  mate: '#',
};
const badgeInteraction = { fen: null, pinned: null, hovered: null, focused: null };
let renderedEngineArrows = [];

function positionBadges(ply) {
  const variant = state.game?.info?.variant?.key || 'standard';
  return state.opts.tactics && ply && ANALYSABLE.includes(variant) ? TacticBadges.analyze(ply.fen, variant) : null;
}

function activePositionBadge(ply) {
  if (badgeInteraction.fen !== ply?.fen) return null;
  const selected = badgeInteraction.hovered || badgeInteraction.focused || badgeInteraction.pinned;
  if (!selected) return null;
  const [square, kind] = selected.split(':');
  if (!state.opts[BADGE_OPT[kind]]) return null;
  return positionBadges(ply)?.badges[square]?.find((b) => b.kind === kind) || null;
}

function refreshBadgeExplanation() {
  const ply = state.game?.plies[currentIndex()];
  for (const button of el.board.querySelectorAll('[data-badge-kind]')) {
    button.setAttribute('aria-pressed', String(badgeInteraction.pinned === `${button.dataset.badgeSquare}:${button.dataset.badgeKind}`));
  }
  drawArrows(ply, renderedEngineArrows);
}

function squareBadges(name, quality, position) {
  const order = { mate: 0, pinned: 1, undefended: 2, checkable: 3 };
  const badges = (position?.badges[name] || []).filter((b) => state.opts[BADGE_OPT[b.kind]])
    .slice().sort((a, b) => order[a.kind] - order[b.kind]);
  const parts = [];
  const tactic = (b) => {
    const pressed = badgeInteraction.pinned === `${name}:${b.kind}`;
    return `<button type="button" class="badge tactic-badge t-${b.kind}" data-badge-square="${name}" data-badge-kind="${b.kind}" title="${esc(b.title)}" aria-label="${esc(b.title)}" aria-pressed="${pressed}">${BADGE_ICON[b.kind]}</button>`;
  };
  for (const b of badges.filter((b) => b.kind === 'mate')) parts.push(tactic(b));
  if (quality?.square === name) {
    parts.push(`<span class="badge k-${quality.kind}" title="${KINDS[quality.kind].word}">${KINDS[quality.kind].sym}</span>`);
  }
  for (const b of badges.filter((b) => b.kind !== 'mate')) parts.push(tactic(b));
  return parts.length ? `<span class="badge-cluster">${parts.join('')}</span>` : '';
}

// Tactics underneath (the opponent's threats lowest), engine arrows on top, labels over everything.
function drawArrows(ply, engineArrows) {
  renderedEngineArrows = engineArrows;
  let svg = el.board.querySelector('svg.arrows');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('viewBox', '0 0 8 8');
    el.board.appendChild(svg);
  }
  const list = [];
  const variant = state.game?.info?.variant?.key || 'standard';
  if (state.opts.tactics && ply && ANALYSABLE.includes(variant) && !terminal(ply.fen)) {
    const seen = new Set();  // one arrow per pair of squares, whoever draws it first
    const push = (a) => {
      if (a.from === a.to || seen.has(a.from + a.to)) return;
      seen.add(a.from + a.to);
      list.push(a);
    };
    const add = (picked, dash) => {
      for (const t of picked) {
        const color = TACTIC_COLOR[t.kind];
        const opacity = dash ? 0.6 : 0.9;
        push({ from: t.from, to: t.to, color, width: t.kind === 'mate' ? 0.14 : 0.11, opacity, dash });
        // The idea behind the move: fork targets, the pinned line, the unmasked attacker, the defenders...
        for (const x of t.lines) push({ from: x.from, to: x.to, color, width: 0.06, opacity: opacity * 0.85, dash: dash || x.dash });
      }
    };
    const idx = currentIndex();
    const mine = tactics(ply.fen);
    const mating = mine.some((t) => t.kind === 'mate');
    if (!mating) {
      // What the opponent's last move set up (a fork now on the board...), then what they threaten next.
      const last = lastMoveTactic(idx);
      if (last) {
        const color = TACTIC_COLOR[last.kind];
        for (const x of last.lines) push({ from: x.from, to: x.to, color, width: 0.07, opacity: 0.6, dash: true });
      }
      // Passing the turn is meaningless while the side to move is in check.
      if (state.opts.threats && !findCheckedKing(ply.fen)) add(tactics(passTurn(ply.fen), { max: 2, forcing: false }), true);
    }
    add(mine, false);
    if (!mating && state.opts.tZwischen && state.analysis) {
      const z = zwischenzug(idx);
      if (z) {
        const color = TACTIC_COLOR.zwischen;
        push({ from: z.from, to: z.to, color, width: 0.11, opacity: 0.9 });
        push({ from: z.later.slice(0, 2), to: z.later.slice(2, 4), color, width: 0.06, opacity: 0.75, dash: true });
      }
    }
  }
  // A badge explains one position feature on demand; suggestions remain a separate layer.
  const explanation = activePositionBadge(ply);
  if (explanation) {
    for (const line of explanation.lines) {
      if (line.from !== line.to) list.push({ ...line, color: BADGE_COLOR[explanation.kind], width: 0.075, opacity: 0.95 });
    }
  }
  for (const a of engineArrows) list.push({ ...a, from: a.uci.slice(0, 2), to: a.uci.slice(2, 4) });
  const labels = [];
  svg.innerHTML = list.map((a) => arrowSvg(a, labels)).join('') + labels.map((l) => l.svg).join('');
}

function arrowSvg(a, labels) {
  const [x1, y1] = squareCenter(a.from);
  const [x2, y2] = squareCenter(a.to);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const head = a.width * 2.5;
  const half = a.width * 1.55;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  const dash = a.dash ? ` stroke-dasharray="${a.width * 2} ${a.width * 1.5}"` : '';
  if (a.label) {
    // A pill just below the target square's centre, moved above it if that spot is taken.
    let ly = y2 + 0.3;
    if (labels.some((l) => l.x === x2 && l.y === ly)) ly = y2 - 0.3;
    ly = Math.min(7.82, Math.max(0.18, ly));
    const w = 0.16 + a.label.length * 0.13;
    labels.push({
      x: x2, y: ly,
      svg: `<rect x="${x2 - w / 2}" y="${ly - 0.16}" width="${w}" height="0.32" rx="0.16" fill="${a.color}" stroke="#fff" stroke-width="0.03"/>` +
        `<text x="${x2}" y="${ly}" font-size="0.22" font-weight="700" font-family="system-ui, sans-serif" fill="#fff" text-anchor="middle" dominant-baseline="central">${esc(a.label)}</text>`,
    });
  }
  return `<g opacity="${a.opacity}">` +
    `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="${a.dash ? 'butt' : 'round'}"${dash}/>` +
    `<polygon points="${x2},${y2} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}" fill="${a.color}"/></g>`;
}

function squareCenter(sq) {
  const black = (state.orientation === 'black') !== state.flipped;
  const f = sq.charCodeAt(0) - 97;
  const r = +sq[1] - 1;
  return black ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
}

function setWaiting(text) {
  if (state.game) {
    state.game.waiting = text;
    scheduleRender();
  } else {
    setStatus(text);
  }
}

function renderBoard(ply, idx) {
  const black = (state.orientation === 'black') !== state.flipped;
  const grid = ply ? fenGrid(ply.fen) : [];
  const lastSquares = ply?.lm ? [ply.lm.slice(0, 2), ply.lm.slice(2, 4)] : [];
  if (badgeInteraction.fen !== (ply?.fen || null)) {
    Object.assign(badgeInteraction, { fen: ply?.fen || null, pinned: null, hovered: null, focused: null });
  }
  const position = positionBadges(ply);
  for (const interaction of ['pinned', 'hovered', 'focused']) {
    const key = badgeInteraction[interaction];
    if (!key) continue;
    const [square, kind] = key.split(':');
    if (!state.opts[BADGE_OPT[kind]] || !position?.badges[square]?.some((b) => b.kind === kind)) {
      badgeInteraction[interaction] = null;
    }
  }
  const checkSquare = position ? position.checkedKing : ply ? findCheckedKing(ply.fen) : null;

  // The move's symbol sits on the square the piece landed on.
  let badge = null;
  if (state.opts.symbols && ply?.lm && idx >= 1 && state.game.plies[idx - 1]) {
    const kind = classify(idx);
    if (kind) badge = { kind, square: castleFix(state.game.plies[idx - 1].fen, ply.lm).slice(2, 4) };
  }

  for (let i = 0; i < 64; i++) {
    const r = black ? 7 - Math.floor(i / 8) : Math.floor(i / 8); // 0 = rank 8
    const f = black ? 7 - (i % 8) : i % 8;
    const name = FILES[f] + (8 - r);
    const sq = squares[i];
    sq.dataset.square = name;
    sq.className = 'sq' + ((r + f) % 2 ? ' d' : '') +
      (lastSquares.includes(name) ? ' last' : '') + (checkSquare === name ? ' check' : '');
    const piece = grid[r]?.[f];
    let html = '';
    if (piece) {
      const color = piece === piece.toUpperCase() ? 'white' : 'black';
      const kind = PIECE_NAMES[piece.toLowerCase()];
      html += `<img src="pieces/${color}-${kind}.png" alt="${color} ${kind}" draggable="false">`;
    }
    if (i % 8 === 0) html += `<span class="coord rank">${8 - r}</span>`;
    if (i >= 56) html += `<span class="coord file">${FILES[f]}</span>`;
    html += squareBadges(name, badge, position);
    if (sq.innerHTML !== html) {
      // A flip or a new annotation can replace a button without emitting focusout.
      if (sq.contains(document.activeElement)) badgeInteraction.focused = null;
      if (badgeInteraction.hovered && [...sq.querySelectorAll('[data-badge-kind]')].some((b) => badgeKey(b) === badgeInteraction.hovered)) {
        badgeInteraction.hovered = null;
      }
      sq.innerHTML = html;
    }
  }
}

// Rows of the board from rank 8 down, each a list of piece letters or null.
function fenGrid(fen) {
  return fen.split(' ')[0].split('/').map((row) => {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < +ch; k++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
}

function findCheckedKing(fen) {
  if (!chess.load(fen) || !chess.in_check()) return null;
  return findPieces('k', chess.turn())[0] || null;
}

function renderBars(ply, idx) {
  const game = state.game;
  const black = (state.orientation === 'black') !== state.flipped;
  el.barTop.innerHTML = barHtml(game, black ? 'white' : 'black', ply, idx);
  el.barBottom.innerHTML = barHtml(game, black ? 'black' : 'white', ply, idx);
}

function barHtml(game, color, ply, idx) {
  if (!game?.info) return '';
  const p = game.info.players?.[color];
  const u = p?.user;
  const name = u ? u.name : p?.aiLevel ? `Stockfish level ${p.aiLevel}` : color === 'white' ? 'White' : 'Black';
  const title = u?.title ? `<span class="title">${esc(u.title)}</span>` : '';
  const rating = p?.rating ? `<span class="rating">${p.rating}</span>` : '';
  const { seconds, running } = clockFor(game, color, ply, idx);
  const clock = seconds == null ? '' :
    `<span class="clock${running ? ' running' : ''}${seconds < 20 ? ' low' : ''}">${fmtClock(seconds)}</span>`;
  return `<span class="who">${title}${esc(name)}${rating}</span>${clock}`;
}

function clockFor(game, color, ply, idx) {
  if (!ply) return { seconds: null, running: false };
  const raw = color === 'white' ? ply.wc : ply.bc;
  if (raw == null) return { seconds: null, running: false };
  const isLast = idx === game.plies.length - 1;
  const turn = ply.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const moves = game.base + game.plies.length - 1;
  const running = isLast && !game.over && turn === color && moves >= 2;
  const elapsed = running ? (performance.now() - game.receivedAt) / 1000 : 0;
  return { seconds: Math.max(0, raw - elapsed), running };
}

function fmtClock(s) {
  if (s < 10) return s.toFixed(1);
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

let renderedMoves = { id: null, version: -1, count: 0, cur: -1 };
function renderMoves(idx) {
  const game = state.game;
  const plies = game?.plies || [];
  if (renderedMoves.id !== game?.id || renderedMoves.version !== game?.version || renderedMoves.count > Math.max(plies.length, 1)) {
    el.moves.innerHTML = '';
    renderedMoves = { id: game?.id, version: game?.version, count: 0, cur: -1 };
  }
  // Ply 0 is the starting position; moves start at ply 1. Gaps (moves still
  // on their way through the delayed stream) show as "…".
  const startsWhite = plies[0] ? plies[0].fen.split(' ')[1] !== 'b' : (game?.base ?? 0) % 2 === 0;
  for (let i = Math.max(1, renderedMoves.count); i < plies.length; i++) {
    const moveNo = Math.floor((i - 1 + (startsWhite ? 0 : 1)) / 2) + 1 + Math.floor((game.base ?? 0) / 2);
    const whiteMove = startsWhite ? i % 2 === 1 : i % 2 === 0;
    if (whiteMove || i === 1) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="n">${moveNo}.</span>`;
      if (!whiteMove) li.innerHTML += '<span>…</span>';
      el.moves.appendChild(li);
    }
    const btn = document.createElement('button');
    if (plies[i]) {
      btn.innerHTML = `${esc(plies[i].san || plies[i].lm || '…')}<span class="mark"></span>`;
      btn.dataset.ply = i;
    } else {
      btn.textContent = '…';
      btn.disabled = true;
      btn.title = 'Still on its way from Lichess';
    }
    el.moves.lastElementChild.appendChild(btn);
  }
  renderedMoves.count = Math.max(plies.length, 1);
  renderMarks();
  if (renderedMoves.cur !== idx) {
    el.moves.querySelector('button.cur')?.classList.remove('cur');
    const btn = el.moves.querySelector(`button[data-ply="${idx}"]`);
    if (btn) {
      btn.classList.add('cur');
      // Scroll only the move list, never the page.
      const list = el.moves;
      const b = btn.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (b.top < l.top) list.scrollTop -= l.top - b.top;
      else if (b.bottom > l.bottom) list.scrollTop += b.bottom - l.bottom;
    }
    renderedMoves.cur = idx;
  }
}

function renderMarks() {
  if (!state.game) return;
  for (const btn of el.moves.querySelectorAll('button[data-ply]')) {
    const kind = state.opts.symbols ? classify(+btn.dataset.ply) : null;
    const cls = kind ? `k-${kind}` : '';
    if (btn.dataset.k === cls) continue;
    if (btn.dataset.k) btn.classList.remove(btn.dataset.k);
    btn.dataset.k = cls;
    if (cls) btn.classList.add(cls);
    btn.querySelector('.mark').textContent = kind ? KINDS[kind].sym : '';
  }
}

function renderMeta() {
  const info = state.game?.info;
  if (!info) {
    el.meta.textContent = '';
    return;
  }
  const parts = [];
  if (info.clock) parts.push(`${info.clock.initial / 60}+${info.clock.increment}`);
  if (info.speed) parts.push(cap(info.speed));
  if (info.variant && info.variant.key !== 'standard') parts.push(info.variant.name);
  if (info.fileName) parts.push(info.fileName);
  else parts.push(info.rated ? 'Rated' : 'Casual');
  el.meta.textContent = parts.join(' · ');
}

function setStatus(text) {
  el.status.textContent = text;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}

// ---------- sound ----------

let audio;
function playMoveSound(san) {
  if (!state.sound || state.view != null || document.hidden) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.value = san && san.includes('x') ? 520 : 380;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch { /* audio is optional */ }
}

// ---------- navigation ----------

// Jump to a ply; if it hasn't arrived yet, keep going in the direction of travel.
function go(idx, dir = -1) {
  const plies = state.game?.plies || [];
  const n = plies.length;
  if (!n) return;
  idx = Math.max(0, Math.min(n - 1, idx));
  while (!plies[idx] && idx > 0 && idx < n - 1) idx += dir;
  if (!plies[idx]) idx = n - 1;
  state.view = idx === n - 1 ? null : idx;
  scheduleRender();
}

// ---------- movable, resizable board ----------
// Drag either player bar to move the board, drag the corner handle to resize it. The whole unit
// (board, eval bar, clocks, arrows, badges) is moved and scaled by a CSS transform, so nothing
// around it reflows. Position and size are remembered.

// The board and the panels can overlap; whichever was touched last comes to the front.
let zTop = 30;
const bringToFront = (node) => { node.style.zIndex = String(++zTop); };

const BOARD_KEY = 'livewatch.board';
const BOARD_MIN_K = 0.4;
const BOARD_MAX_K = 2.5;
const boardBox = { x: 0, y: 0, k: 1 };
const boardUnit = $('boardunit');

function applyBoardBox() {
  boardUnit.style.setProperty('--bx', `${boardBox.x}px`);
  boardUnit.style.setProperty('--by', `${boardBox.y}px`);
  boardUnit.style.setProperty('--bk', String(boardBox.k));
  boardUnit.classList.toggle('moved', boardBox.x !== 0 || boardBox.y !== 0 || boardBox.k !== 1);
}

function saveBoardBox() {
  try { localStorage.setItem(BOARD_KEY, JSON.stringify(boardBox)); } catch { /* optional */ }
}

// Keep a good part of the board on screen so it can always be grabbed again.
function keepBoardReachable() {
  const r = boardUnit.getBoundingClientRect();
  const grab = Math.min(120, r.width / 2);
  if (r.right < grab) boardBox.x += grab - r.right;
  if (r.left > innerWidth - grab) boardBox.x -= r.left - (innerWidth - grab);
  if (r.top + scrollY < 0) boardBox.y -= r.top + scrollY;
}

function resetBoardBox() {
  Object.assign(boardBox, { x: 0, y: 0, k: 1 });
  applyBoardBox();
  saveBoardBox();
}

function initBoardUnit() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOARD_KEY) || 'null');
    if (saved && [saved.x, saved.y, saved.k].every(Number.isFinite)) {
      Object.assign(boardBox, { x: saved.x, y: saved.y, k: Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, saved.k)) });
    }
  } catch { /* optional */ }
  applyBoardBox();
  keepBoardReachable();
  applyBoardBox();

  let drag = null;
  let lastPress = { t: 0, x: 0, y: 0 };
  boardUnit.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (boardUnit.classList.contains('moved')) bringToFront(boardUnit);
    const resize = e.target.closest('.boardresize');
    if (!resize && !e.target.closest('.bar')) return;
    e.preventDefault();
    // Two quick presses in the same spot reset the board (pointer capture hides the browser's dblclick).
    if (e.timeStamp - lastPress.t < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 8) {
      lastPress.t = 0;
      resetBoardBox();
      return;
    }
    lastPress = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    boardUnit.setPointerCapture(e.pointerId);
    drag = {
      mode: resize ? 'resize' : 'move', id: e.pointerId, sx: e.clientX, sy: e.clientY,
      x: boardBox.x, y: boardBox.y, k: boardBox.k, w: boardUnit.offsetWidth,
    };
    boardUnit.classList.add(resize ? 'resizing' : 'dragging');
    document.body.classList.add('moving');
  });
  boardUnit.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (drag.mode === 'move') {
      boardBox.x = drag.x + dx;
      boardBox.y = drag.y + dy;
    } else {
      // The top-left corner stays put; the new width follows the pointer along the diagonal.
      const width = Math.max(1, drag.k * drag.w + (dx + dy) / 2);
      boardBox.k = Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, width / drag.w));
    }
    applyBoardBox();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    boardUnit.classList.remove('dragging', 'resizing');
    document.body.classList.remove('moving');
    keepBoardReachable();
    applyBoardBox();
    saveBoardBox();
  };
  boardUnit.addEventListener('pointerup', end);
  boardUnit.addEventListener('pointercancel', end);
  $('boardReset').onclick = () => { resetBoardBox(); resetPanels(); };
  addEventListener('resize', () => {
    keepBoardReachable();
    applyBoardBox();
  });
}

// ---------- movable, resizable panels ----------
// The analysis panel, the moves list and the control buttons each get a grip on their top edge
// (drag to move) and a corner handle (drag to resize). Moving uses the CSS `translate` property, so
// nothing reflows; resizing sets width and height. Everything is remembered.

const PANELS_KEY = 'livewatch.panels';
const PANEL_MIN = { w: 200, h: 140 };
const panelBoxes = {};   // id -> { x, y, w, h } (w and h are null until the panel is resized)
const panelEls = new Map();

function applyPanel(id) {
  const node = panelEls.get(id);
  const box = panelBoxes[id];
  node.style.setProperty('--px', `${box.x}px`);
  node.style.setProperty('--py', `${box.y}px`);
  node.style.width = box.w == null ? '' : `${box.w}px`;
  node.style.height = box.h == null ? '' : `${box.h}px`;
  node.classList.toggle('sized', box.w != null || box.h != null);
}

function savePanels() {
  try { localStorage.setItem(PANELS_KEY, JSON.stringify(panelBoxes)); } catch { /* optional */ }
}

// Keep a good part of a panel on screen so it can always be grabbed again.
function keepPanelReachable(id) {
  const r = panelEls.get(id).getBoundingClientRect();
  const box = panelBoxes[id];
  const grab = Math.min(100, r.width / 2);
  if (r.right < grab) box.x += grab - r.right;
  if (r.left > innerWidth - grab) box.x -= r.left - (innerWidth - grab);
  if (r.top + scrollY < 0) box.y -= r.top + scrollY;
}

function resetPanel(id) {
  Object.assign(panelBoxes[id], { x: 0, y: 0, w: null, h: null });
  applyPanel(id);
  savePanels();
}

function resetPanels() {
  for (const id of panelEls.keys()) resetPanel(id);
}

function initPanels() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') || {}; } catch { /* optional */ }
  const num = (v) => (Number.isFinite(v) ? v : null);

  for (const node of document.querySelectorAll('.panel[data-panel]')) {
    const id = node.dataset.panel;
    const widthOnly = node.dataset.size === 'width';
    panelEls.set(id, node);
    const sv = saved[id] || {};
    panelBoxes[id] = {
      x: num(sv.x) ?? 0, y: num(sv.y) ?? 0,
      w: num(sv.w) == null ? null : Math.max(PANEL_MIN.w, sv.w),
      h: widthOnly || num(sv.h) == null ? null : Math.max(PANEL_MIN.h, sv.h),
    };

    const grip = document.createElement('div');
    grip.className = 'panelgrip';
    grip.title = 'Drag to move this panel (double-click to reset)';
    const handle = document.createElement('div');
    handle.className = 'panelresize';
    handle.title = 'Drag to resize this panel (double-click to reset)';
    node.append(grip, handle);

    let drag = null;
    let lastPress = { t: 0, x: 0, y: 0 };
    const press = (mode) => (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(node);
      // Two quick presses in the same spot reset the panel (pointer capture hides the browser's dblclick).
      if (e.timeStamp - lastPress.t < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 8) {
        lastPress.t = 0;
        resetPanel(id);
        return;
      }
      lastPress = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      const box = panelBoxes[id];
      drag = {
        mode, pid: e.pointerId, sx: e.clientX, sy: e.clientY,
        x: box.x, y: box.y, w: box.w ?? node.offsetWidth, h: box.h ?? node.offsetHeight,
      };
      node.classList.add(mode === 'move' ? 'dragging' : 'resizing');
      document.body.classList.add('moving');
    };
    const move = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      const box = panelBoxes[id];
      if (drag.mode === 'move') {
        box.x = drag.x + dx;
        box.y = drag.y + dy;
      } else {
        box.w = Math.max(PANEL_MIN.w, drag.w + dx);
        if (!widthOnly) box.h = Math.max(PANEL_MIN.h, drag.h + dy);
      }
      applyPanel(id);
    };
    const end = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      drag = null;
      node.classList.remove('dragging', 'resizing');
      document.body.classList.remove('moving');
      keepPanelReachable(id);
      applyPanel(id);
      savePanels();
    };
    grip.addEventListener('pointerdown', press('move'));
    handle.addEventListener('pointerdown', press('resize'));
    for (const target of [grip, handle]) {
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    }
    // Touching anywhere on a moved or resized panel brings it in front of the others.
    node.addEventListener('pointerdown', () => {
      const box = panelBoxes[id];
      if (box.x || box.y || box.w != null || box.h != null) bringToFront(node);
    }, true);

    applyPanel(id);
    keepPanelReachable(id);
    applyPanel(id);
  }
  addEventListener('resize', () => {
    for (const id of panelEls.keys()) {
      keepPanelReachable(id);
      applyPanel(id);
    }
  });
}

// ---------- wiring ----------

function badgeKey(button) {
  return `${button.dataset.badgeSquare}:${button.dataset.badgeKind}`;
}

el.board.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const button = e.target.closest('[data-badge-kind]');
  if (!button || badgeInteraction.hovered === badgeKey(button)) return;
  badgeInteraction.hovered = badgeKey(button);
  refreshBadgeExplanation();
});
el.board.addEventListener('pointerout', (e) => {
  const button = e.target.closest('[data-badge-kind]');
  if (!button || button.contains(e.relatedTarget) || !badgeInteraction.hovered) return;
  badgeInteraction.hovered = null;
  refreshBadgeExplanation();
});
el.board.addEventListener('focusin', (e) => {
  const button = e.target.closest('[data-badge-kind]');
  if (!button || !button.matches(':focus-visible')) return;
  badgeInteraction.focused = badgeKey(button);
  refreshBadgeExplanation();
});
el.board.addEventListener('focusout', () => {
  if (!badgeInteraction.focused) return;
  badgeInteraction.focused = null;
  refreshBadgeExplanation();
});
el.board.addEventListener('click', (e) => {
  const button = e.target.closest('[data-badge-kind]');
  if (!button) return;
  const key = badgeKey(button);
  badgeInteraction.pinned = badgeInteraction.pinned === key ? null : key;
  refreshBadgeExplanation();
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-badge-kind]') || !badgeInteraction.pinned) return;
  Object.assign(badgeInteraction, { pinned: null, hovered: null, focused: null });
  refreshBadgeExplanation();
});

function updateThemeToggle() {
  const theme = document.documentElement.dataset.theme;
  const isDark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
  el.themeToggle.textContent = `Switch to ${isDark ? 'light' : 'dark'} mode`;
}
updateThemeToggle();
el.themeToggle.onclick = () => {
  const theme = document.documentElement.dataset.theme;
  const isDark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch { /* optional */ }
  updateThemeToggle();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) updateThemeToggle();
});

el.userForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.userInput.value.trim().replace(/^.*lichess\.org\/@\//, '').replace(/\/.*$/, '');
  if (/^[A-Za-z0-9_-]{2,30}$/.test(name)) watchUser(name);
  else setStatus('That doesn’t look like a Lichess username.');
});
el.folderBtn.onclick = pickFolder;
el.moves.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ply]');
  if (btn) go(+btn.dataset.ply);
});
$('first').onclick = () => go(0, 1);
$('prev').onclick = () => go(currentIndex() - 1, -1);
$('next').onclick = () => go(currentIndex() + 1, 1);
el.live.onclick = () => { state.view = null; scheduleRender(); };
el.flip.onclick = () => { state.flipped = !state.flipped; scheduleRender(); };
el.sound.onclick = () => {
  state.sound = !state.sound;
  try { localStorage.setItem(SOUND_KEY, state.sound ? 'on' : 'off'); } catch { /* optional */ }
  el.sound.textContent = state.sound ? 'Sound on' : 'Sound off';
};
el.engineToggle.onclick = () => {
  state.analysis = !state.analysis;
  try { localStorage.setItem(ENGINE_KEY, state.analysis ? 'on' : 'off'); } catch { /* optional */ }
  scheduleRender();
};
function toggleOpt(name) {
  state.opts[name] = !state.opts[name];
  saveOpts();
  scheduleRender();
}
el.bestToggle.onclick = () => toggleOpt('arrow');
el.altToggle.onclick = () => toggleOpt('alts');
el.tacticsToggle.onclick = () => toggleOpt('tactics');
el.worst.addEventListener('click', (e) => {
  const card = e.target.closest('[data-ply]');
  if (card) go(+card.dataset.ply);
});
el.settings.addEventListener('change', (e) => {
  const input = e.target.closest('[data-opt]');
  if (!input) return;
  state.opts[input.dataset.opt] = input.type === 'checkbox' ? input.checked : +input.value;
  saveOpts();
  renderedMoves.version = -1;  // redraw the move symbols
  scheduleRender();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    Object.assign(badgeInteraction, { pinned: null, hovered: null, focused: null });
    refreshBadgeExplanation();
    return;
  }
  if (e.target.closest('input, select')) return;
  const keys = {
    ArrowLeft: () => $('prev').click(),
    ArrowRight: () => $('next').click(),
    Home: () => $('first').click(),
    End: () => el.live.click(),
    f: () => el.flip.click(),
    m: () => el.sound.click(),
    e: () => el.engineToggle.click(),
    b: () => el.bestToggle.click(),
    a: () => el.altToggle.click(),
    t: () => el.tacticsToggle.click(),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});

// Keep the running clock ticking between moves.
setInterval(() => {
  if (state.game && !state.game.over && state.view == null) {
    const idx = currentIndex();
    renderBars(state.game.plies[idx], idx);
  }
}, 100);

el.sound.textContent = state.sound ? 'Sound on' : 'Sound off';
initSections();
initBoardUnit();
initPanels();
buildBoard();
render();

// Start with what was watched last: a ?user= link wins, then the folder or the player from last time.
(async () => {
  const linkUser = new URLSearchParams(location.search).get('user');
  if (linkUser) return watchUser(linkUser);
  if (await restoreFolder()) return;
  let lastUser = null;
  try { lastUser = localStorage.getItem(LAST_USER_KEY); } catch { /* optional */ }
  if (lastUser) return watchUser(lastUser);
  setStatus('Enter a Lichess username to watch their games live.');
  el.userInput.focus();
})();
