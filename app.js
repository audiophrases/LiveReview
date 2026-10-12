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
const ENGINE_KEY = 'livewatch.engine';
const SOUND_KEY = 'livewatch.sound';
const OPTS_KEY = 'livewatch.opts';
const SWEEP_DEPTH = 12;  // every position, two lines, for the move symbols
const SWEEP_LINES = 2;
const ANALYSABLE = ['standard', 'fromPosition', 'chess960'];

const FOLDER_POLL_MS = 200;

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
  userForm: $('userForm'), userInput: $('userInput'), folderBtn: $('folderBtn'),
  engine: $('engine'), engineToggle: $('engineToggle'), bestToggle: $('bestToggle'),
  altToggle: $('altToggle'), tacticsToggle: $('tacticsToggle'), subopts: $('tacticOpts'), legend: $('legend'), worst: $('worst'), tally: $('tally'),
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
    tactics: false, tMate: true, tHanging: true, tTrade: true, tCheck: true, tQueen: true, tCapture: false,
    tFork: true, tPin: true, tSkewer: true, tDiscovered: true, tPressure: true, tRemoval: true, tZwischen: true,
    threats: false, depth: 18, multipv: 3,
  },
};
try {
  state.analysis = localStorage.getItem(ENGINE_KEY) !== 'off';
  state.sound = localStorage.getItem(SOUND_KEY) !== 'off';
  Object.assign(state.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}'));
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
  try { localStorage.setItem(LAST_USER_KEY, name); } catch { /* optional */ }
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
// We follow the newest .jsonl file in a folder the user picks each time.

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    setStatus('Your browser can’t open folders. Use Chrome, Edge or another Chromium browser (served from localhost).');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch {
    return;  // cancelled
  }
  watchFolder(handle);
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

// The worst inaccuracy, mistake or blunder either side has played so far: { i, lost, kind }.
function worstMove() {
  const plies = state.game?.plies || [];
  let worst = null;
  for (let i = 1; i < plies.length; i++) {
    const lost = moveLoss(i);
    if (lost != null && lost >= 0.1 && (!worst || lost > worst.lost)) worst = { i, lost };
  }
  if (worst) worst.kind = classify(worst.i);
  return worst;
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

// Tactics open to the side to move, flagged by kind so each can be shown or hidden on its own:
//   mate        checkmate in one
//   fork        the moved piece attacks two or more targets worth it, and can't simply be taken
//   skewer      a bishop, rook or queen lines up through a big piece (or the king) to one behind it
//   hanging     wins a piece (minor or bigger) that nothing defends
//   removal     captures a piece that was guarding another, which can then be won
//   discovered  moving a piece opens a line for a bishop, rook or queen onto a valuable target
//   trade       wins material by capturing a defended piece, once every recapture is played out
//   pin         a bishop, rook or queen pins a piece to a bigger one (or the king) behind it
//   pressure    adds a second (or more) attacker on a piece, at least as many attackers as defenders
//   check       gives check
//   queen       makes a new attack on the enemy queen (discovered attacks included)
//   capture     any other capture
// The zwischenzug needs the engine and is worked out separately (see zwischenzug()).
const TACTIC_RANK = {
  capture: 1, queen: 2, check: 3, pressure: 4, pin: 5, trade: 6,
  discovered: 7, removal: 8, hanging: 9, skewer: 10, fork: 11, mate: 12,
};
const TACTIC_OPT = {
  mate: 'tMate', fork: 'tFork', skewer: 'tSkewer', hanging: 'tHanging', removal: 'tRemoval',
  discovered: 'tDiscovered', trade: 'tTrade', pin: 'tPin', pressure: 'tPressure',
  check: 'tCheck', queen: 'tQueen', capture: 'tCapture', zwischen: 'tZwischen',
};
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

// Each detector returns what to draw with the move for that tactic, { lines: [{ from, to, dash, label }], label },
// or null when the move isn't that tactic. `after` is the board once m is played.

function detectFork(after, m, me) {
  if (pieceAtRisk(after, m.to) > 0) return null;
  const targets = [];
  for (const sq of attacksFrom(after, m.to)) {
    const p = cellAt(after, sq);
    if (!p || colorOf(p) === me) continue;
    if (typeOf(p) === 'k' || captureGain(after, m.to, sq) >= 2) targets.push(sq);
  }
  if (targets.length < 2) return null;
  return { lines: targets.map((sq) => ({ from: m.to, to: sq })), label: 'Fork' };
}

// Pins and skewers made by the moved bishop, rook or queen: { pin, skewer }.
function detectLine(after, m, me) {
  const mover = cellAt(after, m.to);
  const dirs = slideDirs(typeOf(mover));
  if (!dirs || pieceAtRisk(after, m.to) > 0) return {};
  const them = me === 'w' ? 'b' : 'w';
  const vMover = SEE_VALUE[typeOf(mover)];
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
    const winnable = (sq, v) => v > vMover || !attackersOf(after, sq, them).length;
    if (vA < vB && vA >= 3 && (typeOf(B) === 'k' || winnable(b, vB))) {
      found.pin ||= { lines: [{ from: m.to, to: b }], label: typeOf(B) === 'k' ? 'Pin+' : 'Pin' };
    } else if (vA > vB && vB >= 3 && (typeOf(A) === 'k' || winnable(a, vA)) && winnable(b, vB)) {
      found.skewer ||= { lines: [{ from: m.to, to: b }], label: 'Skewer' };
    }
  }
  return found;
}

// A bishop, rook or queen behind the moved piece now hits something worth it.
function detectDiscovered(after, m, me) {
  if (m.flags.includes('k') || m.flags.includes('q')) return null;
  for (const [df, dr] of [...DIAGONALS, ...ORTHOGONALS]) {
    const [behind] = piecesAlong(after, m.from, -df, -dr, 1);
    if (!behind) continue;
    const S = cellAt(after, behind);
    if (colorOf(S) !== me || !slideDirs(typeOf(S))?.some(([x, y]) => x === df && y === dr)) continue;
    const [target] = piecesAlong(after, m.from, df, dr, 1);
    if (!target || target === m.to) continue;
    const T = cellAt(after, target);
    if (colorOf(T) === me) continue;
    const check = typeOf(T) === 'k';
    if (check || captureGain(after, behind, target) >= 2) {
      return { lines: [{ from: behind, to: target }], label: check ? 'Disc+' : 'Disc' };
    }
  }
  return null;
}

// The move adds an attacker on a piece now attacked at least twice and no less than it is defended.
function detectPressure(grid, after, m, me) {
  const them = me === 'w' ? 'b' : 'w';
  let best = null;
  for (const sq of attacksFrom(after, m.to)) {
    const p = cellAt(after, sq);
    if (!p || colorOf(p) === me || typeOf(p) === 'k' || SEE_VALUE[typeOf(p)] < 3) continue;
    const attackers = attackersOf(after, sq, me);
    const defenders = attackersOf(after, sq, them);
    if (attackers.length < 2 || attackers.length < defenders.length) continue;
    if (attackersOf(grid, sq, me).filter((x) => x !== m.from).length >= attackers.length) continue;
    if (best && SEE_VALUE[typeOf(p)] <= best.value) continue;
    best = {
      value: SEE_VALUE[typeOf(p)],
      target: sq,
      lines: [
        ...attackers.map((a) => ({ from: a, to: sq, label: a === m.to ? `${attackers.length}v${defenders.length}` : null })),
        ...defenders.map((d) => ({ from: d, to: sq, dash: true })),
      ],
    };
  }
  return best && { lines: best.lines, label: null, target: best.target };
}

// Capturing a piece that guarded another, which can then be won.
function detectRemoval(grid, after, m, me) {
  if (!m.captured || m.flags.includes('e') || exchangeGain(grid, m) < 0) return null;
  for (const sq of attacksFrom(grid, m.to)) {
    const T = cellAt(grid, sq);
    if (!T || colorOf(T) === me || typeOf(T) === 'k' || SEE_VALUE[typeOf(T)] < 3) continue;
    if (bestCaptureOn(grid, sq, me).gain >= 2) continue;  // already winnable: nothing needed removing
    const next = bestCaptureOn(after, sq, me);
    if (next.gain >= 2) return { lines: [{ from: next.from, to: sq, dash: true }], label: 'Removal' };
  }
  return null;
}

// Every tactical idea for the side to move: [{ from, to, kinds: [...], extra: { kind: {...} }, gain, cost }],
// whatever the settings.
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
      const kinds = [];
      let gain = 0;
      if (m.san.endsWith('#')) kinds.push('mate');
      else if (m.san.endsWith('+')) kinds.push('check');
      if (m.captured) {
        kinds.push('capture');
        if (!m.flags.includes('e')) {
          const defended = attackersOf(playOnGrid(grid, m), m.to, them).length > 0;
          if (!defended && SEE_VALUE[m.captured] >= 3) {
            kinds.push('hanging');
            gain = SEE_VALUE[m.captured];
          } else if (defended) {
            gain = exchangeGain(grid, m);
            if (gain >= 1) kinds.push('trade');
          }
        }
      }
      const after = playOnGrid(grid, m);
      if (queens.length && m.captured !== 'q') {
        if (queens.some((q) => attackersOf(after, q, me).some((sq) => !before.has(sq === m.to ? m.from : sq)))) kinds.push('queen');
      }
      const extra = {};
      const note = (kind, info) => {
        if (!info) return;
        kinds.push(kind);
        extra[kind] = info;
      };
      note('fork', detectFork(after, m, me));
      const line = detectLine(after, m, me);
      note('pin', line.pin);
      note('skewer', line.skewer);
      note('discovered', detectDiscovered(after, m, me));
      note('pressure', detectPressure(grid, after, m, me));
      note('removal', detectRemoval(grid, after, m, me));
      if (!kinds.length) continue;
      const key = m.from + m.to;
      const old = found.get(key);
      if (old) {
        for (const k of kinds) if (!old.kinds.includes(k)) old.kinds.push(k);
        for (const k in extra) old.extra[k] ||= extra[k];
        old.gain = Math.max(old.gain, gain);
      } else {
        found.set(key, { from: m.from, to: m.to, kinds, extra, gain, cost: SEE_VALUE[m.piece] });
      }
    }
    // Of several pieces that can win the same target, only the best one (most gain, then cheapest) is marked.
    for (const kind of ['hanging', 'trade']) {
      const byTarget = new Map();
      for (const t of found.values()) {
        if (!t.kinds.includes(kind)) continue;
        const best = byTarget.get(t.to);
        if (!best || t.gain > best.gain || (t.gain === best.gain && t.cost < best.cost)) {
          if (best) best.kinds.splice(best.kinds.indexOf(kind), 1);
          byTarget.set(t.to, t);
        } else {
          t.kinds.splice(t.kinds.indexOf(kind), 1);
        }
      }
    }
    // Likewise one "attackers vs defenders" move per pressured piece: the cheapest piece doing it.
    const byPressured = new Map();
    for (const t of found.values()) {
      if (!t.kinds.includes('pressure')) continue;
      const target = t.extra.pressure.target;
      const best = byPressured.get(target);
      const drop = (x) => x.kinds.splice(x.kinds.indexOf('pressure'), 1);
      if (!best || t.cost < best.cost) {
        if (best) drop(best);
        byPressured.set(target, t);
      } else {
        drop(t);
      }
    }
  }
  const result = [...found.values()].filter((t) => t.kinds.length);
  if (tacticsCache.size > 2000) tacticsCache.clear();
  tacticsCache.set(fen, result);
  return result;
}

