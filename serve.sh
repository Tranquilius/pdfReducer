#!/bin/sh
# Serve the app locally. It must be served over http:// (not opened as a file://
# URL) because pdf.js loads its worker as a module.
PORT="${1:-8080}"
echo "PDF Reducer → http://localhost:$PORT"
exec python3 -m http.server "$PORT" --directory "$(dirname "$0")"
