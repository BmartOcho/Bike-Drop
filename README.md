# Bike Drop 🚲

A daily browser puzzle about bike-share rebalancing, built on real Citi Bike trips.

It's 11 PM in lower Manhattan and you're the overnight rebalancing crew. You get **one van (20 bikes)** and **8 stops**. At each stop you pick up or drop off bikes. Then the **real trips from 6–10 AM** that morning replay on the map, sped up to a minute. Every rider who finds an empty dock (no bike) or a full dock (nowhere to return) is a miss. Fewer misses = better.

**Play it:** https://bike-drop.pages.dev

Modeled on [2mindrills.com](https://2mindrills.com): one shared puzzle per day, your decisions graded against a computed best, and a Wordle-style result to share.

Bike Drop is an independent, fan-made game, not affiliated with Citi Bike or Lyft. Trip data from [Citi Bike System Data](https://citibikenyc.com/system-data), used under the [Citi Bike Data Use Policy](https://ride.citibikenyc.com/data-sharing-policy).

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulator + solver unit tests (vitest)
npm run build      # static site in dist/
```

Handy dev query params: `?date=2026-10-24` plays a given play date, `?day=2026-09-30` forces a data day, `?speed=5000` makes the replay 5 s, `?replay=1` skips the saved result and lets you play again.

### Deploying (Cloudflare Pages)

Static site, no backend. Build command `npm run build`, output directory `dist`. One optional environment variable:

| Variable | Purpose |
| --- | --- |
| `VITE_CARTO_API_KEY` | Free key from [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey). CARTO basemaps require one since September 2026; without it the dark tiles carry an "API key required" watermark but the game still works. |

Copy `.env.example` to `.env` for local development.

## How it works

```
scripts/build_day.py   Python, run once per data day → public/data/days/<date>.json + schedule.json
src/sim.js             pure simulator: apply plan, replay trips, count misses, emit replay events
src/solver.js          greedy + local-search solver, scoring, per-stop grades, share string
src/solver.worker.js   runs the solver off the main thread
src/map.js             Leaflet + CARTO dark tiles, station circles, forecast hints, stop badges
src/replay.js          60-second canvas animation driven by the simulator's event list
src/main.js            app state, station stepper, results, localStorage
src/schedule.js        which data day is today's puzzle, puzzle number
src/storage.js         localStorage wrapped in try/catch, streak bookkeeping
tests/                 vitest unit tests for the simulator, solver and scoring
```

### Data pipeline

`scripts/build_day.py` does the following (needs Python 3.10+ and `pandas`):

1. **Download** — lists `https://s3.amazonaws.com/tripdata/`, takes the most recent complete NYC month (`YYYYMM-citibike-tripdata.zip`, not the `JC-` Jersey City files) and caches it in `scripts/raw/` (git-ignored, ~1 GB).
2. **Stations** — fetches names, coordinates and capacity from the GBFS feed `station_information.json`. Trip CSVs reference stations by `short_name` (e.g. `6140.05`), which is what we join on.
3. **Pick a day** — an ordinary Tuesday–Thursday: not a US federal holiday or adjacent to one, with the previous evening inside the archive. Among those, the day with the *median* 6–10 AM trip volume (avoids both washouts and freak peaks). `--date` overrides.
4. **Select stations** — stations in Manhattan south of 59th St (a lon/lat outline plus a sloped line along 59th St; stations on 59th / Central Park South count). The 50 busiest by 6–10 AM starts + ends that day, with a 320 m minimum spacing so one hot block doesn't take every slot and the picks spread across neighborhoods.
5. **Starting inventory** — 50 % of capacity, adjusted by the station's net flow (arrivals − departures) from 6–11 PM the previous evening, clamped to 0..capacity. See *Assumptions*.
6. **Trips** — all trips starting 6:00–9:59 AM that start *or* end at a selected station. The unselected end is kept as a coordinate so the replay can draw it, but it doesn't take part in the simulation.
7. **Output** — `public/data/days/YYYY-MM-DD.json` (under 500 KB; the current pack is ~220 KB) and `public/data/schedule.json`.

Day pack format:

```jsonc
{
  "date": "2026-09-30", "weekday": "Wednesday", "source": "202609-citibike-tripdata.zip",
  "window": { "start": 21600, "end": 36000 },      // 6:00–10:00 in seconds from midnight
  "vanCapacity": 20, "stops": 8,
  "stations": [{ "id": "6140.05", "name": "W 31 St & 7 Ave", "lat": 40.749, "lon": -73.992, "cap": 84 }],
  "inventory": [0, 23, ...],                        // bikes docked at 11 PM, per station
  "eveningNet": [-57, 4, ...],                      // previous-evening net flow (for reference)
  "ext": [[40.7612, -73.9707], ...],                // unselected endpoints, coordinates only
  "trips": [[21601, 11, -561, 332], ...]            // [startSec, originIdx, destIdx, durationSec]
}
```

`originIdx` / `destIdx` ≥ 0 index `stations`. Negative means "not one of our stations": `-(k+1)` indexes `ext[k]`, and `-1` means unknown. The simulator treats every negative endpoint the same way (the trip just doesn't touch our inventory at that end); the extra coordinates only feed the animation.

`schedule.json`:

```json
{ "epoch": "2026-10-24", "days": ["2026-09-30"], "byDate": { "2026-10-24": "2026-09-30" } }
```

Puzzle number = days since `epoch` + 1. A play date uses `byDate[date]` if present, otherwise `days[n % days.length]`, so the game never runs out — it cycles.

### Adding a new day

```bash
# most recent complete month, auto-picked day, assigned to a play date
python3 scripts/build_day.py --play-date 2026-10-25

# or explicitly
python3 scripts/build_day.py --month 202609 --date 2026-09-17 --play-date 2026-10-25
```

Commit the new `public/data/days/*.json` and the updated `schedule.json`, then run `npm test` — the tests load every real pack referenced by the schedule and check its shape, size, and that the solver beats doing nothing.

### Simulator

`src/sim.js` is pure and deterministic.

- `applyPlan(day, plan)` applies the stops in order. A stop is `{ station, delta }`: positive drops bikes off, negative picks them up. Anything infeasible (dropping more than the van holds, picking up more than are docked, exceeding dock or van capacity) is clamped; the UI never lets you build an infeasible stop in the first place.
- `simulate(day, inventory)` steps through departures and arrivals in time order (arrivals first on ties). A departure from an empty station is a **stranded** miss and the trip is cancelled. An arrival at a full station is a **full dock** miss and the bike docks at the nearest selected station with space (so overflow cascades, as it does in Midtown at 9 AM).
- `baseline(day)` is the do-nothing run. `forecast(day)` turns it into the ▼ / ▲ hints — no numbers leak to the player.
- With `{ events: true }` the simulator also returns the full event timeline; the replay animation and its counters are driven from that list, so what you watch is exactly what was scored.

### Solver and scoring

`src/solver.js`, run in a Web Worker:

1. A cheap **single-station estimate** (each station replayed on its own gives a miss curve over starting inventory) ranks candidate moves instantly.
2. The **top candidates are re-scored with the full simulator**.
3. **Greedy with 2-step lookahead**: at each stop take the move — or the pickup→drop pair — that removes the most misses given the van's load.
4. **Local search**: nudge amounts, swap stations, drop useless stops, append new ones; keep anything that lowers misses. A fixed amount of work, so every player is graded against the same plan. ~150 ms on a laptop, well under a second on a phone.

- **Score** = `(doNothing − player) / (doNothing − solver) × 100`, clamped to 0–100.
- **Per-stop grades** compare the misses a stop saved with the best single move available at that moment: 🟩 ≥ 75 %, 🟨 ≥ 40 %, 🟧 > 0, 🟥 nothing or worse. A pickup that is immediately followed by a drop is judged on the pair, since the pickup's value is the drop it enables.

## Assumptions

- **11 PM inventory is synthetic.** Citi Bike publishes trips, not dock counts. We start every station at 50 % of capacity and add its real net flow from 6–11 PM the previous evening, clamped to 0..capacity. That makes evening-draining stations (Midtown offices) start low and evening-filling ones (residential blocks) start high. Real overnight rebalancing is ignored, so the puzzle is somewhat harder than the real crew's night.
- **Capacity is today's**, from GBFS, not the capacity on the data day. Stations without a GBFS match or with zero capacity are never selected.
- **Overflow redirects to the nearest selected station with space**, even when a closer unselected station exists in reality. This is what makes Midtown flood cascade from one station to the next.
- **Only 50 stations are simulated.** Trips to or from the other ~2,400 stations count only at their selected end.
- **Tie-breaking**: at the same second, arrivals are processed before departures.
- Travel is animated along straight lines; the van's own route isn't modeled (any 8 stops are allowed in any order).

## Verified play-through

Played end to end on the dev server (Playwright, 390×844): the replay's served / stranded / full-dock counters matched `simulate()` exactly, the solver's misses were ≤ the player's, do-nothing ≥ solver, and the displayed score equalled `score()` computed independently in Node. Result and streak persist across a reload.
