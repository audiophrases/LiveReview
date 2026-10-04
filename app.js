// Live Review — follows a Chess.com player and opens a full review of each
// game the moment it ends: the board, an advantage bar and a verdict on every
// move, while the player still remembers what they were thinking. Learning
// from a mistake lands hardest while the mistake is fresh.
//
// Only finished games are ever read. Chess.com publishes a game to its public
// API once it is over and not before, and this app reads nothing else. An
// engine's view of a game still being played is engine help to whoever is
// playing it, with or without a best move on screen: a bar jumping to +4 after
// the opponent's move says there is a winning shot. So the review arrives the
// instant the game is over, which is the earliest it can be fair.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search || '');
  var DEPTH = clampInt(params.get('depth'), 6, 22, 12);
  // How many of the engine's best moves each position lists. Three lines
  // cost the search about twice what one does, hence the shallower depth.
  var LINES = clampInt(params.get('lines'), 1, 5, 3);
  var POLL_MS = clampInt(params.get('poll'), 3, 300, 10) * 1000;
  var MATE = 100000;
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var API = 'https://api.chess.com/pub/player/';
  var KEYS = {
    user: 'live.user.v1',
    watching: 'live.watching.v1',
    guess: 'live.guess.v1',
    notify: 'live.notify.v1',
    reviews: 'live.reviews.v1',
  };
  var MAX_SAVED = 40;
  var RECENT_SHOWN = 15;
  var DRAWS = ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'];
  /* Lichess's thresholds, on the mover's winning chances: a move that throws
     away ten points of them is an inaccuracy, twenty a mistake, thirty a
     blunder. Winning chances rather than pawns, because a pawn means
     everything at 0.0 and nothing at +9. */
  var CLS = {
    best: { name: 'Best', glyph: '★' },
    good: { name: 'Good', glyph: '✓' },
    inaccuracy: { name: 'Inaccuracy', glyph: '?!' },
    mistake: { name: 'Mistake', glyph: '?' },
    blunder: { name: 'Blunder', glyph: '??' },
  };
  var ERRORS = ['inaccuracy', 'mistake', 'blunder'];
  var PIECE = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
  var FILES = 'abcdefgh';

  // "Deeper review" hands the game to the suite's Chess Reviewer. Inside the
  // suite our own path (…/live/…) says where it lives; standing alone on
  // GitHub Pages we reach across to the published suite, which shares our
  // origin and so our localStorage.
  var SUITE_BASE = (function () {
    var i = location.pathname.indexOf('/live/');
    return i >= 0 ? location.pathname.slice(0, i + 1) : 'https://audiophrases.github.io/yourlines/';
  })();

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load(key, dflt) {
    try { var v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }

  // ---- Engine (single-threaded Stockfish 16, UCI over a Worker) ------------
  var engine = (function () {
    var worker = null, state = 'booting', readyResolve;
    var ready = new Promise(function (r) { readyResolve = r; });
    var queue = [], active = null;
    function fail() {
      if (state === 'failed') return;
      state = 'failed';
      readyResolve(false);
      engineFailed();
    }
    function parseInfo(line) {
      var p = line.split(/\s+/), m = {};
      for (var i = 0; i < p.length; i++) {
        if (p[i] === 'depth') m.depth = +p[i + 1];
        else if (p[i] === 'multipv') m.multipv = +p[i + 1];
        else if (p[i] === 'score') {
          if (p[i + 1] === 'cp') m.cp = +p[i + 2];
          else if (p[i + 1] === 'mate') m.mate = +p[i + 2];
        } else if (p[i] === 'pv') { m.pv = p.slice(i + 1); break; }
      }
      return m;
    }
    try { worker = new Worker('engine/stockfish-nnue-16-single.js'); } catch (e) { worker = null; }
    if (!worker) {
      setTimeout(fail, 0);
    } else {
      worker.onerror = fail;
      worker.onmessage = function (e) {
        var line = String(e.data || '');
        if (state === 'booting') {
          if (line.indexOf('uciok') >= 0) {
            worker.postMessage('setoption name MultiPV value ' + LINES);
            worker.postMessage('isready');
          }
          else if (line.indexOf('readyok') >= 0) { state = 'ready'; readyResolve(true); }
          return;
        }
        if (!active) return;
        if (line.lastIndexOf('info', 0) === 0) {
          var info = parseInfo(line);
          if (info.cp != null || info.mate != null) {
            var slot = info.multipv || 1;
            active.lines[slot] = info;
            /* Only the first line is the position's evaluation: the last info
               of an iteration is the weakest line kept. */
            if (slot === 1) active.last = info;
          }
        } else if (line.lastIndexOf('bestmove', 0) === 0) {
          var bm = line.split(/\s+/)[1];
          var last = active.last || {};
          // Scores come from the side to move; everything here is White's.
          var s = active.fen.split(' ')[1] === 'w' ? 1 : -1;
          var res = {
            cp: last.cp != null ? s * last.cp : null,
            mate: last.mate != null ? s * last.mate : null,
            depth: last.depth || 0,
            best: bm && bm !== '(none)' ? bm : null,
            pv: last.pv || [],
            // Every line kept, best first, each named by the move that starts it.
            alts: Object.keys(active.lines)
              .sort(function (x, y) { return x - y; })
              .map(function (k) {
                var L = active.lines[k];
                return {
                  uci: L.pv && L.pv.length ? L.pv[0] : null,
                  cp: L.cp != null ? s * L.cp : null,
                  mate: L.mate != null ? s * L.mate : null,
                  pv: (L.pv || []).slice(0, 6),
                };
              })
              .filter(function (x) { return !!x.uci; }),
          };
          var job = active;
          active = null;
          job.resolve(res);
          pump();
        }
      };
      worker.postMessage('uci');
      setTimeout(function () { if (state === 'booting') fail(); }, 20000);
    }
    function pump() {
      if (active || !queue.length || state !== 'ready') return;
      active = queue.shift();
      worker.postMessage('position fen ' + active.fen);
      worker.postMessage('go depth ' + active.depth);
    }
    return {
      analyse: function (fen, depth) {
        return ready.then(function (ok) {
          if (!ok) throw new Error('engine unavailable');
          return new Promise(function (resolve) {
            queue.push({ fen: fen, depth: depth, resolve: resolve, last: null, lines: {} });
            pump();
          });
        });
      },
      /* Drop whatever is waiting. The search already running finishes (or
         stops) and hands its answer to a review that has gone, which ignores
         it. */
      clear: function () {
        queue.length = 0;
        if (active && worker) worker.postMessage('stop');
      },
      failed: function () { return state === 'failed'; },
    };
  })();

  function engineFailed() {
    var w = $('engwarn');
    if (!w) return;
    w.hidden = false;
    w.textContent = 'The engine could not start in this browser, so the moves cannot be judged. ' +
      'The games still arrive, and "Deeper review" still hands them to the Reviewer.';
  }

  // ---- Evaluation maths (centipawns from White's side; mate near ±MATE) ----
  function whiteCp(res) {
    if (res.mate != null) return res.mate > 0 ? MATE - res.mate : -MATE - res.mate;
    return res.cp != null ? res.cp : 0;
  }
  function isMate(cp) { return Math.abs(cp) >= MATE - 999; }
  function winPct(cp) {
    if (cp >= MATE - 999) return 100;
    if (cp <= -(MATE - 999)) return 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }
  function fmtEval(cp) {
    if (isMate(cp)) {
      var n = MATE - Math.abs(cp);
      return n === 0 ? '#' : (cp > 0 ? '' : '−') + 'M' + n;
    }
    var v = cp / 100;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  }
  // What fits across the bar: the side that is ahead is where the label sits.
  function fmtEvalShort(cp) {
    if (isMate(cp)) { var n = MATE - Math.abs(cp); return n === 0 ? '#' : 'M' + n; }
    var v = Math.abs(cp) / 100;
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }

  // ---- Chess.com ------------------------------------------------------------
  function monthUrl(user, d) {
    return API + encodeURIComponent(user) + '/games/' + d.getUTCFullYear() + '/' +
      String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  function prevMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); }
  /* no-cache rather than no-store: every poll asks Chess.com whether the month
     has changed, and most of the time the answer is a bodiless 304. */
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) {
        var e = new Error('Chess.com answered ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }
  function fetchMonth(user, d) {
    return fetchJson(monthUrl(user, d)).then(function (j) { return (j && j.games) || []; });
  }
  function normalize(g, user) {
    if (!g || !g.pgn || (g.rules && g.rules !== 'chess')) return null;
    var w = g.white || {}, b = g.black || {};
    var color = (w.username || '').toLowerCase() === user ? 'white'
      : (b.username || '').toLowerCase() === user ? 'black' : null;
    if (!color) return null;
    var me = color === 'white' ? w : b, opp = color === 'white' ? b : w;
    return {
      id: g.uuid || g.url,
      url: g.url,
      pgn: g.pgn,
      endTime: g.end_time || 0,
      timeClass: g.time_class || '',
      timeControl: g.time_control || '',
      rated: !!g.rated,
      color: color,
      me: { name: me.username, rating: me.rating, result: me.result },
      opp: { name: opp.username, rating: opp.rating, result: opp.result },
      outcome: me.result === 'win' ? 'win' : DRAWS.indexOf(me.result) >= 0 ? 'draw' : 'loss',
    };
  }
  function tcLabel(g) {
    if (g.timeClass === 'daily') return 'daily';
    var tc = parseTc(g.timeControl);
    if (!tc) return g.timeClass;
    var base = tc.base % 60 === 0 ? tc.base / 60 : tc.base + 's';
    return g.timeClass + ' ' + base + (tc.inc ? '+' + tc.inc : '');
  }
  function ago(sec) {
    var d = Math.max(0, Math.round(Date.now() / 1000 - sec));
    if (d < 60) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' d ago';
  }

  // ---- Watching ---------------------------------------------------------------
  var W = {
    user: null,       // lower-case, as the API wants it
    display: null,    // as the player spells it
    running: false,
    busy: false,
    timer: 0,
    baseline: 0,      // end_time of the newest game seen; anything later is new
    lastCheck: 0,
    nextAt: 0,
    failures: 0,
    error: null,
    recent: [],       // newest first
  };

  function startWatching(name) {
    var user = String(name || '').trim().replace(/^@/, '');
    if (!user) return;
    setupError('');
    pause();
    var btn = $('watchBtn');
    btn.disabled = true;
    btn.textContent = 'Looking…';
    fetchJson(API + encodeURIComponent(user.toLowerCase()))
      .then(function (p) {
        if (!p) throw new Error('There is no Chess.com player called "' + user + '".');
        var spelled = p.url ? decodeURIComponent(String(p.url).split('/').pop()) : '';
        W.user = user.toLowerCase();
        W.display = spelled && spelled.toLowerCase() === W.user ? spelled : user;
        W.recent = [];
        save(KEYS.user, W.display);
        save(KEYS.watching, true);
        if (R && R.game.me.name.toLowerCase() !== W.user) closeReview();
        showMain();
        renderStatus();
        renderRecent();
        return loadHistory();
      })
      .then(function () {
        if (W.user) resume();
      })
      .catch(function (e) {
        setupError(e && e.message ? e.message : 'Could not reach Chess.com.');
        showSetup();
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Start watching';
      });
  }

  /* The last few games, for the list and for "review your last game" — and
     the newest of them is where watching starts from, so a game that ended
     yesterday does not pop up as though it just had. */
  function loadHistory() {
    var now = new Date();
    return fetchMonth(W.user, now)
      .then(function (games) {
        if (games.length >= RECENT_SHOWN) return games;
        return fetchMonth(W.user, prevMonth(now)).then(
          function (older) { return older.concat(games); },
          function () { return games; },
        );
      })
      .then(function (games) {
        W.baseline = games.reduce(function (m, g) { return Math.max(m, g.end_time || 0); }, 0);
        W.recent = games
          .map(function (g) { return normalize(g, W.user); })
          .filter(Boolean)
          .sort(function (a, b) { return b.endTime - a.endTime; })
          .slice(0, RECENT_SHOWN);
        W.lastCheck = Date.now();
        renderRecent();
        if (!R) renderVerdict();
      });
  }

  function poll() {
    if (!W.running || W.busy) return;
    W.busy = true;
    clearTimeout(W.timer);
    renderStatus();
    var user = W.user;
    var now = new Date();
    // Just past midnight on the 1st, a game that ended on the old month's
    // last evening can still be on its way into that month's archive.
    var months = [now];
    if (now.getUTCDate() === 1 && now.getUTCHours() < 3) months.unshift(prevMonth(now));
    Promise.all(months.map(function (d) { return fetchMonth(user, d); }))
      .then(function (lists) {
        if (user !== W.user) return;
        var games = [].concat.apply([], lists);
        W.lastCheck = Date.now();
        W.failures = 0;
        W.error = null;
        var fresh = games.filter(function (g) { return (g.end_time || 0) > W.baseline; });
        if (!fresh.length) return;
        W.baseline = fresh.reduce(function (m, g) { return Math.max(m, g.end_time || 0); }, W.baseline);
        var mine = fresh
          .map(function (g) { return normalize(g, user); })
          .filter(Boolean)
          .sort(function (a, b) { return a.endTime - b.endTime; });
        if (!mine.length) return;
        mine.forEach(function (g) {
          W.recent = [g].concat(W.recent.filter(function (r) { return r.id !== g.id; }));
        });
        W.recent = W.recent.slice(0, RECENT_SHOWN);
        var newest = mine[mine.length - 1];
        announce(newest);
        openReview(newest);
      })
      .catch(function (e) {
        W.failures++;
        W.error = e;
      })
      .then(function () {
        W.busy = false;
        schedule();
        renderStatus();
        renderRecent();
      });
  }

  function schedule() {
    clearTimeout(W.timer);
    if (!W.running) return;
    // Back off while Chess.com is unhappy with us, up to two minutes.
    var d = W.failures ? Math.min(POLL_MS * Math.pow(2, W.failures), 120000) : POLL_MS;
    W.nextAt = Date.now() + d;
    W.timer = setTimeout(poll, d);
  }
  function resume() {
    W.running = true;
    save(KEYS.watching, true);
    schedule();
    renderStatus();
  }
  function pause() {
    W.running = false;
    clearTimeout(W.timer);
    renderStatus();
  }

  // ---- Telling the player ------------------------------------------------------
  var audio = null;
  var TITLE = document.title;
  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) {}
  }
  function chime() {
    if (!audio || audio.state !== 'running') return;
    var t = audio.currentTime;
    [659.25, 880].forEach(function (f, i) {
      var o = audio.createOscillator(), g = audio.createGain(), at = t + i * 0.16;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      o.connect(g);
      g.connect(audio.destination);
      o.start(at);
      o.stop(at + 0.55);
    });
  }
  function announce(g) {
    chime();
    if (!document.hidden) return;
    document.title = '● Review ready · Live Review';
    if (!load(KEYS.notify, false) || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var n = new Notification('Your review is ready', {
        body: 'Your game against ' + g.opp.name + ' just ended. Come and see where it turned.',
        tag: 'live-review',
      });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (e) {}
  }

  // ---- The review ----------------------------------------------------------------
  var R = null;     // the game on screen
  var token = 0;    // which review an engine answer belongs to
  var cls = [];     // verdict per ply (1-based), rebuilt on every render
  var reviews = load(KEYS.reviews, {}) || {};

  function parseTc(s) {
    var m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(s || '');
    return m ? { base: +m[1], inc: m[2] ? +m[2] : 0 } : null;
  }
  function parseClocks(pgn, n) {
    var re = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g, out = [], m;
    while ((m = re.exec(pgn))) out.push(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
    return out.length === n ? out : null;
  }
  // The clock after a move already has the increment in it, so the time the
  // move took is what the clock lost, plus the increment it got back.
  function spentTimes(clocks, moves, tc) {
    if (!clocks || !tc) return null;
    var last = { w: tc.base, b: tc.base };
    return clocks.map(function (c, i) {
      var side = moves[i].color, s = last[side] - c + tc.inc;
      last[side] = c;
      return Math.max(0, s);
    });
  }

  function parseGame(g) {
    var c = new Chess();
    if (!c.load_pgn(g.pgn)) return null;
    var hdr = c.header() || {};
    var start = hdr.FEN || START_FEN;
    var hist = c.history({ verbose: true });
    var r = new Chess(start);
    var fens = [r.fen()], moves = [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      var mv = r.move({ from: h.from, to: h.to, promotion: h.promotion });
      if (!mv) return null;
      moves.push({ san: mv.san, uci: h.from + h.to + (h.promotion || ''), from: h.from, to: h.to, color: mv.color });
      fens.push(r.fen());
    }
    var f = start.split(' ');
    var tc = parseTc(g.timeControl);
    var clocks = parseClocks(g.pgn, moves.length);
    return {
      game: g,
      start: start,
      startNo: +f[5] || 1,
      startColor: f[1] || 'w',
      moves: moves,
      fens: fens,
      termination: hdr.Termination || '',
      tc: tc,
      clocks: clocks,
      spent: spentTimes(clocks, moves, tc),
    };
  }

  function openReview(g) {
    var parsed = parseGame(g);
    if (!parsed) {
      flashVerdict('That game could not be read.');
      return;
    }
    token++;
    engine.clear();
    var saved = reviews[g.id];
    R = parsed;
    R.token = token;
    R.evals = saved && saved.evals && saved.evals.length === R.fens.length ? saved.evals.slice() : new Array(R.fens.length);
    R.guess = saved && saved.guess != null ? saved.guess : null;
    R.phase = (saved && saved.revealed) || !load(KEYS.guess, true) ? 'reveal' : 'guess';
    R.ply = 0;
    R.orient = g.color;
    R.myColor = g.color[0];
    R.done = false;
    document.querySelectorAll('.rg.on').forEach(function (el) { el.classList.remove('on'); });
    buildMoves();
    analyseAll();
    persist();
    render();
    renderRecent();
  }

  function closeReview() {
    token++;
    engine.clear();
    R = null;
    buildMoves();
    render();
  }

  function terminalEval(fen) {
    var c = new Chess(fen);
    if (c.in_checkmate()) return { cp: c.turn() === 'w' ? -MATE : MATE, best: null, pv: [] };
    if (c.in_stalemate() || c.insufficient_material()) return { cp: 0, best: null, pv: [] };
    return null;
  }

  function analyseAll() {
    var rv = R, t = R.token;
    rv.fens.forEach(function (fen, i) {
      if (rv.evals[i]) return;
      var term = terminalEval(fen);
      if (term) { rv.evals[i] = term; return; }
      engine.analyse(fen, DEPTH).then(
        function (res) {
          if (t !== token) return;
          rv.evals[i] = {
            cp: whiteCp(res),
            best: res.best,
            pv: res.pv.slice(0, 8),
            alts: res.alts.map(function (x) { return { uci: x.uci, cp: whiteCp(x), pv: x.pv }; }),
          };
          scheduleRender();
        },
        function () {},
      );
    });
    scheduleRender();
  }

  // Not evals.every(): the array starts out with holes, and every() skips them.
  function allEvaluated() {
    for (var i = 0; i < R.evals.length; i++) if (!R.evals[i]) return false;
    return true;
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      render();
    });
  }

  function classifyAll() {
    var out = [];
    if (!R) return out;
    for (var k = 1; k <= R.moves.length; k++) {
      var a = R.evals[k - 1], b = R.evals[k];
      if (!a || !b) continue;
      var m = R.moves[k - 1], white = m.color === 'w';
      var before = white ? winPct(a.cp) : 100 - winPct(a.cp);
      var after = white ? winPct(b.cp) : 100 - winPct(b.cp);
      // The engine's own choice costs nothing; any swing is just the search
      // seeing further one move on.
      var best = !!a.best && a.best === m.uci;
      var loss = best ? 0 : Math.max(0, before - after);
      out[k] = {
        cls: best ? 'best' : loss >= 30 ? 'blunder' : loss >= 20 ? 'mistake' : loss >= 10 ? 'inaccuracy' : 'good',
        loss: loss,
        before: before,
        after: after,
        // Lichess's accuracy curve: 100 for a move that loses nothing.
        acc: clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669, 0, 100),
      };
    }
    return out;
  }

  function summarize() {
    var s = {};
    ['w', 'b'].forEach(function (c) { s[c] = { accSum: 0, n: 0, inaccuracy: 0, mistake: 0, blunder: 0 }; });
    for (var k = 1; k <= R.moves.length; k++) {
      var v = cls[k];
      if (!v) continue;
      var side = s[R.moves[k - 1].color];
      side.accSum += v.acc;
      side.n++;
      if (ERRORS.indexOf(v.cls) >= 0) side[v.cls]++;
    }
    ['w', 'b'].forEach(function (c) { s[c].acc = s[c].n ? s[c].accSum / s[c].n : null; });
    return s;
  }

  function isMine(k) { return !!R && k >= 1 && R.moves[k - 1].color === R.myColor; }
  function myErrors() {
    var out = [];
    for (var k = 1; k <= R.moves.length; k++) if (isMine(k) && cls[k] && ERRORS.indexOf(cls[k].cls) >= 0) out.push(k);
    return out;
  }
  function worstMine() {
    var worst = null;
    for (var k = 1; k <= R.moves.length; k++) {
      if (!isMine(k) || !cls[k]) continue;
      if (!worst || cls[k].loss > cls[worst].loss) worst = k;
    }
    return worst;
  }
  /* The guess, marked: did the player's instinct find the move the engine
     says cost the most? Close counts too — a move that really was a mistake,
     just not the worst one. */
  function guessVerdict() {
    if (!R || R.guess == null || !R.done) return null;
    var worst = worstMine();
    if (!worst || ERRORS.indexOf(cls[worst].cls) < 0) return 'clean';
    if (worst === R.guess) return 'match';
    var g = cls[R.guess];
    return g && (g.cls === 'mistake' || g.cls === 'blunder') ? 'close' : 'miss';
  }

  function persist() {
    if (!R) return;
    var e = reviews[R.game.id] || {};
    e.game = R.game;
    e.revealed = R.phase === 'reveal';
    e.guess = R.guess;
    e.savedAt = Date.now();
    if (R.done) {
      e.evals = R.evals;
      var s = summarize()[R.myColor];
      e.summary = { acc: s.acc, inaccuracy: s.inaccuracy, mistake: s.mistake, blunder: s.blunder };
      e.verdict = guessVerdict();
    }
    reviews[R.game.id] = e;
    var ids = Object.keys(reviews).sort(function (a, b) { return (reviews[b].savedAt || 0) - (reviews[a].savedAt || 0); });
    ids.slice(MAX_SAVED).forEach(function (id) { delete reviews[id]; });
    save(KEYS.reviews, reviews);
  }

  function moveNo(k) {
    var j = k - 1 + (R.startColor === 'b' ? 1 : 0);
    return R.startNo + Math.floor(j / 2);
  }
  function moveLabel(k) {
    var m = R.moves[k - 1];
    return moveNo(k) + (m.color === 'w' ? '. ' : '… ') + m.san;
  }
  function uciToSan(fen, uci) {
    var c = new Chess(fen);
    var mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    return mv ? mv.san : uci;
  }
  function pvToSan(fen, pv, max) {
    var c = new Chess(fen), out = [];
    for (var i = 0; i < pv.length && i < max; i++) {
      var mv = c.move({ from: pv[i].slice(0, 2), to: pv[i].slice(2, 4), promotion: pv[i][4] || undefined });
      if (!mv) break;
      out.push(mv.san);
    }
    return out.join(' ');
  }
  function movetext(k) {
    var out = [];
    for (var i = 1; i <= k; i++) {
      var m = R.moves[i - 1];
      if (m.color === 'w') out.push(moveNo(i) + '. ' + m.san);
      else out.push(i === 1 ? moveNo(i) + '... ' + m.san : m.san);
    }
    return out.join(' ');
  }
  function clockAt(color, k) {
    if (!R.clocks) return null;
    for (var i = k; i >= 1; i--) if (R.moves[i - 1].color === color) return R.clocks[i - 1];
    return R.tc ? R.tc.base : null;
  }
  function fmtClock(s) {
    if (s == null) return '';
    if (s < 20) return s.toFixed(1);
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function fmtSpent(s) {
    if (s < 10) return s.toFixed(1) + ' s';
    if (s < 90) return Math.round(s) + ' s';
    return fmtClock(s);
  }

  // ---- Rendering ------------------------------------------------------------------
  function render() {
    cls = R ? classifyAll() : [];
    if (R && !R.done && allEvaluated()) {
      R.done = true;
      persist();
      renderRecent();
    }
    renderBoard();
    renderArrows();
    renderEvalBar();
    renderPlayers();
    renderMoves();
    renderVerdict();
    renderSummary();
    renderGraph();
  }

  function boardMap(fen) {
    var rows = fen.split(' ')[0].split('/'), map = {};
    for (var i = 0; i < 8; i++) {
      var f = 0;
      for (var j = 0; j < rows[i].length; j++) {
        var ch = rows[i].charAt(j);
        if (ch >= '1' && ch <= '8') { f += +ch; continue; }
        map[FILES[f] + (8 - i)] = (ch === ch.toUpperCase() ? 'white-' : 'black-') + PIECE[ch.toUpperCase()];
        f++;
      }
    }
    return map;
  }
  function revealed() { return !!R && R.phase === 'reveal'; }
  function flipped() { return (R ? R.orient : 'white') === 'black'; }

  function renderBoard() {
    var fen = R ? R.fens[R.ply] : START_FEN;
    var map = boardMap(fen), flip = flipped();
    var last = R && R.ply > 0 ? R.moves[R.ply - 1] : null;
    var v = revealed() && R.ply > 0 ? cls[R.ply] : null;
    var html = '';
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        var f = flip ? 7 - col : col, r = flip ? row : 7 - row;
        var sq = FILES[f] + (r + 1);
        var c = 'sq ' + ((f + r) % 2 === 1 ? 'l' : 'd');
        if (last && (sq === last.from || sq === last.to)) c += ' last';
        html += '<div class="' + c + '">';
        if (map[sq]) html += '<img src="pieces/' + map[sq] + '.png" alt="">';
        if (col === 0) html += '<span class="coord rank">' + (r + 1) + '</span>';
        if (row === 7) html += '<span class="coord file">' + FILES[f] + '</span>';
        if (v && sq === last.to) html += '<span class="badge bg-' + v.cls + '" title="' + CLS[v.cls].name + '">' + CLS[v.cls].glyph + '</span>';
        html += '</div>';
      }
    }
    $('board').innerHTML = html;
  }

  function center(sq) {
    var f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return flipped() ? { x: 7 - f + 0.5, y: r + 0.5 } : { x: f + 0.5, y: 7 - r + 0.5 };
  }
  function renderArrows() {
    var svg = $('arrows');
    svg.querySelectorAll('line').forEach(function (l) { l.remove(); });
    if (!revealed() || R.ply === 0 || !cls[R.ply]) return;
    var v = cls[R.ply], a = R.evals[R.ply - 1], b = R.evals[R.ply];
    // Your slip: what you should have played. Theirs: how to punish it.
    if (isMine(R.ply) && ERRORS.indexOf(v.cls) >= 0 && a.best) arrow(svg, a.best, 'better', '#57c98a');
    if (!isMine(R.ply) && (v.cls === 'mistake' || v.cls === 'blunder') && b.best) arrow(svg, b.best, 'punish', '#4fd1c5');
  }
  function arrow(svg, uci, kind, color) {
    var p1 = center(uci.slice(0, 2)), p2 = center(uci.slice(2, 4));
    var dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1, cut = 0.32;
    var l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', p1.x);
    l.setAttribute('y1', p1.y);
    l.setAttribute('x2', p2.x - (dx / len) * cut);
    l.setAttribute('y2', p2.y - (dy / len) * cut);
    l.setAttribute('stroke', color);
    l.setAttribute('stroke-width', '0.17');
    l.setAttribute('stroke-linecap', 'round');
    l.setAttribute('opacity', '0.88');
    l.setAttribute('marker-end', 'url(#ah-' + kind + ')');
    svg.appendChild(l);
  }

  function renderEvalBar() {
    var bar = $('evalbar'), fill = $('evalFill'), txt = $('evalTxt');
    var flip = flipped();
    fill.className = 'fill ' + (flip ? 'from-top' : 'from-bottom');
    var ev = R && R.evals[R.ply];
    if (!revealed() || !ev) {
      bar.classList.add('hidden');
      fill.style.height = '50%';
      txt.className = 'evaltxt';
      txt.style.color = '';
      txt.textContent = R && R.phase === 'guess' ? '?' : '';
      bar.title = R && R.phase === 'guess' ? 'Hidden until you have had your guess' : 'Advantage bar';
      return;
    }
    bar.classList.remove('hidden');
    fill.style.height = winPct(ev.cp).toFixed(1) + '%';
    var whiteAhead = ev.cp >= 0;
    txt.textContent = fmtEvalShort(ev.cp);
    txt.className = 'evaltxt ' + (flip !== whiteAhead ? 'at-bottom' : 'at-top');
    txt.style.color = whiteAhead ? '#1a1e2b' : '#eef1f8';
    bar.title = 'Advantage bar: ' + fmtEval(ev.cp) + ' (White ' + Math.round(winPct(ev.cp)) + '%)';
  }

  function renderPlayers() {
    var top = $('playerTop'), bottom = $('playerBottom');
    if (!R) { top.innerHTML = bottom.innerHTML = ''; return; }
    var g = R.game, bottomColor = R.orient[0];
    function strip(color) {
      var mine = color === R.myColor, p = mine ? g.me : g.opp;
      var clock = clockAt(color, R.ply);
      var low = clock != null && R.tc && clock < Math.max(10, R.tc.base * 0.1);
      return '<span class="name">' + esc(p.name) + '</span>' +
        (p.rating ? '<span class="rating">(' + p.rating + ')</span>' : '') +
        (mine ? '<span class="you">you</span>' : '') +
        (clock != null ? '<span class="clock' + (low ? ' low' : '') + '">' + fmtClock(clock) + '</span>' : '');
    }
    bottom.innerHTML = strip(bottomColor);
    top.innerHTML = strip(bottomColor === 'w' ? 'b' : 'w');
  }

  function buildMoves() {
    var box = $('moves');
    if (!R) { box.innerHTML = '<span class="muted">No game yet.</span>'; return; }
    var html = '';
    for (var k = 1; k <= R.moves.length; k++) {
      var m = R.moves[k - 1];
      if (m.color === 'w' || k === 1) {
        html += '<span class="no">' + moveNo(k) + '.</span>';
        if (m.color === 'b') html += '<span></span>';
      }
      html += '<button type="button" data-ply="' + k + '"><span class="san">' + esc(m.san) + '</span><span class="g"></span></button>';
    }
    box.innerHTML = html || '<span class="muted">No moves were played.</span>';
    box.scrollTop = 0;
  }
  function renderMoves() {
    if (!R) return;
    var box = $('moves'), show = revealed();
    box.querySelectorAll('button[data-ply]').forEach(function (b) {
      var k = +b.getAttribute('data-ply'), v = show ? cls[k] : null;
      b.className = (k === R.ply ? 'on ' : '') + (isMine(k) ? 'mine ' : '') + (v ? 'c-' + v.cls + ' ' : '') +
        (R.guess === k ? 'guessed' : '');
      var g = b.lastChild;
      g.textContent = v && v.cls !== 'good' ? CLS[v.cls].glyph : '';
      g.className = 'g' + (v ? ' c-' + v.cls : '');
      b.title = v ? CLS[v.cls].name : '';
    });
    var on = box.querySelector('button.on');
    if (on) {
      // Keep the current move in view without scrolling the page itself.
      var top = on.offsetTop - box.offsetTop, h = on.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top - 4;
      else if (top + h > box.scrollTop + box.clientHeight) box.scrollTop = top + h - box.clientHeight + 4;
    } else if (R.ply === 0) {
      box.scrollTop = 0;
    }
  }

  function progressHtml() {
    if (!R || R.done) return '';
    var n = R.evals.filter(Boolean).length, total = R.evals.length;
    if (engine.failed()) return '';
    return '<div class="progress"><div class="progress-track"><div class="progress-fill" style="width:' +
      Math.round((n / total) * 100) + '%"></div></div><div class="lbl">The engine is reading the game: ' +
      n + ' of ' + total + ' positions</div></div>';
  }

  function resultLine() {
    var g = R.game;
    var head = g.outcome === 'win' ? 'You won' : g.outcome === 'loss' ? 'You lost' : 'Draw';
    return '<b>' + head + '</b>' + (R.termination ? ' · ' + esc(R.termination) : '') +
      ' · ' + esc(tcLabel(g)) + (g.rated ? '' : ' · casual');
  }

  var flashMsg = '';
  function flashVerdict(msg) {
    flashMsg = msg;
    renderVerdict();
    setTimeout(function () { flashMsg = ''; renderVerdict(); }, 4000);
  }

  function renderVerdict() {
    var el = $('verdict');
    if (!el) return;
    if (!R) {
      var last = W.recent[0];
      el.innerHTML =
        '<div class="head"><span class="mv">Waiting for your next game</span></div>' +
        '<p>Go and play on Chess.com. When the game ends it opens here, with the engine already reading it, ' +
        'usually within a few seconds of the last move.</p>' +
        (flashMsg ? '<p class="err">' + esc(flashMsg) + '</p>' : '') +
        (last
          ? '<p class="muted small">Your last game: ' + resultWord(last) + ' against ' + esc(last.opp.name) + ', ' + ago(last.endTime) + '.</p>' +
            '<div class="actions"><button type="button" class="btn" data-act="review-last">Review your last game</button></div>'
          : '');
      return;
    }

    if (R.phase === 'guess') {
      var k = R.ply, mine = isMine(k);
      el.innerHTML =
        '<div class="head"><span class="mv">Game over</span><span class="who">' + resultLine() + '</span></div>' +
        '<p class="ask">Before the engine speaks: <b>which of your moves do you regret most?</b> Step through the game ' +
        '(← →), stop on that move and press <b>This was my mistake</b>.</p>' +
        '<p class="muted small">' + (k === 0 ? 'At the start. Step forward.'
          : mine ? 'Showing your move <b>' + esc(moveLabel(k)) + '</b>.'
          : 'This is ' + esc(R.game.opp.name) + '\'s move. Step to one of yours.') + '</p>' +
        '<div class="actions">' +
        '<button type="button" class="btn primary" data-act="guess"' + (mine ? '' : ' disabled') + '>This was my mistake</button>' +
        '<button type="button" class="btn" data-act="skip-guess">No idea, show me</button>' +
        '</div>' + progressHtml();
      return;
    }

    if (R.ply === 0) {
      var errs = myErrors();
      el.innerHTML =
        '<div class="head"><span class="mv">Start position</span><span class="who">' + resultLine() + '</span></div>' +
        '<p>' + R.moves.length + ' moves. Step through with ← →, or go straight to where it went wrong.</p>' +
        '<div class="actions">' +
        (errs.length ? '<button type="button" class="btn primary" data-act="first-error">Go to my first mistake</button>' : '') +
        (R.done && !errs.length ? '<span class="muted">No move of yours cost more than a tenth of your chances. A clean game.</span>' : '') +
        '</div>' + progressHtml();
      return;
    }

    var k2 = R.ply, m = R.moves[k2 - 1], v = cls[k2], mine2 = isMine(k2);
    var who = mine2 ? 'Your move' : esc(R.game.opp.name) + '\'s move';
    if (!v) {
      el.innerHTML =
        '<div class="head"><span class="mv">' + esc(moveLabel(k2)) + '</span><span class="who">' + who + '</span></div>' +
        '<p class="muted">The engine has not reached this move yet.</p>' + progressHtml();
      return;
    }
    var a = R.evals[k2 - 1], b = R.evals[k2];
    var parts = [];
    parts.push('<p>Eval <b>' + fmtEval(a.cp) + '</b> → <b>' + fmtEval(b.cp) + '</b>' +
      (mine2 ? ' · your winning chances ' + Math.round(v.before) + '% → ' + Math.round(v.after) + '%' : '') + '</p>');

    if (mine2 && ERRORS.indexOf(v.cls) >= 0 && a.best) {
      var prevV = cls[k2 - 1];
      if (k2 > 1 && !isMine(k2 - 1) && prevV && (prevV.cls === 'mistake' || prevV.cls === 'blunder')) {
        parts.push('<p>Your opponent had just slipped with <b>' + esc(moveLabel(k2 - 1)) + '</b>. This was the moment to punish it.</p>');
      }
      parts.push('<p>Better was <b>' + esc(uciToSan(R.fens[k2 - 1], a.best)) + '</b> (green arrow).</p>');
    } else if (!mine2 && (v.cls === 'mistake' || v.cls === 'blunder') && b.best) {
      var punish = uciToSan(R.fens[k2], b.best);
      var reply = k2 < R.moves.length ? R.moves[k2] : null;
      parts.push('<p>Your opponent slipped. The punishment was <b>' + esc(punish) + '</b> (teal arrow).' +
        (reply ? (reply.uci === b.best ? ' You found it.' : ' You played ' + esc(reply.san) + '.') : '') + '</p>');
    } else if (v.cls === 'best') {
      parts.push('<p>The engine\'s own choice.</p>');
    }

    var alts = altsHtml(k2);
    if (alts) parts.push(alts);

    if (R.spent && R.clocks) {
      var spent = R.spent[k2 - 1], left = R.clocks[k2 - 1];
      parts.push('<p class="muted small">' + (mine2 ? 'You took ' : 'Took ') + fmtSpent(spent) + ', with ' + fmtClock(left) + ' left.' +
        (mine2 && ERRORS.indexOf(v.cls) >= 0 && spent < 3 && R.tc && R.tc.base >= 180 ? ' Fast, for a move that mattered.' : '') + '</p>');
    }

    el.innerHTML =
      '<div class="head"><span class="mv">' + esc(moveLabel(k2)) + '</span>' +
      '<span class="cls c-' + v.cls + '">' + CLS[v.cls].glyph + ' ' + CLS[v.cls].name + '</span>' +
      '<span class="who">' + who + '</span></div>' + parts.join('') + progressHtml();
  }

  /* The engine's best few moves in the position the move was played from,
     with what each was worth, and the move actually played marked among
     them, or set beneath them when it was none of them. Always the position
     before a move already made, never the one on the board waiting for a
     move. */
  function altsHtml(k) {
    var a = R.evals[k - 1], b = R.evals[k], m = R.moves[k - 1];
    if (!a || !a.alts || !a.alts.length) return '';
    var fen = R.fens[k - 1], found = false;
    var rows = a.alts.map(function (x, i) {
      var played = x.uci === m.uci;
      if (played) found = true;
      var rest = pvToSan(fen, x.pv, 5).split(' ').slice(1).join(' ');
      return '<li' + (played ? ' class="played"' : '') + '><span class="rank">' + (i + 1) + '</span>' +
        '<b>' + esc(uciToSan(fen, x.uci)) + '</b><span class="ev">' + fmtEval(x.cp) + '</span>' +
        (played ? '<span class="tag">played</span>' : '') +
        (rest ? '<span class="cont">' + esc(rest) + '</span>' : '') + '</li>';
    });
    if (!found && b) {
      rows.push('<li class="played off"><span class="rank">·</span><b>' + esc(m.san) + '</b><span class="ev">' +
        fmtEval(b.cp) + '</span><span class="tag">played</span></li>');
    }
    return '<div class="alts"><div class="alts-h">Top engine moves here</div><ol>' + rows.join('') + '</ol></div>';
  }

  function resultWord(g) { return g.outcome === 'win' ? 'a win' : g.outcome === 'loss' ? 'a loss' : 'a draw'; }

  function countsHtml(s) {
    var out = ERRORS.map(function (c) {
      return '<span class="chip"><span class="dot bg-' + c + '"></span>' + s[c] + ' ' +
        (c === 'inaccuracy' ? (s[c] === 1 ? 'inaccuracy' : 'inaccuracies') : CLS[c].name.toLowerCase() + (s[c] === 1 ? '' : 's')) + '</span>';
    });
    return out.join('');
  }

  function renderSummary() {
    var el = $('summary');
    if (!R || !revealed()) { el.hidden = true; return; }
    el.hidden = false;
    var s = summarize(), me = R.myColor, them = me === 'w' ? 'b' : 'w';
    function row(side, label) {
      var acc = R.done && s[side].acc != null ? Math.round(s[side].acc) : '…';
      return '<div class="sum-row"><div><div class="who">' + label + '</div><div class="counts">' + countsHtml(s[side]) +
        '</div></div><div class="acc">' + acc + '<small>accuracy</small></div></div>';
    }
    var guessHtml = '';
    if (R.guess != null) {
      var gv = guessVerdict(), worst = worstMine();
      var picked = '<b>' + esc(moveLabel(R.guess)) + '</b>';
      if (!R.done) guessHtml = 'You picked ' + picked + '. The engine is still checking.';
      else if (gv === 'match') guessHtml = 'You picked ' + picked + ', and the engine agrees: it was your costliest move.';
      else if (gv === 'close') guessHtml = 'You picked ' + picked + ', a real ' + CLS[cls[R.guess].cls].name.toLowerCase() +
        '. The costliest was <b>' + esc(moveLabel(worst)) + '</b>.';
      else if (gv === 'clean') guessHtml = 'You picked ' + picked + ', but the engine found no real mistake of yours in this game.';
      else guessHtml = 'You picked ' + picked + ' (' + (cls[R.guess] ? CLS[cls[R.guess].cls].name.toLowerCase() : '…') +
        '). The engine\'s choice was <b>' + esc(moveLabel(worst)) + '</b> (' + CLS[cls[worst].cls].name.toLowerCase() + ').';
      guessHtml = '<div class="match">' + guessHtml + (R.done && worst && R.guess !== worst && gv !== 'clean'
        ? ' <button type="button" class="btn small" data-act="goto" data-ply="' + worst + '">Show it</button>' : '') + '</div>';
    }
    var errs = myErrors();
    el.innerHTML =
      '<div class="sum-head">' + resultLine() + '</div>' +
      row(me, 'You (' + (me === 'w' ? 'White' : 'Black') + ')') +
      row(them, esc(R.game.opp.name)) +
      guessHtml +
      '<div class="sum-actions">' +
      (errs.length
        ? '<button type="button" class="btn small" data-act="prev-error">◀ Previous mistake</button>' +
          '<button type="button" class="btn small" data-act="next-error">Next mistake ▶</button>'
        : '') +
      '<button type="button" class="btn small teal" data-act="deep" title="Hand this game to the Chess Reviewer for a deeper look">Deeper review ↗</button>' +
      (R.game.url ? '<a class="btn small" href="' + esc(R.game.url) + '" target="_blank" rel="noopener">Chess.com ↗</a>' : '') +
      '</div>';
  }

  function renderGraph() {
    var el = $('graph');
    if (!el) return;
    if (!R || !revealed()) {
      el.innerHTML = '<div class="veil">' + (R ? 'Hidden until you have had your guess' : 'How the advantage moved will show here') + '</div>';
      return;
    }
    var w = el.clientWidth || 300, h = el.clientHeight || 90, N = R.fens.length;
    var x = function (i) { return N > 1 ? (i / (N - 1)) * w : 0; };
    var y = function (cp) { return h - (winPct(cp) / 100) * h; };
    var pts = [];
    for (var i = 0; i < N; i++) if (R.evals[i]) pts.push([x(i), y(R.evals[i].cp)]);
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<rect width="' + w + '" height="' + h + '" fill="#3a3f4f"/>';
    if (pts.length) {
      var d = 'M' + pts[0][0].toFixed(1) + ',' + h;
      pts.forEach(function (p) { d += ' L' + p[0].toFixed(1) + ',' + p[1].toFixed(1); });
      d += ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + h + ' Z';
      svg += '<path d="' + d + '" fill="#e6e9f2"/>';
    }
    svg += '<line x1="0" x2="' + w + '" y1="' + h / 2 + '" y2="' + h / 2 + '" stroke="#6b7290" stroke-width="1" stroke-dasharray="3 3"/>';
    var cx = x(R.ply).toFixed(1);
    svg += '<line x1="' + cx + '" x2="' + cx + '" y1="0" y2="' + h + '" stroke="#f2b544" stroke-width="2"/>';
    var colors = { inaccuracy: '#e8c547', mistake: '#f2994a', blunder: '#f2668b' };
    for (var k = 1; k < N; k++) {
      var v = cls[k];
      if (!v || ERRORS.indexOf(v.cls) < 0 || !R.evals[k]) continue;
      if (!isMine(k) && v.cls === 'inaccuracy') continue;
      svg += '<circle cx="' + x(k).toFixed(1) + '" cy="' + y(R.evals[k].cp).toFixed(1) + '" r="' + (isMine(k) ? 4 : 3) +
        '" fill="' + (isMine(k) ? colors[v.cls] : '#0f1117') + '" stroke="' + (isMine(k) ? '#0f1117' : colors[v.cls]) + '" stroke-width="1.5"/>';
    }
    el.innerHTML = svg + '</svg>';
  }

  function renderRecent() {
    var box = $('recent');
    if (!box) return;
    if (!W.recent.length) {
      box.innerHTML = '<span class="muted">' + (W.user ? 'No recent games on Chess.com.' : '') + '</span>';
    } else {
      box.innerHTML = W.recent.map(function (g) {
        var rv = reviews[g.id], s = rv && rv.summary, stat;
        if (s) {
          var bits = [];
          if (s.blunder) bits.push('<span class="c-blunder">' + s.blunder + '??</span>');
          if (s.mistake) bits.push('<span class="c-mistake">' + s.mistake + '?</span>');
          if (s.inaccuracy) bits.push('<span class="c-inaccuracy">' + s.inaccuracy + '?!</span>');
          stat = (s.acc != null ? Math.round(s.acc) + '% ' : '') + bits.join(' ');
        } else {
          stat = '<span class="todo">Review</span>';
        }
        var letter = g.outcome === 'win' ? 'W' : g.outcome === 'loss' ? 'L' : 'D';
        return '<button type="button" class="rg' + (R && R.game.id === g.id ? ' on' : '') + '" data-game="' + esc(g.id) + '">' +
          '<span class="res ' + g.outcome + '">' + letter + '</span>' +
          '<span><span class="opp">' + esc(g.opp.name) + (g.opp.rating ? ' <span class="meta">(' + g.opp.rating + ')</span>' : '') + '</span>' +
          '<span class="sub meta">' + esc(tcLabel(g)) + ' · ' + ago(g.endTime) + '</span></span>' +
          '<span class="stat">' + stat + '</span></button>';
      }).join('');
    }
    // How often the player's own sense of where it went wrong agreed with
    // the engine — the skill the guess is there to train.
    var marked = Object.keys(reviews).map(function (id) { return reviews[id].verdict; })
      .filter(function (v) { return v === 'match' || v === 'close' || v === 'miss'; });
    var hits = marked.filter(function (v) { return v === 'match'; }).length;
    $('instinct').textContent = marked.length ? '· your guess matched the engine in ' + hits + ' of ' + marked.length : '';
  }

  function renderStatus() {
    var main = $('statusMain'), sub = $('statusSub'), pulse = $('pulse');
    if (!main || !W.user) return;
    main.innerHTML = (W.running ? 'Watching ' : 'Paused · ') + '<b>' + esc(W.display) + '</b> on Chess.com';
    pulse.className = 'pulse' + (!W.running ? ' paused' : W.error ? ' error' : '');
    $('pauseBtn').textContent = W.running ? 'Pause' : 'Resume';
    if (!W.running) {
      sub.textContent = 'Not checking for new games. Resume when you play again.';
    } else if (W.error) {
      sub.textContent = 'Chess.com did not answer (' + (W.error.status || 'no connection') + '). Trying again in ' +
        Math.max(0, Math.round((W.nextAt - Date.now()) / 1000)) + ' s.';
    } else {
      var since = W.lastCheck ? Math.round((Date.now() - W.lastCheck) / 1000) : null;
      sub.textContent = 'Each game opens here the moment it ends. ' +
        (W.busy ? 'Checking…' : since == null ? '' : 'Checked ' + (since < 2 ? 'just now' : since + ' s ago') + '.');
    }
  }

  // ---- Moving around --------------------------------------------------------------
  function go(k) {
    if (!R) return;
    R.ply = clamp(k, 0, R.moves.length);
    render();
  }
  function nextError(dir) {
    var errs = myErrors();
    if (!errs.length) return;
    var target = dir > 0
      ? errs.filter(function (k) { return k > R.ply; })[0] || errs[0]
      : errs.filter(function (k) { return k < R.ply; }).pop() || errs[errs.length - 1];
    go(target);
  }
  function reveal() {
    if (!R) return;
    R.phase = 'reveal';
    persist();
    render();
  }

  function deepReview() {
    if (!R) return;
    try {
      localStorage.setItem('yourlines:handoff:review', JSON.stringify({ pgn: R.game.pgn, player: R.game.me.name, ts: Date.now() }));
    } catch (e) {}
    var win = null;
    try { win = window.open(SUITE_BASE + 'review/', 'yourlines-review'); } catch (e) {}
    if (win) { try { win.focus(); } catch (e) {} } else location.href = SUITE_BASE + 'review/';
  }

  function onAction(act, el) {
    if (act === 'guess') {
      if (!isMine(R.ply)) return;
      R.guess = R.ply;
      reveal();
    } else if (act === 'skip-guess') {
      R.guess = null;
      reveal();
      var errs = myErrors();
      if (errs.length) go(errs[0]);
    } else if (act === 'first-error') {
      var e = myErrors();
      if (e.length) go(e[0]);
    } else if (act === 'next-error') nextError(1);
    else if (act === 'prev-error') nextError(-1);
    else if (act === 'goto') go(+el.getAttribute('data-ply'));
    else if (act === 'deep') deepReview();
    else if (act === 'review-last' && W.recent[0]) openReview(W.recent[0]);
  }

  // ---- Screens --------------------------------------------------------------------
  function showSetup() {
    $('setup').hidden = false;
    $('main').hidden = true;
    $('acct').hidden = true;
    setTimeout(function () { $('username').focus(); }, 0);
  }
  function showMain() {
    $('setup').hidden = true;
    $('main').hidden = false;
    $('acct').hidden = false;
    render();
  }
  function setupError(msg) {
    var el = $('setupErr');
    el.textContent = msg;
    el.hidden = !msg;
  }

  /* The suite's bar carries the position across to the other apps — the
     analysis board, the sparring coach, the opening explorer. The game is
     over by the time it is here, so there is nothing to protect. */
  window.SuiteBoardContext = function () {
    if (!R || !R.ply) return null;
    return R.start === START_FEN ? { pgn: movetext(R.ply) } : { fen: R.fens[R.ply] };
  };

  // Lines may already know who the player is on Chess.com.
  function prefillFromLines() {
    var s = window.YourlinesSuite;
    if (!s || !s.listProfiles || $('username').value) return;
    s.listProfiles().then(function (list) {
      var p = (list || []).filter(function (x) { return x.site === 'chesscom'; })[0];
      if (p && !$('username').value) $('username').value = p.username;
    }, function () {});
  }

  function init() {
    $('guessOpt').checked = load(KEYS.guess, true);
    $('notifyOpt').checked = load(KEYS.notify, false);

    $('watchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      unlockAudio();
      startWatching($('username').value);
    });
    $('guessOpt').addEventListener('change', function () { save(KEYS.guess, this.checked); });
    $('notifyOpt').addEventListener('change', function () {
      save(KEYS.notify, this.checked);
      if (this.checked && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(function () {});
      }
    });
    $('changeBtn').addEventListener('click', function () {
      pause();
      save(KEYS.watching, false);
      showSetup();
    });
    $('pauseBtn').addEventListener('click', function () {
      if (W.running) { pause(); save(KEYS.watching, false); } else { resume(); poll(); }
    });
    $('firstBtn').addEventListener('click', function () { go(0); });
    $('prevBtn').addEventListener('click', function () { if (R) go(R.ply - 1); });
    $('nextBtn').addEventListener('click', function () { if (R) go(R.ply + 1); });
    $('lastBtn').addEventListener('click', function () { if (R) go(R.moves.length); });
    $('flipBtn').addEventListener('click', function () {
      if (!R) return;
      R.orient = R.orient === 'white' ? 'black' : 'white';
      render();
    });
    $('moves').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-ply]');
      if (b) go(+b.getAttribute('data-ply'));
    });
    $('recent').addEventListener('click', function (e) {
      var b = e.target.closest('[data-game]');
      if (!b) return;
      var id = b.getAttribute('data-game');
      var g = W.recent.filter(function (x) { return x.id === id; })[0];
      if (g) openReview(g);
    });
    $('graph').addEventListener('click', function (e) {
      if (!R || !revealed()) return;
      var rect = this.getBoundingClientRect();
      go(Math.round(((e.clientX - rect.left) / rect.width) * (R.fens.length - 1)));
    });
    document.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-act]');
      if (el && !el.disabled) onAction(el.getAttribute('data-act'), el);
    });
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', function (e) {
      if (!R || e.altKey || e.ctrlKey || e.metaKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(R.ply - 1);
      else if (e.key === 'ArrowRight') go(R.ply + 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(R.moves.length);
      else if (e.key === 'f' || e.key === 'F') $('flipBtn').click();
      else if ((e.key === 'n' || e.key === 'N') && revealed()) nextError(1);
      else return;
      e.preventDefault();
    });
    // Coming back to this tab is the moment that matters: the game has just
    // ended on Chess.com. Look straight away instead of waiting for the timer.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      document.title = TITLE;
      if (W.running && Date.now() - W.lastCheck > 2000) poll();
    });
    window.addEventListener('resize', renderGraph);
    setInterval(function () { if (W.user && !$('main').hidden) renderStatus(); }, 1000);

    var asked = params.get('user');
    var saved = load(KEYS.user, '');
    $('username').value = asked || saved || '';
    if (asked || (saved && load(KEYS.watching, false))) {
      startWatching(asked || saved);
    } else {
      showSetup();
      prefillFromLines();
    }
  }

  // For tests and for poking at from the console.
  window.__live = {
    state: function () { return { W: W, R: R, cls: cls }; },
    poll: poll,
    openReview: openReview,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
