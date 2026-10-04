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
const OPTS_KEY = 'livewatch.opts';
const SWEEP_DEPTH = 12;  // every position, two lines, for the move symbols
const SWEEP_LINES = 2;
const ANALYSABLE = ['standard', 'fromPosition', 'chess960'];

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
  userForm: $('userForm'), userInput: $('userInput'),
  engine: $('engine'), engineToggle: $('engineToggle'), bestToggle: $('bestToggle'),
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
  game: null,
  view: null,          // ply index being viewed, or null to follow live
  orientation: 'white',
  flipped: false,
  sound: true,
  analysis: true,
  opts: { bar: true, arrow: true, lines: true, symbols: true, depth: 18, multipv: 3 },
};
try {
  state.analysis = localStorage.getItem(ENGINE_KEY) !== 'off';
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
  const { depth, multipv } = state.opts;
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

// What kind of move produced ply i: one of KINDS, or null for an ordinary good move.
function classify(i) {
  const plies = state.game?.plies;
  if (!plies || i < 1 || !canAnalyse(state.game)) return null;
  const prev = plies[i - 1];
  const cur = plies[i];
  if (!prev || !cur?.lm) return null;
  const before = positionChances(prev.fen);
  const after = positionChances(cur.fen);
  if (before == null || after == null) return null;
  const s = prev.fen.split(' ')[1] === 'w' ? 1 : -1;  // mover's point of view
  const lost = (before - after) * s;
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
  renderAnalysis(ply, idx);
  renderControls();
  if (game && ply) {
    if (game.over) setStatus([game.result || resultText(game), game.waiting].filter(Boolean).join(' '));
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
  for (const input of el.settings.querySelectorAll('[data-opt]')) {
    const v = state.opts[input.dataset.opt];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = String(v);
    input.disabled = !state.analysis;
  }
}

function renderAnalysis(ply, idx) {
  const on = canAnalyse(state.game);
  const opts = state.opts;
  el.boardwrap.classList.toggle('off', !on || !ply || !opts.bar);
  pumpEngine();
  if (!state.analysis || !ply) {
    el.engine.innerHTML = '';
    drawArrow(null);
    return;
  }
  if (engine.failed) {
    el.engine.innerHTML = '<div class="head">Stockfish couldn’t start in this browser.</div>';
    drawArrow(null);
    return;
  }
  if (!on) {
    el.engine.innerHTML = `<div class="head">No engine analysis for ${esc(state.game.info.variant.name)}.</div>`;
    drawArrow(null);
    return;
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

  drawArrow(opts.arrow && !t ? best?.pv[0] : null);

  // Who is winning, then the engine's lines
  const depth = e ? Math.max(0, ...e.lines.filter(Boolean).map((l) => l.depth)) : 0;
  const summary = t === 'draw' ? 'Stalemate' : t ? `Checkmate · ${t === 'w' ? 'Black' : 'White'} wins`
    : chances == null ? 'Thinking…' : `${describeAdvantage(chances)} (${fmtEval(best)})`;
  let html = `<div class="head"><span class="adv">${summary}</span><span>${t || !depth ? '' : `Stockfish 16 · depth ${depth}`}</span></div>`;
  if (opts.lines && !t) {
    for (const line of (e?.lines || []).slice(0, opts.multipv)) {
      if (!line) continue;
      html += `<div class="line"><span class="ev${winChances(line) < 0 ? ' neg' : ''}">${fmtEval(line)}</span>` +
        `<span class="pv">${esc(pvToSan(ply.fen, line.pv))}</span></div>`;
    }
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
    html += tallyHtml();
  }
  el.engine.innerHTML = html;
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

function drawArrow(uci) {
  let svg = el.board.querySelector('svg.arrows');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('viewBox', '0 0 8 8');
    el.board.appendChild(svg);
  }
  if (!uci) {
    svg.innerHTML = '';
    return;
  }
  const [x1, y1] = squareCenter(uci.slice(0, 2));
  const [x2, y2] = squareCenter(uci.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * 0.42;
  const by = y2 - uy * 0.42;
  svg.innerHTML =
    `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="#2f7fd8" stroke-width="0.17" stroke-linecap="round" opacity="0.8"/>` +
    `<polygon points="${x2},${y2} ${bx - uy * 0.26},${by + ux * 0.26} ${bx + uy * 0.26},${by - ux * 0.26}" fill="#2f7fd8" opacity="0.8"/>`;
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
  const rows = ply ? ply.fen.split(' ')[0].split('/') : [];
  const grid = rows.map((row) => {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < +ch; k++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
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

function findCheckedKing(fen) {
  if (!chess.load(fen) || !chess.in_check()) return null;
  const turn = chess.turn();
  for (const f of FILES) {
    for (let r = 1; r <= 8; r++) {
      const p = chess.get(f + r);
      if (p && p.type === 'k' && p.color === turn) return f + r;
    }
  }
  return null;
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
  parts.push(info.rated ? 'Rated' : 'Casual');
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

// ---------- wiring ----------

el.userForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.userInput.value.trim().replace(/^.*lichess\.org\/@\//, '').replace(/\/.*$/, '');
  if (/^[A-Za-z0-9_-]{2,30}$/.test(name)) watchUser(name);
  else setStatus('That doesn’t look like a Lichess username.');
});
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
  el.sound.textContent = state.sound ? 'Sound on' : 'Sound off';
};
el.engineToggle.onclick = () => {
  state.analysis = !state.analysis;
  try { localStorage.setItem(ENGINE_KEY, state.analysis ? 'on' : 'off'); } catch { /* optional */ }
  scheduleRender();
};
el.bestToggle.onclick = () => {
  state.opts.arrow = !state.opts.arrow;
  saveOpts();
  scheduleRender();
};
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
