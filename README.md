# Billionaire Twilight

An online party game for 2 to 7 players. Tech billionaires race around the world for seven
luxuries, one per continent, then head back to their bunker to end the world. Each player plays
on their own phone at https://octopusheartsoftware.github.io/billionaire-twilight/.

## What's here

| Path | What it is |
| --- | --- |
| `index.html` | The whole phone page: lobby, map, rival dossiers, identifiers, items, sounds, replay |
| `data/world-map.json` | The 319-region world map: shapes, neighbors, straits, ship routes |
| `sprites/` | Passport, face and voice art, plus the operative and trap icons |
| `engine/rules.js` | Every game rule, shared by the server and the tests |
| `engine/api.js` | Rooms, lobby, timers and each player's private view |
| `engine/gamemap.js` | Compact map data for the server (generated from `data/world-map.json`) |
| `server/` | The Supabase function (`index.ts`) and the bundled game logic it loads |
| `tests/` | Bot player, engine test and API test |

## How it runs

The page is static and hosted on GitHub Pages. Every action goes to a Supabase Edge Function
named `game` in the `billionaire-twilight` project, which holds the only full copy of each game
and answers each phone with only what that player may see. Phones refresh when the server
broadcasts a change, with polling as a backup.

## Testing

    node tests/engine_test.mjs 300 4   # 300 bot games of 4 players through the rules engine
    node tests/api_test.mjs            # full games through the API, including timeouts

## Changing the rules

1. Edit `engine/`, then run both tests.
2. Rebuild the server bundle: `npx esbuild engine/api.js --bundle --format=esm --minify --platform=neutral --outfile=server/bundle.mjs`
3. Commit and push, then redeploy the `game` function with the new commit hash in its import.
