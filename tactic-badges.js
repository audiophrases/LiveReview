/* Position-only tactical badges. No engine, DOM, or shared game state is used. */
(function (root) {
  'use strict';

  const FILES = 'abcdefgh';
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
  const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const RAYS = ORTHOGONAL.concat(DIAGONAL);
  const KNIGHTS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const CACHE_LIMIT = 192;
  const cache = new Map();
  const opposite = color => color === 'w' ? 'b' : 'w';
  const role = piece => piece.toLowerCase();
  const colorOf = piece => piece === piece.toUpperCase() ? 'w' : 'b';
  const squareName = square => FILES[square & 7] + ((square >> 3) + 1);
  const pieceFor = (type, color) => color === 'w' ? type.toUpperCase() : type;
  const squareAt = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : -1;
  const squareIndex = square => /^[a-h][1-8]$/.test(square) ? FILES.indexOf(square[0]) + (Number(square[1]) - 1) * 8 : -1;

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  const EMPTY = freeze({ badges: {}, checkedKing: null, terminal: false });

  function parseFen(fen, variant = 'standard') {
    if (typeof fen !== 'string') return null;
    const fields = fen.trim().split(/\s+/);
    if (fields.length < 4 || !/^[wb]$/.test(fields[1])) return null;
    if (!/^(?:-|[KQkqA-Ha-h]+)$/.test(fields[2])) return null;
    if (fields[3] !== '-' && !/^[a-h][36]$/.test(fields[3])) return null;
    const ranks = fields[0].split('/');
    if (ranks.length !== 8) return null;
    const board = Array(64).fill(null);
    const kings = { w: -1, b: -1 };
    let pieces = 0;
    for (let rank = 0; rank < 8; rank++) {
      let file = 0;
      for (const token of ranks[7 - rank]) {
        if (/^[1-8]$/.test(token)) file += Number(token);
        else {
          if (!/^[pnbrqkPNBRQK]$/.test(token) || file >= 8) return null;
          const square = rank * 8 + file++;
          board[square] = token;
          pieces++;
          if (role(token) === 'p' && (rank === 0 || rank === 7)) return null;
          if (role(token) === 'k') {
            const color = colorOf(token);
            if (kings[color] !== -1) return null;
            kings[color] = square;
          }
        }
        if (file > 8) return null;
      }
      if (file !== 8) return null;
    }
    if (kings.w === -1 || kings.b === -1 || pieces > 32) return null;
    // The player who just moved cannot have left their king in check.
    if (isAttacked(board, kings[opposite(fields[1])], fields[1])) return null;
    let ep = fields[3] === '-' ? -1 : squareIndex(fields[3]);
    if (ep !== -1) {
      const step = fields[1] === 'w' ? 8 : -8;
      if ((ep >> 3) !== (fields[1] === 'w' ? 5 : 2) || board[ep] || board[ep + step] ||
          board[ep - step] !== pieceFor('p', opposite(fields[1]))) ep = -1;
    }
    return { board, kings, turn: fields[1], rights: fields[2], ep, variant };
  }

  // Geometric attacks are deliberately used for king safety: even an absolutely
  // pinned enemy piece still controls the squares onto which a king may move.
  function attackers(board, target, color) {
    const result = [];
    const file = target & 7, rank = target >> 3;
    const pawnRank = rank + (color === 'w' ? -1 : 1);
    for (const offset of [-1, 1]) {
      const from = squareAt(file + offset, pawnRank);
      if (from !== -1 && board[from] === pieceFor('p', color)) result.push(from);
    }
    for (const [df, dr] of KNIGHTS) {
      const from = squareAt(file + df, rank + dr);
      if (from !== -1 && board[from] === pieceFor('n', color)) result.push(from);
    }
    for (let i = 0; i < RAYS.length; i++) {
      const [df, dr] = RAYS[i];
      let distance = 1;
      for (let f = file + df, r = rank + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
        const from = r * 8 + f, piece = board[from];
        if (piece) {
          if (colorOf(piece) === color) {
            const type = role(piece);
            if (type === 'q' || type === (i < 4 ? 'r' : 'b') || (type === 'k' && distance === 1)) result.push(from);
          }
          break;
        }
        distance++;
      }
    }
    return result;
  }

  function isAttacked(board, target, color) {
    return attackers(board, target, color).length !== 0;
  }

  function kingSquare(board, color) {
    return board.indexOf(pieceFor('k', color));
  }

  function kingSafe(board, color) {
    const king = kingSquare(board, color);
    return king !== -1 && !isAttacked(board, king, opposite(color));
  }

  function applyMove(board, move) {
    const next = board.slice();
    const piece = next[move.from];
    next[move.from] = null;
    if (move.epCapture !== undefined) next[move.epCapture] = null;
    if (move.rookFrom !== undefined) {
      // In Chess960, origins and destinations may overlap or the king may stay put.
      const rook = next[move.rookFrom];
      next[move.rookFrom] = null;
      next[move.rookTo] = rook;
    }
    next[move.to] = move.promotion ? pieceFor(move.promotion, colorOf(piece)) : piece;
    return next;
  }

  function publicMove(move) {
    const result = { from: squareName(move.from), to: squareName(move.to) };
    if (move.promotion) result.promotion = move.promotion;
    if (move.rookFrom !== undefined) {
      result.castle = true;
      result.rookFrom = squareName(move.rookFrom);
      result.rookTo = squareName(move.rookTo);
    }
    if (move.epCapture !== undefined) result.enPassant = true;
    return result;
  }

  function moveDescription(move) {
    if (move.rookFrom !== undefined) return (move.to & 7) === 6 ? 'O-O' : 'O-O-O';
    return squareName(move.from) + '–' + squareName(move.to) + (move.promotion ? '=' + move.promotion.toUpperCase() : '');
  }

  function castlingMoves(position, color) {
    const board = position.board;
    const king = kingSquare(board, color);
    const rank = color === 'w' ? 0 : 7;
    if ((king >> 3) !== rank || !kingSafe(board, color)) return [];
    if (position.variant !== 'chess960' && king !== rank * 8 + 4) return [];
    const rookSquares = [];
    for (const right of position.rights) {
      if (right === '-' || (right === right.toUpperCase() ? 'w' : 'b') !== color) continue;
      const upper = right.toUpperCase();
      if (upper === 'K' || upper === 'Q') {
        if (position.variant !== 'chess960') {
          const square = rank * 8 + (upper === 'K' ? 7 : 0);
          if (board[square] === pieceFor('r', color)) rookSquares.push(square);
          continue;
        }
        // X-FEN K/Q identify the outermost rook on the appropriate king side.
        const candidates = [];
        for (let file = 0; file < 8; file++) {
          const sq = rank * 8 + file;
          if (board[sq] === pieceFor('r', color) && (upper === 'K' ? sq > king : sq < king)) candidates.push(sq);
        }
        if (candidates.length) rookSquares.push(upper === 'K' ? candidates[candidates.length - 1] : candidates[0]);
      } else if (position.variant === 'chess960') {
        const sq = rank * 8 + FILES.indexOf(right.toLowerCase());
        if (board[sq] === pieceFor('r', color)) rookSquares.push(sq);
      }
    }
    const result = [];
    for (const rookFrom of new Set(rookSquares)) {
      if (rookFrom === king) continue;
      const kingTo = rank * 8 + (rookFrom > king ? 6 : 2);
      const rookTo = rank * 8 + (rookFrom > king ? 5 : 3);
      const walk = (from, to) => {
        const squares = [from];
        if (from !== to) for (let sq = from + Math.sign(to - from); ; sq += Math.sign(to - from)) {
          squares.push(sq);
          if (sq === to) break;
        }
        return squares;
      };
      if (walk(king, kingTo).concat(walk(rookFrom, rookTo)).some(sq => sq !== king && sq !== rookFrom && board[sq])) continue;
      const transitBoard = board.slice();
      transitBoard[king] = null;
      if (walk(king, kingTo).slice(1, -1).some(sq => isAttacked(transitBoard, sq, opposite(color)))) continue;
      const move = { from: king, to: kingTo, rookFrom, rookTo };
      if (kingSafe(applyMove(board, move), color)) result.push(move);
    }
    return result;
  }

  // visit() may stop generation early; terminal and checkable checks usually
  // need just one move. Simulations never modify the caller's board.
  function visitLegalMoves(position, color, visit) {
    const board = position.board;
    const accept = move => {
      const next = applyMove(board, move);
      return kingSafe(next, color) && visit(move, next);
    };
    const add = (from, to, extra) => {
      const piece = board[from], victim = board[to];
      if (victim && (colorOf(victim) === color || role(victim) === 'k')) return false;
      if (role(piece) === 'p' && ((to >> 3) === 0 || (to >> 3) === 7)) {
        for (const promotion of ['q', 'n', 'r', 'b']) {
          if (accept(Object.assign({ from, to, promotion }, extra))) return true;
        }
        return false;
      }
      return accept(Object.assign({ from, to }, extra));
    };
    for (let from = 0; from < 64; from++) {
      const piece = board[from];
      if (!piece || colorOf(piece) !== color) continue;
      const type = role(piece), file = from & 7, rank = from >> 3;
      if (type === 'p') {
        const step = color === 'w' ? 8 : -8;
        const to = from + step;
        if (to >= 0 && to < 64 && !board[to]) {
          if (add(from, to)) return true;
          if (rank === (color === 'w' ? 1 : 6) && !board[to + step] && add(from, to + step)) return true;
        }
        for (const df of [-1, 1]) {
          const to = squareAt(file + df, rank + (color === 'w' ? 1 : -1));
          if (to === -1) continue;
          if (board[to] && add(from, to)) return true;
          if (color === position.turn && to === position.ep && !board[to] &&
              board[to - step] === pieceFor('p', opposite(color)) && add(from, to, { epCapture: to - step })) return true;
        }
      } else if (type === 'n') {
        for (const [df, dr] of KNIGHTS) {
          const to = squareAt(file + df, rank + dr);
          if (to !== -1 && add(from, to)) return true;
        }
      } else {
        const directions = type === 'b' ? DIAGONAL : type === 'r' ? ORTHOGONAL : RAYS;
        for (const [df, dr] of directions) {
          for (let f = file + df, r = rank + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
            const to = r * 8 + f;
            if (add(from, to)) return true;
            if (board[to] || type === 'k') break;
          }
        }
      }
    }
    for (const move of castlingMoves(position, color)) {
      if (accept(move)) return true;
    }
    return false;
  }

  function detectPins(board) {
    const result = [];
    for (let pinner = 0; pinner < 64; pinner++) {
      const piece = board[pinner];
      if (!piece || !'brq'.includes(role(piece))) continue;
      const color = colorOf(piece), type = role(piece);
      const directions = type === 'b' ? DIAGONAL : type === 'r' ? ORTHOGONAL : RAYS;
      for (const [df, dr] of directions) {
        let pinned = -1;
        for (let file = (pinner & 7) + df, rank = (pinner >> 3) + dr; file >= 0 && file < 8 && rank >= 0 && rank < 8; file += df, rank += dr) {
          const target = rank * 8 + file, victim = board[target];
          if (!victim) continue;
          if (colorOf(victim) === color) break;
          if (pinned === -1) {
            if (role(victim) === 'k') break;
            pinned = target;
            continue;
          }
          const absolute = role(victim) === 'k';
          if (absolute || (VALUE[role(victim)] > VALUE[role(board[pinned])] &&
              (!isAttacked(board, target, opposite(color)) || VALUE[role(victim)] > VALUE[type]))) {
            result.push({ pinned, pinner, target, absolute });
          }
          break;
        }
      }
    }
    return result;
  }

  // Static exchange evaluation follows the two least valuable usable attackers.
  // Each side may stop exchanging. Captures reveal x-rays, and every resulting
  // board is checked for absolute pins and legal king recaptures.
  function exchange(board, target, memo, budget) {
    const victim = board[target];
    if (!victim || role(victim) === 'k') return { balance: 0 };
    if (++budget.nodes > 4096) return { balance: 0 };
    const key = board.map(piece => piece || '.').join('') + ':' + target;
    if (memo.has(key)) return memo.get(key);
    const color = opposite(colorOf(victim));
    const choices = [];
    for (const from of attackers(board, target, color)) {
      const type = role(board[from]);
      const promotions = type === 'p' && ((target >> 3) === 0 || (target >> 3) === 7) ? ['q', 'n', 'r', 'b'] : [null];
      const moves = [];
      for (const promotion of promotions) {
        const move = { from, to: target };
        if (promotion) move.promotion = promotion;
        const next = applyMove(board, move);
        if (kingSafe(next, color)) moves.push({ move, next, promotionGain: promotion ? VALUE[promotion] - VALUE.p : 0 });
      }
      if (moves.length) choices.push({ from, value: VALUE[type], moves });
    }
    choices.sort((a, b) => a.value - b.value || a.from - b.from);
    let best = { balance: 0 };
    for (const choice of choices.slice(0, 2)) {
      for (const candidate of choice.moves) {
        const balance = VALUE[role(victim)] + candidate.promotionGain - exchange(candidate.next, target, memo, budget).balance;
        if (balance > best.balance) best = { balance, firstAttacker: choice.from, move: candidate.move };
      }
    }
    memo.set(key, best);
    return best;
  }

  function analyzePosition(position) {
    const board = position.board;
    const badges = {};
    const add = (square, badge) => (badges[squareName(square)] || (badges[squareName(square)] = [])).push(badge);
    const checked = isAttacked(board, position.kings[position.turn], opposite(position.turn));
    const checkedKing = checked ? squareName(position.kings[position.turn]) : null;
    const terminal = !visitLegalMoves(position, position.turn, () => true);
    if (terminal) {
      if (checked) add(position.kings[position.turn], { kind: 'mate', title: 'Checkmate', lines: [] });
      return { badges, checkedKing, terminal };
    }

    const shieldFor = (square, result, captureSquare) => {
      if (result.balance <= 0 || result.firstAttacker === undefined) return;
      const existing = badges[squareName(square)]?.find(badge => badge.kind === 'undefended');
      if (existing && existing.materialLoss >= result.balance) return;
      if (existing) badges[squareName(square)].splice(badges[squareName(square)].indexOf(existing), 1);
      const victim = board[square];
      const badge = {
        kind: 'undefended',
        title: 'Vulnerable ' + NAME[role(victim)] + ': ' + moveDescription(result.move) +
          ' can win ' + result.balance + ' ' + (result.balance === 1 ? 'point' : 'points') + ' of material in the exchange',
        lines: [{ from: squareName(result.firstAttacker), to: squareName(captureSquare === undefined ? square : captureSquare) }],
        materialLoss: result.balance,
        principalAttacker: squareName(result.firstAttacker),
        move: publicMove(result.move),
      };
      if (captureSquare !== undefined) {
        badge.captureSquare = squareName(captureSquare);
        badge.title += ' (en passant)';
      }
      add(square, badge);
    };

    for (let square = 0; square < 64; square++) {
      const victim = board[square];
      if (!victim || role(victim) === 'k' || !isAttacked(board, square, opposite(colorOf(victim)))) continue;
      shieldFor(square, exchange(board, square, new Map(), { nodes: 0 }));
    }
    if (position.ep !== -1) {
      const step = position.turn === 'w' ? 8 : -8;
      const victimSquare = position.ep - step;
      let best = { balance: 0 };
      for (const from of attackers(board, position.ep, position.turn)) {
        if (role(board[from]) !== 'p') continue;
        const move = { from, to: position.ep, epCapture: victimSquare };
        const next = applyMove(board, move);
        if (!kingSafe(next, position.turn)) continue;
        const balance = VALUE.p - exchange(next, position.ep, new Map(), { nodes: 0 }).balance;
        if (balance > best.balance) best = { balance, firstAttacker: from, move };
      }
      shieldFor(victimSquare, best, position.ep);
    }

    for (const pin of detectPins(board)) {
      add(pin.pinned, {
        kind: 'pinned',
        title: (pin.absolute ? 'Pinned to the king' : 'Pinned to the ' + NAME[role(board[pin.target])]) +
          ' on ' + squareName(pin.target) + ' by the ' + NAME[role(board[pin.pinner])] + ' on ' + squareName(pin.pinner),
        lines: [{ from: squareName(pin.pinner), to: squareName(pin.target) }],
        pinner: squareName(pin.pinner), target: squareName(pin.target), absolute: pin.absolute,
      });
    }

    for (const color of ['w', 'b']) {
      const king = position.kings[color], opponent = opposite(color);
      if (isAttacked(board, king, opponent)) continue;
      visitLegalMoves(position, opponent, (move, next) => {
        if (!isAttacked(next, kingSquare(next, color), opponent)) return false;
        const checkingColor = opponent === 'w' ? 'White' : 'Black';
        const lines = move.from === move.to ? [] : [{ from: squareName(move.from), to: squareName(move.to) }];
        if (move.rookFrom !== undefined && move.rookFrom !== move.rookTo) {
          lines.push({ from: squareName(move.rookFrom), to: squareName(move.rookTo) });
        }
        add(king, {
          kind: 'checkable',
          title: checkingColor + ' can give check if it were ' + checkingColor + '’s turn: ' + moveDescription(move),
          lines,
          move: publicMove(move),
        });
        return true;
      });
    }
    return { badges, checkedKing, terminal };
  }

  function analyze(fen, variant = 'standard') {
    if (!['standard', 'fromPosition', 'chess960'].includes(variant) || typeof fen !== 'string') return EMPTY;
    const key = variant + '\n' + fen;
    if (cache.has(key)) {
      const result = cache.get(key);
      cache.delete(key);
      cache.set(key, result);
      return result;
    }
    const position = parseFen(fen, variant);
    const result = position ? freeze(analyzePosition(position)) : EMPTY;
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return result;
  }

  const api = Object.freeze({ analyze });
  root.TacticBadges = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
