#!/usr/bin/env bash
# WatchMeLiveReview: start the WatchMePlayChess server (records your chess.com games) and Live Review
# (reviews them live), then open Live Review and chess.com in the browser.
#
#   ./watchmelivereview.sh [port]      Live Review port, 8000 by default (WatchMePlayChess always uses 3000)
#
# WatchMePlayChess is looked for next to this folder (../watchmeplaychess); set WATCHMEPLAY_DIR to use
# another folder. Set WMLR_NO_BROWSER=1 to start the servers without opening any tabs.
# In Live Review, use "Watch folder..." on <watchmeplaychess>/data/games to follow the game you're playing.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
WMP_DIR="${WATCHMEPLAY_DIR:-../watchmeplaychess}"
if [ ! -f "$WMP_DIR/server.js" ]; then
  echo "WatchMePlayChess not found in $WMP_DIR"
  echo "Set WATCHMEPLAY_DIR to its folder and run this again."
  exit 1
fi
WMP_DIR=$(cd "$WMP_DIR" && pwd -P)

# Stop previous instances: any "node server.js" started from the WatchMePlayChess folder, anything
# else still holding port 3000, and an earlier Live Review (a python http.server) on our port.
stop_watchmeplay() {
  for pid in $(pgrep -f "^node server.js"); do
    if [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$WMP_DIR" ]; then
      echo "Stopping WatchMePlayChess server (pid $pid)..."
      kill "$pid"
    fi
  done
}
listening_on() {
  ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}
stop_watchmeplay
for pid in $(listening_on 3000); do
  echo "Stopping process on port 3000 (pid $pid)..."
  kill "$pid"
done
for pid in $(listening_on "$PORT"); do
  if ps -o args= -p "$pid" | grep -q "http.server"; then
    echo "Stopping previous Live Review (pid $pid)..."
    kill "$pid"
  fi
done
sleep 1

# WatchMePlayChess in the background; it's stopped again when this script ends.
(
  cd "$WMP_DIR" || exit 1
  [ -d node_modules ] || npm install
  exec npm start
) &
WMP_PID=$!
cleanup() {
  pkill -P "$WMP_PID" 2>/dev/null
  kill "$WMP_PID" 2>/dev/null
  stop_watchmeplay
}
trap cleanup EXIT
trap 'exit 130' INT TERM

URL="http://localhost:$PORT"
open_url() { xdg-open "$1" >/dev/null 2>&1 || open "$1" >/dev/null 2>&1; }
if [ -z "$WMLR_NO_BROWSER" ]; then
  (sleep 2; open_url "$URL"; open_url "https://www.chess.com/play/online") &
fi

echo "WatchMePlayChess server: http://localhost:3000 (games saved in $WMP_DIR/data/games)"
echo "Live Review:             $URL"
echo "Ctrl+C stops both."
if command -v python3 >/dev/null; then
  python3 -m http.server "$PORT"
else
  python -m http.server "$PORT"
fi
