'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const feed = app.slice(app.indexOf('function fenPly('), app.indexOf('function castleFix('));
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const e4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const e5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const nf3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

function watchedGame() {
  const game = { base: null, plies: [], version: 0 };
  const context = vm.createContext({
    state: { game, view: null }, study: null, performance,
    toSan: (_fen, uci) => uci,
    playMoveSound() {},
    leaveStudy() { context.study = null; },
  });
  vm.runInContext(feed, context);
  context.addPosition(game, { fen: start });
  return { context, game };
}

test('a new watched move discards study and returns from a historical ply to live', () => {
  const { context, game } = watchedGame();
  context.addPosition(game, { fen: e4, lm: 'e2e4' });
  context.state.view = 0;
  context.study = { cursor: 1 };

  context.addPosition(game, { fen: e5, lm: 'e7e5' });

  assert.equal(context.study, null);
  assert.equal(context.state.view, null);
  assert.equal(game.plies.at(-1).fen, e5);
});

test('study survives delayed feed entries and duplicate moves', () => {
  const { context, game } = watchedGame();
  context.addPosition(game, { fen: e5 });
  const study = { cursor: 1 };
  context.study = study;

  context.addPosition(game, { fen: e4, lm: 'e2e4' });
  context.addPosition(game, { fen: e5, lm: 'e7e5' });
  assert.equal(context.study, study);

  context.addPosition(game, { fen: nf3, lm: 'g1f3' });
  assert.equal(context.study, null);
});

test('watching a historical ply without a study line keeps the selected ply', () => {
  const { context, game } = watchedGame();
  context.state.view = 0;

  context.addPosition(game, { fen: e4, lm: 'e2e4' });

  assert.equal(context.state.view, 0);
});
