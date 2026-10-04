# Live Review

Follows a Chess.com player and opens a full review of each game **the moment
it ends**: the board, an advantage bar, a verdict on every move, and the
engine's top three moves from each position a move was played in. You learn
from a mistake best while you still remember what you were thinking.

Part of the [yourlines chess suite](https://github.com/audiophrases/yourlines),
served at `/live/`. `deploy.bat` commits this repo, syncs it into the suite
and publishes it.

## How it works

- **Watching** polls the player's current month on the Chess.com public API
  (`/pub/player/<user>/games/YYYY/MM`) every 10 s, and straight away when you
  come back to the tab. A game that wasn't there before has just ended, so it
  opens with a chime, and a notification too if you allowed one.
- **Guess first** (on by default, can be turned off): before any verdict
  shows, you step through the game and point at the move you regret most. The
  engine works through the game meanwhile, then tells you whether your
  instinct was right. Recent games keeps a running score.
- **The review** is Stockfish 16 (single-threaded WASM) at depth 12 with three
  lines per position. Verdicts use Lichess's thresholds on the mover's winning
  chances (10 / 20 / 30 points lost: inaccuracy / mistake / blunder), and
  accuracy uses Lichess's curve. Time spent on each move comes from the PGN's
  clock comments.
- **In the suite** the bar carries the position on screen to Play, Spar,
  Lines and Gym, and *Deeper review* hands the whole game to the Reviewer.

URL options: `?user=<name>` starts watching straight away, `?depth=`,
`?lines=` (1–5), `?poll=` (seconds).

## Fair play

It reads only finished games. Chess.com doesn't publish a live game to
outside apps until it is over, and showing engine output during your own
game breaks Chess.com's Fair Play rules. That includes an advantage bar, a
"that was a mistake" verdict, or the best alternatives to the move you just
played: each tells you something about the position you are about to move in.
