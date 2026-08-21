#!/bin/bash
# Copies just the runtime web assets (the same files GitHub Pages serves from
# the repo root) into www/, which is what capacitor.config.json points at as
# webDir. Keeps native builds from bundling node_modules, .git, ios/, android/,
# and assorted dev-only SQL/CSV/zip files that live at the repo root.
#
# Run this before `npx cap sync` any time the web app's files change.
set -e
cd "$(dirname "$0")/.."

rm -rf www
mkdir -p www

cp index.html www/
cp sw.js www/
cp site.webmanifest www/
cp favicon.ico www/
cp favicon.svg www/
cp favicon-96x96.png www/
cp apple-touch-icon.png www/
cp web-app-manifest-192x192.png www/
cp web-app-manifest-512x512.png www/
cp randy-default-transparent.png www/
cp randy-happy-transparent.png www/
cp randy-sad-transparent.png www/
cp randy-thinking-transparent.png www/
cp randy-icon-master-1024.png www/

cp -R icons www/icons
cp -R story-icons www/story-icons
cp -R badges www/badges

echo "Synced web assets into www/"
