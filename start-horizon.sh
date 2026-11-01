#!/bin/sh
# Starts Horizon on this computer and opens it in your browser (macOS and Linux).
# Run: ./start-horizon.sh   Keep the terminal open while you use Horizon; Ctrl+C stops it.
cd "$(dirname "$0")" || exit 1
URL="http://localhost:8765/"

if command -v node >/dev/null 2>&1; then
  exec node scripts/serve.mjs --open
fi

# No Node.js: use Python's built-in web server on the same address.
if command -v python3 >/dev/null 2>&1; then
  echo "Horizon is running at $URL (Ctrl+C to stop)"
  ( sleep 1; (command -v open >/dev/null && open "$URL") || xdg-open "$URL" ) >/dev/null 2>&1 &
  exec python3 -m http.server 8765 --bind 127.0.0.1
fi

echo "Node.js and Python were not found, so Horizon opens straight from the folder."
(command -v open >/dev/null && open index.html) || xdg-open index.html
