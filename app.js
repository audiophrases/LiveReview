// Live Watch: follows a Lichess player and shows their games live through the
// public streaming API. One game stream is open at a time; between games the
// player's status is polled so the next game opens as soon as it starts.

const API = 'https://lichess.org';
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';
const USER_POLL_MS = 4000;
const RATE_LIMIT_WAIT_MS = 60000;
const LAST_USER_KEY = 'livewatch.user';
const ENGINE_KEY = 'livewatch.engine';
const VIEW_DEPTH = 18;   // the position on screen, three lines
const SWEEP_DEPTH = 12;  // every other position, one line, for the move verdicts
const VIEW_LINES = 3;
const ANALYSABLE = ['standard', 'fromPosition', 'chess960'];

const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'), barTop: $('barTop'), barBottom: $('barBottom'),
  status: $('status'), meta: $('meta'), moves: $('moves'), open: $('open'),
  live: $('live'), flip: $('flip'), sound: $('sound'),
  userForm: $('userForm'), userInput: $('userInput'),
  engine: $('engine'), engineToggle: $('engineToggle'), boardwrap: document.querySelector('.boardwrap'),
  evalbar: $('evalbar'), evalfill: $('evalfill'), evaltext: $('evaltext'),
};

const state = {
  user: null,          // { name, id } of the player being followed
  session: 0,          // bumped whenever the followed player changes, so stale callbacks drop out
  gameCtrl: null,      // AbortController for the game stream
  pollTimer: null,
  game: null,          // { id, info, plies: [{ fen, lm, san, wc, bc }], over, result, receivedAt }
  view: null,          // ply index being viewed, or null to follow live
  orientation: 'white',
  flipped: false,
  sound: true,
  analysis: true,
};
try { state.analysis = localStorage.getItem(ENGINE_KEY) !== 'off'; } catch { /* optional */ }

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
  state.gameCtrl?.abort();
  state.gameCtrl = null;
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

async function openGame(id, session, { quiet = false } = {}) {
  state.gameCtrl?.abort();
  const ctrl = new AbortController();
  state.gameCtrl = ctrl;
  const game = { id, info: null, plies: [], over: false, result: null, receivedAt: 0, lastLineAt: 0, waiting: null };
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
        addPly(game, obj);
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
}

// ---------- game data ----------

const chess = new Chess();

function addPly(game, line) {
  const prev = game.plies[game.plies.length - 1];
  const ply = { fen: line.fen, lm: line.lm || null, san: null, wc: line.wc, bc: line.bc };
  if (ply.lm && prev) ply.san = toSan(prev.fen, ply.lm);
  game.plies.push(ply);
  const now = performance.now();
  // The stream first replays the whole game in one burst; only chime for moves that arrive on their own.
  if (ply.lm && game.lastLineAt && now - game.lastLineAt > 400) playMoveSound(ply.san);
  game.lastLineAt = now;
  game.receivedAt = now;
}

