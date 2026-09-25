# Jev Plays Pokémon Red

[Jev](https://en.wikipedia.org/wiki/Jev_(AI_model)), TypeSafe AI's decision model, plays Pokémon Red. There are no scripts or cheats: the harness reads the game's memory, lists the legal options with some facts about each, and Jev picks one. The game streams live to YouTube, with a panel showing every decision and Jev's probabilities.

- **Live stream:** https://www.youtube.com/watch?v=4kaC4ZHhw_Q
- **Landing page:** [`site/`](site/)

> You need your own legally obtained copy of Pokémon Red. No ROM is included or distributed here. See [Legal](#legal).

## How it works

```
 Game Boy emulator (Node) ──► read RAM ──► game state (map, party, battle, on-screen text)
          ▲                                          │
          │ button presses                           ▼
   harness mechanics ◄── Jev picks one ◄── legal options + facts
   (A* pathfinding, menus)                (type matchups, damage estimates,
                                           "2 areas toward the objective", ...)
```

- **Jev decides:**
  - every menu answer (names, starter, YES/NO, shop, heal, learn/forget moves)
  - what to focus on (progress, heal, train, catch, shop, explore)
  - where to go and who to talk to
  - every battle action (move, switch, item, ball, run)
- **The harness never decides:**
  - It only reads memory and presses buttons. It never writes to game memory.
  - Game knowledge is limited to the story milestones (what the next goal is and where it happens) in [`src/knowledge/milestones.ts`](src/knowledge/milestones.ts). Progress is checked against the game's real event flags.
  - Hidden items aren't shown to Jev, since a human wouldn't know where they are.
- **House rules:**
  - Text speed FAST and battle animations OFF, set once in the Options menu at boot.
  - The player is named JEV and the rival BLUE. Pokémon are never nicknamed.
- **Loop protection:**
  - Options that were already tried without anything changing get tagged, and Jev is told to try something new.
  - If the same failing choice keeps coming back, the harness samples an alternative.
  - As a last resort, it reloads the latest milestone checkpoint.

## Setup

Requirements: macOS or Linux, Node 20+, git, and `ffmpeg` if you want to stream.

```bash
git clone https://github.com/christianmat/jev-pokemon && cd jev-pokemon
npm install
npm run setup                 # installs rgbds (via brew), clones + builds pret/pokered, generates symbol data
cp /path/to/your/pokered.gb roms/red.gb   # your own dump of Pokémon Red (US/EU)
cp .env.example .env          # then fill it in
```

The ROM must be the US/EU release. Its SHA-1 is `ea9bcae617fdf159b045185467ae58b2e4a48b9a`, the same build pret/pokered produces. The harness reads RAM addresses from that disassembly, so other versions won't work.

### `.env`

| Variable | What it does |
|---|---|
| `JEV_MODE` | `gateway` for real Jev via Vercel AI Gateway, `mock` for a free, dumb stand-in (the default) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key (`VERCEL_AI_GATEWAY_API_KEY` also works) |
| `JEV_MIN_INTERVAL_MS`, `JEV_MAX_PER_MIN` | Throttling (defaults 300 ms and 90 per minute) |
| `YOUTUBE_STREAM_KEY` | Optional. Enables the live stream (or set a full `STREAM_URL`) |

## Run

```bash
npm start -- --speed 1                         # real-time; local viewer at http://localhost:8787
npm start -- --speed 1 --resume                # continue from the latest milestone checkpoint
npm start -- --speed 1 --load <save-name>      # load a specific save from saves/
npm run headless -- --steps 3000               # max speed, logs only
npx tsx scripts/tools/save.ts                  # save the running game (writes saves/manual-*.json)
```

With `YOUTUBE_STREAM_KEY` set, the bot also streams 1280×720 video: the game at 4× with game audio, plus the Jev panel.
- **Browser not needed:** ffmpeg runs in the background, so no browser or OBS has to stay open.
- **Laptop runs:** use `caffeinate -dimsu npm start -- --speed 1 …` on macOS to keep the machine awake.

### Logs

- `logs/jev-calls.jsonl` has every Jev call: the full state, the options with their facts, the probabilities, and the latency.
- `logs/events.jsonl` has maps, milestones, saves and errors.

## Cost

- **Price:** Jev costs $0.042 per million input tokens, and output is free. A typical call is about 1,200 tokens.
- **Rate:** at real-time speed the bot makes about 800–1,300 calls an hour. That comes to **about $1–1.70 per 24 hours**.
- **Ceiling:** the throttle's worst case, 90 calls a minute nonstop, is about $7 a day.
- **Stream panel:** shows the lifetime token count and cost in USD.

## Project layout

| Path | What |
|---|---|
| `src/emu/` | emulator wrapper (serverboy / GameBoy-Online core), save states, audio tap |
| `src/game/` | ROM tables, RAM reader, collision grid + A*, region graph |
| `src/jev/` | Jev client (throttle, cache, log), AI SDK gateway backend, mock |
| `src/agent/` | mode detection, dialog and menus, overworld, battle, field moves and items |
| `src/knowledge/` | story milestones |
| `src/stream/` | headless ffmpeg streamer + Jev panel drawn in the Game Boy font |
| `src/server/` | runner + local WebSocket viewer |
| `web/` | local viewer page |
| `site/` | public landing page (static; deploy with Vercel, root directory `site`) |
| `scripts/` | setup, data generation, debug tools |

## Deploying the landing page

`site/` is plain static HTML with no build step:
1. Create a Vercel project from this repo.
2. Set **Root Directory** to `site`.
3. Deploy.

The YouTube video ID and the repo link are in `site/index.html`.

## Legal

- **No ROM included.** This repo doesn't contain or link to Pokémon Red, and you need your own legally obtained copy. `roms/` is gitignored.
- **No Nintendo assets.** Game data (symbols, names, maps, font) is read at runtime from *your* ROM. The symbol file is generated locally from the [pret/pokered](https://github.com/pret/pokered) disassembly during `npm run setup`, which clones it into `vendor/`. That disassembly isn't redistributed here, and `vendor/` and `src/data/generated.json` are gitignored.
- **Not affiliated.** Pokémon is a trademark of Nintendo, Creatures Inc. and GAME FREAK inc. This is a fan experiment, not affiliated with or endorsed by Nintendo, Game Freak, The Pokémon Company or TypeSafe AI.
- **License.** GPL-2.0-or-later (see [`LICENSE`](LICENSE)), because it builds on the GPL-licensed [serverboy](https://gitlab.com/piglet-plays/serverboy.js) / GameBoy-Online emulator core.

Made by [Christian Mathiesen](https://github.com/christianmat) at [Frigade](https://frigade.com/?utm_source=jev-pokemon&utm_medium=readme).
