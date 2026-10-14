/* Run with: node --test tests/*.test.cjs */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// Load the actual rules-based tactics without the application's DOM/stream wiring.
function analysis() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(root, 'libs/chess.min.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'tactic-badges.js'), 'utf8'), context);
  vm.runInContext(`
    const FILES = 'abcdefgh';
    const VALUE = {p:1,n:3,b:3,r:5,q:9,k:0};
    const chess = new Chess();
    const state = {analysis:false,game:null,opts:{
      tMate:true,tFork:true,tPin:true,tSkewer:true,tDiscovered:true,
      tPressure:true,tRemoval:true,tQueen:true,tCapture:false
    }};
  `, context);
  vm.runInContext(app.slice(app.indexOf('function castleFix('), app.indexOf('function toSan(')), context);
  vm.runInContext(app.slice(app.indexOf('function fenGrid('), app.indexOf('function findCheckedKing(')), context);
  vm.runInContext(app.slice(app.indexOf('// The same position with the other side to move'), app.indexOf('function fmtEval(')), context);
  return context;
}

const SCREENSHOT = '6k1/2p2ppp/p1p5/3p4/3P3q/2PbK3/PP1N4/4R3 b - - 0 1';
const FORK = '7r/p1k2pbp/4ppb1/3p4/3q2P1/2N2Q1P/P1P2P2/5RK1 w - - 0 1';
const INDIRECT_SKEWER = '8/8/6kq/8/8/8/1K6/R7 w - - 0 1';

test('direct Qxe1+ makes Qe7+ redundant; the screenshot needs badges only', () => {
  const ctx = analysis();
  const moves = ctx.tacticMoves(SCREENSHOT);
  const skewer = moves.find(m => m.from + m.to === 'h4e7');
  assert.ok(skewer.extra.skewer);
  assert.deepEqual(Array.from(skewer.extra.skewer.targets), ['e1']);
  const verdict = ctx.forcedWins(SCREENSHOT);
  assert.ok(verdict.gainOf('h4e1') >= verdict.gainOf('h4e7'));
  assert.equal(ctx.tactics(SCREENSHOT).length, 0);
  const badges = ctx.TacticBadges.analyze(SCREENSHOT).badges;
  assert.ok(badges.e1.some(b => b.kind === 'undefended'));
  assert.ok(badges.d3.some(b => b.kind === 'undefended'));
  assert.ok(badges.e3.some(b => b.kind === 'checkable'));
});

test('optional generic captures do not reintroduce the already-badged winning capture', () => {
  const ctx = analysis();
  vm.runInContext('state.opts.tCapture = true', ctx);
  assert.equal(ctx.tactics(SCREENSHOT).length, 0);
});

test('the same redundant skewer is omitted when explaining the last played move', () => {
  const ctx = analysis();
  const local = new ctx.Chess(SCREENSHOT);
  assert.ok(local.move('Qe7+'));
  ctx.fixture = {plies:[{fen:SCREENSHOT},{fen:local.fen(),lm:'h4e7'}]};
  vm.runInContext('state.game = fixture', ctx);
  assert.equal(ctx.lastMoveTactic(1), null);
});

test('Nb5+ still explains a genuine king-queen fork before and after the move', () => {
  const ctx = analysis();
  const fork = ctx.tactics(FORK).find(t => t.from + t.to === 'c3b5');
  assert.equal(fork?.kind, 'fork');
  assert.ok(fork.lines.some(line => line.from === 'b5' && line.to === 'c7'));
  assert.ok(fork.lines.some(line => line.from === 'b5' && line.to === 'd4'));
  const local = new ctx.Chess(FORK);
  assert.ok(local.move('Nb5+'));
  ctx.fixture = {plies:[{fen:FORK},{fen:local.fen(),lm:'c3b5'}]};
  vm.runInContext('state.game = fixture', ctx);
  assert.equal(ctx.lastMoveTactic(1)?.kind, 'fork');
});

test('a skewer remains when its queen target cannot already be captured directly', () => {
  const ctx = analysis();
  const moves = ctx.tacticMoves(INDIRECT_SKEWER);
  assert.equal(moves.some(m => m.to === 'h6' && m.extra.capture), false);
  const ideas = ctx.tactics(INDIRECT_SKEWER);
  assert.ok(ideas.some(t => t.kind === 'skewer' && t.lines.some(line => line.to === 'h6')));
});

test('mate suggestions are retained', () => {
  const ctx = analysis();
  const mates = ctx.tactics('7k/5K2/6Q1/8/8/8/8/8 w - - 0 1');
  assert.ok(mates.length > 0);
  assert.ok(mates.every(t => t.kind === 'mate'));
});

test('a local exchange gain alone cannot prove a direct capture dominates a combination', () => {
  const ctx = analysis();
  const moves = ctx.tacticMoves(SCREENSHOT);
  const skewer = moves.find(m => m.from + m.to === 'h4e7').extra.skewer;
  const unchecked = ctx.directCaptureGains(moves, {gainOf:()=>undefined});
  const refuted = ctx.directCaptureGains(moves, {gainOf:()=>null});
  assert.equal(ctx.redundantTactic(skewer, 2, unchecked), false);
  assert.equal(ctx.redundantTactic(skewer, 2, refuted), false);
});