function toSan(fen, uci) {
  if (!chess.load(fen)) return uci;
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const promotion = uci[4];
  const piece = chess.get(from);
  const target = chess.get(to);
  // Lichess sometimes sends castling as king-takes-own-rook.
  if (piece?.type === 'k' && target?.type === 'r' && target.color === piece.color) {
    to = (to[0] > from[0] ? 'g' : 'c') + from[1];
  }
  const move = chess.move({ from, to, promotion });
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
  if (want(viewFen, VIEW_DEPTH, VIEW_LINES)) return start(viewFen, VIEW_DEPTH, VIEW_LINES);
  for (let i = game.plies.length - 1; i >= 0; i--) {
    const fen = game.plies[i].fen;
    if (want(fen, SWEEP_DEPTH, 1)) return start(fen, SWEEP_DEPTH, 1);
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

// Verdict on the move that produced ply i, from the winning chances the mover gave away.
function verdict(i) {
  const plies = state.game.plies;
  if (i < 1 || !canAnalyse(state.game)) return null;
  const before = positionChances(plies[i - 1].fen);
  const after = positionChances(plies[i].fen);
  if (before == null || after == null) return null;
  const mover = plies[i - 1].fen.split(' ')[1] === 'w' ? 1 : -1;
  const lost = (before - after) * mover;
  if (lost >= 0.3) return 'blunder';
  if (lost >= 0.2) return 'mistake';
  if (lost >= 0.1) return 'inaccuracy';
  return null;
}

const VERDICT_MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const VERDICT_WORD = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };

function fmtEval(line) {
  if (!line) return '';
  if (line.mate != null) return `${line.mate > 0 ? '' : '-'}M${Math.abs(line.mate)}`;
  const v = line.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 0 : 1);
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

function currentIndex() {
  const n = state.game?.plies.length || 0;
  if (!n) return -1;
  return state.view == null ? n - 1 : Math.min(state.view, n - 1);
}

function render() {
  const game = state.game;
  const idx = currentIndex();
  const ply = idx >= 0 ? game.plies[idx] : null;
  renderBoard(ply);
  renderBars(ply, idx);
  renderMoves(idx);
  renderMeta();
  renderAnalysis(ply, idx);
  el.live.classList.toggle('on', state.view == null);
  if (game && ply) {
    if (game.over) setStatus([game.result || resultText(game), game.waiting].filter(Boolean).join(' '));
    else if (state.view != null) setStatus('Reviewing. Press Live to catch up.');
    else setStatus('Live');
  }
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

function renderAnalysis(ply, idx) {
  const on = canAnalyse(state.game);
  el.engineToggle.classList.toggle('on', state.analysis);
  el.engineToggle.textContent = state.analysis ? 'Engine on' : 'Engine off';
  el.boardwrap.classList.toggle('off', !on || !ply);
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

  // Eval bar
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

  drawArrow(t ? null : best?.pv[0]);

  // Engine lines
  const depth = e ? Math.max(0, ...e.lines.filter(Boolean).map((l) => l.depth)) : 0;
  let html = `<div class="head"><span>Stockfish 16</span><span>${t ? '' : depth ? `depth ${depth}` : 'thinking…'}</span></div>`;
  if (t) html += `<div class="line">${t === 'draw' ? 'Stalemate.' : 'Checkmate.'}</div>`;
  for (const line of (e?.lines || []).slice(0, VIEW_LINES)) {
    if (!line) continue;
    html += `<div class="line"><span class="ev${winChances(line) < 0 ? ' neg' : ''}">${fmtEval(line)}</span>` +
      `<span class="pv">${esc(pvToSan(ply.fen, line.pv))}</span></div>`;
  }

  // What the engine thinks of the move that led here
  const v = idx >= 1 ? verdict(idx) : null;
  if (v) {
    const prevFen = state.game.plies[idx - 1].fen;
    const better = evals.get(prevFen)?.lines[0];
    const betterSan = better ? toSan(prevFen, better.pv[0]) : null;
    html += `<div class="note"><span class="v-${v}-t">${VERDICT_WORD[v]}.</span> ${esc(ply.san || ply.lm)} was played` +
      (betterSan && betterSan !== ply.san ? `; best was <b>${esc(betterSan)}</b> (${fmtEval(better)}).` : '.') + '</div>';
  }
  html += tallyHtml();
  el.engine.innerHTML = html;
}

function tallyHtml() {
  const plies = state.game.plies;
  if (plies.length < 2) return '';
  const count = { white: { inaccuracy: 0, mistake: 0, blunder: 0 }, black: { inaccuracy: 0, mistake: 0, blunder: 0 } };
  let checked = 0;
  for (let i = 1; i < plies.length; i++) {
    if (positionChances(plies[i].fen) == null || positionChances(plies[i - 1].fen) == null) continue;
    checked++;
    const v = verdict(i);
    if (v) count[plies[i - 1].fen.split(' ')[1] === 'w' ? 'white' : 'black'][v]++;
  }
  const side = (c) => `${c === 'white' ? 'White' : 'Black'}: ${count[c].inaccuracy} ?! · ${count[c].mistake} ? · ${count[c].blunder} ??`;
  const progress = checked < plies.length - 1 ? `<br>Checked ${checked} of ${plies.length - 1} moves…` : '';
  return `<div class="tally">${side('white')}<br>${side('black')}${progress}</div>`;
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
  const black = (state.orientation === 'black') !== state.flipped;
  const center = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const r = +sq[1] - 1;
    return black ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
  };
  const [x1, y1] = center(uci.slice(0, 2));
  const [x2, y2] = center(uci.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * 0.42;
  const by = y2 - uy * 0.42;
  svg.innerHTML =
    `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="#2f7fd8" stroke-width="0.17" stroke-linecap="round" opacity="0.8"/>` +
    `<polygon points="${x2},${y2} ${bx - uy * 0.26},${by + ux * 0.26} ${bx + uy * 0.26},${by - ux * 0.26}" fill="#2f7fd8" opacity="0.8"/>`;
}

function setWaiting(text) {
  if (state.game) {
    state.game.waiting = text;
    scheduleRender();
  } else {
    setStatus(text);
  }
}

function renderBoard(ply) {
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
  const moves = game.plies.length - 1;
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

let renderedMoves = { id: null, count: 0, cur: -1 };
function renderMoves(idx) {
  const game = state.game;
  const plies = game?.plies || [];
  if (renderedMoves.id !== game?.id || renderedMoves.count > Math.max(plies.length, 1)) {
    el.moves.innerHTML = '';
    renderedMoves = { id: game?.id, count: 0, cur: -1 };
  }
  // Ply 0 is the starting position; moves start at ply 1.
  const startsWhite = plies[0]?.fen.split(' ')[1] !== 'b';
  for (let i = Math.max(1, renderedMoves.count); i < plies.length; i++) {
    const moveNo = Math.floor((i - 1 + (startsWhite ? 0 : 1)) / 2) + 1;
    const whiteMove = startsWhite ? i % 2 === 1 : i % 2 === 0;
    if (whiteMove || i === 1) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="n">${moveNo}.</span>`;
      if (!whiteMove) li.innerHTML += '<span>…</span>';
      el.moves.appendChild(li);
    }
    const btn = document.createElement('button');
    btn.innerHTML = `${esc(plies[i].san || plies[i].lm)}<span class="mark"></span>`;
    btn.dataset.ply = i;
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
    const v = verdict(+btn.dataset.ply);
    const cls = v ? `v-${v}` : '';
    if (btn.dataset.v === cls) continue;
    btn.dataset.v = cls;
    btn.classList.remove('v-inaccuracy', 'v-mistake', 'v-blunder');
    if (cls) btn.classList.add(cls);
    btn.querySelector('.mark').textContent = v ? VERDICT_MARK[v] : '';
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

function go(idx) {
  const n = state.game?.plies.length || 0;
  if (!n) return;
  idx = Math.max(0, Math.min(n - 1, idx));
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
$('first').onclick = () => go(0);
$('prev').onclick = () => go(currentIndex() - 1);
$('next').onclick = () => go(currentIndex() + 1);
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

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  const keys = {
    ArrowLeft: () => go(currentIndex() - 1),
    ArrowRight: () => go(currentIndex() + 1),
    Home: () => go(0),
    End: () => el.live.click(),
    f: () => el.flip.click(),
    m: () => el.sound.click(),
    e: () => el.engineToggle.click(),
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
