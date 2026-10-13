/* Run with: node --test tests/tactic-badges.test.cjs */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(root, 'libs/chess.min.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'tactic-badges.js'), 'utf8'), context);

const analyze = (fen, variant = 'standard') => context.TacticBadges.analyze(fen, variant);
const badge = (result, square, kind) => (result.badges[square] || []).find(item => item.kind === kind);
const has = (result, square, kind) => Boolean(badge(result, square, kind));
const allBadges = result => Object.values(result.badges).flat();
const plain = value => JSON.parse(JSON.stringify(value));

// The supplied screenshots form a legal sequence, with Qg4 preceding ...g6.
const screenshots = (() => {
  const chess = new context.Chess('6rk/p5pp/5p2/4pN2/3pP3/3P1Q2/q5PP/1rB2R1K b - - 0 1');
  const positions = { initial: chess.fen() };
  for (const [name, move] of [
    ['afterRc8', 'Rc8'],
    ['afterQg4', 'Qg4'],
    ['afterG6', 'g6'],
    ['afterBh6', 'Bh6'],
    ['afterMate', 'Rxf1#'],
  ]) {
    assert.ok(chess.move(move), `Screenshot fixture must permit ${move}`);
    positions[name] = chess.fen();
  }
  return positions;
})();

test('screenshot: Bc1 becomes vulnerable despite its apparent rook defender', () => {
  const before = analyze(screenshots.initial);
  const after = analyze(screenshots.afterRc8);
  assert.equal(has(before, 'c1', 'undefended'), false);
  assert.ok(has(after, 'c1', 'undefended'));
  assert.equal(badge(after, 'c1', 'undefended').principalAttacker, 'b1');
  assert.ok(badge(after, 'c1', 'undefended').materialLoss > 0);
});

test('screenshot: moving the queen creates the meaningful relative pin', () => {
  assert.equal(has(analyze(screenshots.afterRc8), 'c1', 'pinned'), false);
  const pin = badge(analyze(screenshots.afterQg4), 'c1', 'pinned');
  assert.ok(pin);
  assert.equal(pin.absolute, false);
  assert.equal(pin.pinner, 'b1');
  assert.equal(pin.target, 'f1');
});

test('screenshot: a pawn threat marks Nf5 even though Qg4 defends it', () => {
  assert.equal(has(analyze(screenshots.afterQg4), 'f5', 'undefended'), false);
  const vulnerable = badge(analyze(screenshots.afterG6), 'f5', 'undefended');
  assert.ok(vulnerable);
  assert.equal(vulnerable.principalAttacker, 'g6');
  assert.ok(vulnerable.materialLoss > 0);
  assert.ok(has(analyze(screenshots.afterG6), 'c1', 'pinned'));
});

test('screenshot: Bh6 transfers both vulnerability and an absolute pin to Rf1', () => {
  const result = analyze(screenshots.afterBh6);
  assert.ok(has(result, 'f1', 'undefended'));
  const pin = badge(result, 'f1', 'pinned');
  assert.ok(pin);
  assert.equal(pin.absolute, true);
  assert.equal(pin.target, 'h1');
  assert.equal(pin.pinner, 'b1');
  assert.ok(has(result, 'h8', 'checkable'));
});

test('screenshot: Rxf1# marks actual mate and suppresses hypothetical tactics', () => {
  const result = analyze(screenshots.afterMate);
  assert.equal(result.terminal, true);
  assert.equal(result.checkedKing, 'h1');
  assert.ok(has(result, 'h1', 'mate'));
  assert.equal(allBadges(result).length, 1);
});

test('shields require an attacked piece and a material loss, including pawns', () => {
  const starting = analyze(new context.Chess().fen());
  assert.equal(allBadges(starting).filter(item => item.kind === 'undefended').length, 0);

  // Rxd4 Bxd4 trades equal rooks, so the defended rook is not vulnerable.
  const equalTrade = analyze('3r3k/8/8/8/3R4/4B3/8/K7 b - - 0 1');
  assert.equal(has(equalTrade, 'd4', 'undefended'), false);

  // ...dxe4 fxe4 still wins a knight for a pawn.
  const pawnWinsKnight = analyze('7k/8/8/3p4/4N3/5P2/8/K7 b - - 0 1');
  assert.ok(has(pawnWinsKnight, 'e4', 'undefended'));
  assert.equal(badge(pawnWinsKnight, 'e4', 'undefended').principalAttacker, 'd5');

  const pawnTarget = analyze('3r3k/8/8/8/3P4/8/8/K7 b - - 0 1');
  assert.ok(has(pawnTarget, 'd4', 'undefended'));
});

test('legal exchanges account for an absolutely pinned defender and attacker', () => {
  // Re4 geometrically defends Bd4, but moving it exposes Ke1 to Re8.
  const pinnedDefender = analyze('3rr2k/8/8/8/3BR3/8/8/4K3 b - - 0 1');
  assert.ok(has(pinnedDefender, 'd4', 'undefended'));
  assert.ok(has(pinnedDefender, 'e4', 'pinned'));

  // Be5 geometrically attacks Nd4, but Bxd4 exposes its own king to Re1.
  const pinnedAttacker = analyze('4k3/8/8/4b3/3N4/8/8/K3R3 w - - 0 1');
  assert.equal(has(pinnedAttacker, 'd4', 'undefended'), false);
  assert.ok(has(pinnedAttacker, 'e5', 'pinned'));
});

test('a pinned rook can still legally capture its pinner along the pin line', () => {
  const result = analyze('k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  assert.ok(has(result, 'e2', 'pinned'));
  assert.ok(has(result, 'e8', 'undefended'));
  assert.equal(badge(result, 'e8', 'undefended').principalAttacker, 'e2');
  // ...Rxe2 Kxe2 would be an equal exchange instead of a material loss.
  assert.equal(has(result, 'e2', 'undefended'), false);
});

test('a king is not a usable defender when the recapture square is attacked', () => {
  // Ke3 cannot recapture on d4; either black attacker protects the other.
  const result = analyze('3r3k/6b1/8/8/3R4/4K3/8/8 b - - 0 1');
  assert.ok(has(result, 'd4', 'undefended'));
  assert.equal(badge(result, 'd4', 'undefended').materialLoss, 5);
});

test('a relative pin does not mark equal-value pieces as an extra tactic', () => {
  const result = analyze('k7/8/8/8/r2B3N/8/8/7K b - - 0 1');
  assert.equal(has(result, 'd4', 'pinned'), false);
});

test('checkability considers legal checks against both kings, independent of turn', () => {
  const whiteTurn = '7k/6r1/8/8/8/8/R7/7K w - - 0 1';
  const blackTurn = whiteTurn.replace(' w ', ' b ');
  for (const fen of [whiteTurn, blackTurn]) {
    const result = analyze(fen);
    assert.ok(has(result, 'h1', 'checkable'));
    assert.ok(has(result, 'h8', 'checkable'));
    assert.equal(result.checkedKing, null);
  }
});

test('an already checked king does not also get a blue checkable badge', () => {
  const result = analyze('6k1/7r/8/8/8/8/R7/7K w - - 0 1');
  assert.equal(result.checkedKing, 'h1');
  assert.equal(result.terminal, false);
  assert.equal(has(result, 'h1', 'checkable'), false);
  assert.equal(has(result, 'h1', 'mate'), false);
});

test('an illegal check by an absolutely pinned bishop is excluded', () => {
  // Bb5 would check Ka4, but exposes Ke1 to Re8.
  const result = analyze('4r3/8/8/8/k7/8/4B3/4K3 w - - 0 1');
  assert.equal(has(result, 'a4', 'checkable'), false);
});

test('moving a blocker can create a discovered check', () => {
  const fen = 'k7/8/8/8/B7/8/8/R6K w - - 0 1';
  const check = badge(analyze(fen), 'a8', 'checkable');
  assert.ok(check);
  assert.equal(check.move.from, 'a4');
  const chess = new context.Chess(fen);
  assert.ok(chess.move(plain(check.move)));
  assert.equal(chess.in_check(), true);
});

test('en passant marks the captured pawn and respects king safety', () => {
  const fen = '7k/8/8/3pP3/8/8/8/K7 w - d6 0 1';
  const result = analyze(fen);
  const vulnerable = badge(result, 'd5', 'undefended');
  assert.ok(vulnerable);
  assert.equal(vulnerable.captureSquare, 'd6');
  assert.equal(vulnerable.principalAttacker, 'e5');
  assert.equal(has(result, 'd6', 'undefended'), false);
  assert.equal(has(analyze(fen.replace(' d6 ', ' - ')), 'd5', 'undefended'), false);

  // gxf6 e.p. would uncover Ra5 against its own king on h5.
  const illegal = analyze('7k/8/8/r4pPK/8/8/8/8 w - f6 0 1');
  assert.equal(has(illegal, 'f5', 'undefended'), false);
});

test('en passant can uncover a check by clearing two blockers', () => {
  const fen = '8/8/8/R4pPk/8/8/8/K7 w - f6 0 1';
  const check = badge(analyze(fen), 'h5', 'checkable');
  assert.ok(check);
  assert.equal(check.move.from, 'g5');
  assert.equal(check.move.to, 'f6');
  const chess = new context.Chess(fen);
  assert.ok(chess.move(plain(check.move)));
  assert.equal(chess.in_check(), true);
});

test('checking promotions include knight underpromotion', () => {
  // Only g8=N attacks Ke7; queen, rook, and bishop promotions do not.
  const knight = badge(analyze('8/4k1P1/8/8/8/8/8/K7 w - - 0 1'), 'e7', 'checkable');
  assert.ok(knight);
  assert.equal(knight.move.from, 'g7');
  assert.equal(knight.move.to, 'g8');
  assert.equal(knight.move.promotion, 'n');

  const queenOrRook = badge(analyze('7k/P7/8/8/8/8/8/7K w - - 0 1'), 'h8', 'checkable');
  assert.ok(queenOrRook);
  assert.equal(queenOrRook.move.from, 'a7');
  assert.equal(queenOrRook.move.to, 'a8');
  assert.ok(['q', 'r'].includes(queenOrRook.move.promotion));
});

test('castling can provide the only check, and the cache respects castling rights', () => {
  // Pawns prevent Ke1 from uncovering Ra1; O-O-O clears the king's file.
  const withRights = '8/8/8/8/8/8/3PPP2/R3K2k w Q - 0 1';
  const withoutRights = withRights.replace(' Q ', ' - ');
  const check = badge(analyze(withRights), 'h1', 'checkable');
  assert.ok(check);
  assert.equal(check.move.castle, true);
  assert.equal(check.move.from, 'e1');
  assert.equal(check.move.to, 'c1');
  assert.equal(has(analyze(withoutRights), 'h1', 'checkable'), false);
  assert.ok(has(analyze(withRights), 'h1', 'checkable'));
});

test('Chess960 supports file rights and X-FEN with displaced king and rook', () => {
  const fileRights = '8/8/8/8/8/8/4PPP1/1R3K1k w B - 0 1';
  for (const fen of [fileRights, fileRights.replace(' B ', ' Q ')]) {
    const check = badge(analyze(fen, 'chess960'), 'h1', 'checkable');
    assert.ok(check);
    assert.equal(check.move.castle, true);
    assert.equal(check.move.from, 'f1');
    assert.equal(check.move.to, 'c1');
    assert.equal(check.move.rookFrom, 'b1');
    assert.equal(check.move.rookTo, 'd1');
  }
  assert.equal(has(analyze(fileRights, 'standard'), 'h1', 'checkable'), false);
  assert.ok(has(analyze(fileRights, 'chess960'), 'h1', 'checkable'));
});

test('checkmate and stalemate are terminal with different king badges', () => {
  const mate = analyze('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');
  assert.equal(mate.terminal, true);
  assert.equal(mate.checkedKing, 'h8');
  assert.ok(has(mate, 'h8', 'mate'));
  assert.equal(has(mate, 'h8', 'checkable'), false);

  const stalemate = analyze('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1');
  assert.equal(stalemate.terminal, true);
  assert.equal(stalemate.checkedKing, null);
  assert.equal(allBadges(stalemate).length, 0);
});

test('the cache preserves side-to-move and en passant distinctions', () => {
  const ep = '7k/8/8/3pP3/8/8/8/K7 w - d6 0 1';
  const noEp = ep.replace(' d6 ', ' - ');
  assert.ok(has(analyze(ep), 'd5', 'undefended'));
  assert.equal(has(analyze(noEp), 'd5', 'undefended'), false);
  assert.ok(has(analyze(ep), 'd5', 'undefended'));

  // The same diagram is stalemate only when Black is to move.
  const black = '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1';
  const white = black.replace(' b ', ' w ');
  assert.equal(analyze(black).terminal, true);
  assert.equal(analyze(white).terminal, false);
  assert.equal(analyze(black).terminal, true);
});

test('invalid positions and unsupported variants return a safe empty result', () => {
  for (const fen of ['', 'not a FEN', null, '8/8/8/8/8/8/8/8 w - - 0 1',
    '4k3/8/8/8/8/8/8/4KK2 w - - 0 1']) {
    assert.deepEqual(plain(analyze(fen)), { badges: {}, checkedKing: null, terminal: false });
  }
  for (const variant of ['atomic', 'crazyhouse', 'antichess']) {
    assert.deepEqual(plain(analyze(screenshots.initial, variant)), { badges: {}, checkedKing: null, terminal: false });
  }
});

test('position analysis leaves the application Chess instance and history untouched', () => {
  const activeGame = new context.Chess();
  for (const move of ['e4', 'e5', 'Nf3']) assert.ok(activeGame.move(move));
  context.game = activeGame;
  context.chess = activeGame;
  const before = { fen: activeGame.fen(), history: plain(activeGame.history({ verbose: true })) };
  for (const fen of Object.values(screenshots)) analyze(fen);
  analyze('8/8/8/R4pPk/8/8/8/K7 w - f6 0 1');
  assert.equal(activeGame.fen(), before.fen);
  assert.deepEqual(plain(activeGame.history({ verbose: true })), before.history);
});