// What to draw: the kinds switched on in settings, one arrow per move showing its most important kind.
function tactics(fen) {
  const out = [];
  for (const t of tacticMoves(fen)) {
    let kind = null;
    for (const k of t.kinds) {
      if (state.opts[TACTIC_OPT[k]] && (!kind || TACTIC_RANK[k] > TACTIC_RANK[kind])) kind = k;
    }
    if (kind) out.push({ from: t.from, to: t.to, kind, extra: t.extra[kind] || null });
  }
  return out;
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
  for (const item of el.legend.querySelectorAll('[data-kind]')) item.hidden = !state.opts[TACTIC_OPT[item.dataset.kind]];
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

// The worst move of the game so far as a little board that jumps there when clicked.
let worstHtml = '';
function renderWorst(idx) {
  const game = state.game;
  let html = '';
  if (game && state.opts.worst && canAnalyse(game) && game.plies.length > 1) {
    const w = worstMove();
    if (!w) {
      html = '<p class="worst-none">No inaccuracies or worse yet.</p>';
    } else {
      const prev = game.plies[w.i - 1];
      const cur = game.plies[w.i];
      const better = evals.get(prev.fen)?.lines[0];
      const color = prev.fen.split(' ')[1] === 'w' ? 'white' : 'black';
      const name = game.info?.players?.[color]?.user?.name || cap(color);
      html =
        `<button class="worst-card${idx === w.i ? ' cur' : ''}" data-ply="${w.i}" title="Show this move on the board">` +
        miniBoardHtml(cur.fen, cur.lm, castleFix(prev.fen, cur.lm).slice(2, 4), w.kind) +
        '<span class="worst-info">' +
        `<span><span class="sym k-${w.kind}">${KINDS[w.kind].sym}</span> <b>${esc(moveLabel(w.i))}</b></span>` +
        `<span class="muted">${esc(name)} · ${KINDS[w.kind].word.toLowerCase()}</span>` +
        `<span>${evalText(prev.fen)} → ${evalText(cur.fen)}</span>` +
        (better ? `<span class="muted">Best was <b>${esc(toSan(prev.fen, better.pv[0]))}</b></span>` : '') +
        '</span></button>';
    }
  }
  if (html !== worstHtml) {
    el.worst.innerHTML = html;
    worstHtml = html;
  }
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

// Tactics underneath (the opponent's threats lowest), engine arrows on top, labels over everything.
function drawArrows(ply, engineArrows) {
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
    const add = (fen, dash) => {
      for (const t of tactics(fen)) {
        const color = TACTIC_COLOR[t.kind];
        const opacity = dash ? 0.55 : 0.85;
        list.push({ from: t.from, to: t.to, color, width: t.kind === 'mate' ? 0.14 : 0.1, opacity, dash, label: t.extra?.label });
        // The idea behind the move: fork targets, the pinned line, the unmasked attacker, the defenders...
        for (const x of t.extra?.lines || []) {
          if (x.from === x.to) continue;
          list.push({ from: x.from, to: x.to, color, width: 0.055, opacity: opacity * 0.85, dash: dash || x.dash, label: x.label });
        }
      }
    };
    // Passing the turn is meaningless while the side to move is in check.
    if (state.opts.threats && !findCheckedKing(ply.fen)) add(passTurn(ply.fen), true);
    add(ply.fen, false);
    if (state.opts.tZwischen && state.analysis) {
      const z = zwischenzug(currentIndex());
      if (z) {
        const color = TACTIC_COLOR.zwischen;
        list.push({ from: z.from, to: z.to, color, width: 0.11, opacity: 0.9, label: 'Zw' });
        list.push({ from: z.later.slice(0, 2), to: z.later.slice(2, 4), color, width: 0.055, opacity: 0.75, dash: true });
      }
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
  const checkSquare = ply ? findCheckedKing(ply.fen) : null;

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
    if (badge?.square === name) html += `<span class="badge k-${badge.kind}" title="${KINDS[badge.kind].word}">${KINDS[badge.kind].sym}</span>`;
    if (sq.innerHTML !== html) sq.innerHTML = html;
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

let startUser = new URLSearchParams(location.search).get('user');
if (!startUser) {
  try { startUser = localStorage.getItem(LAST_USER_KEY); } catch { /* optional */ }
}
if (startUser) {
  watchUser(startUser);
} else {
  setStatus('Enter a Lichess username to watch their games live.');
  el.userInput.focus();
}
