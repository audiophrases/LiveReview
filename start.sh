#!/usr/bin/env bash
# Serve Live Watch on http://localhost:8000 and open it in the browser.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
URL="http://localhost:$PORT"
(sleep 1; xdg-open "$URL" >/dev/null 2>&1 || open "$URL" >/dev/null 2>&1) &
echo "Serving $URL (Ctrl+C to stop)"
if command -v python3 >/dev/null; then
  exec python3 -m http.server "$PORT"
else
  exec python -m http.server "$PORT"
fi
