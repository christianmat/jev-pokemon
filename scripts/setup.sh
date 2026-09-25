#!/usr/bin/env bash
# One-time setup: builds the pret/pokered disassembly to get exact RAM/ROM symbols.
set -euo pipefail
command -v rgbasm >/dev/null || brew install rgbds
[ -d vendor/pokered ] || git clone --depth 1 https://github.com/pret/pokered.git vendor/pokered
make -C vendor/pokered -j8 red
npx tsx scripts/gen-data.ts
[ -f roms/red.gb ] || echo "Put your own Pokémon Red (UE) ROM at roms/red.gb (sha1 ea9bcae617fdf159b045185467ae58b2e4a48b9a)"
