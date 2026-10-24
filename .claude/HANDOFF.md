# HANDOFF — Bike-Drop

**Updated:** 2026-10-24 11:38 CDT · **Branch:** `main` (closeout on `claude/bike-drop-mvp`) · **HEAD:** `607ebe6` (main)
**State:** MVP merged (PR #1) and live at https://bike-drop.pages.dev · no persistent memory dir in cloud sessions, so this file + `ROADMAP.md` are the memory

## Next steps
1. Add more data days so the puzzle changes daily. Today only `2026-09-30` exists and `schedule.json` cycles it, so puzzle #2 tomorrow is the same map. Run:
   `python3 scripts/build_day.py --month 202609 --date 2026-09-16 --play-date 2026-10-25`
   (other clean Tue–Thu candidates in Sept 2026: 09-09, 09-10, 09-15, 09-17, 09-22, 09-23, 09-29). Then `npm test`, commit pack + `schedule.json`, push → Pages redeploys.
2. Restrict the CARTO key to referer `bike-drop.pages.dev` in the CARTO Basemaps dashboard (user action).
3. Commit the Playwright play-through as `npm run smoke` so live checks are repeatable.

## Open loops
- [ ] Only one data day — `public/data/schedule.json`, `scripts/build_day.py`
- [ ] CARTO key unrestricted — CARTO dashboard (dashboard.basemaps.carto.com), key `cb1_4tnv_…`
- [ ] Play-through smoke test not in repo — invariants: replay counters == `simulate()`, best ≤ player ≤ do-nothing, displayed score == `score()`

## Gotchas
- Pages is Git-connected to `main`: every push to main deploys. Build `npm run build`, output `dist`, env `VITE_CARTO_API_KEY` set in Pages.
- CARTO tiles need a key since 2026-09-23; without it they show an "API key required" watermark.
- Raw trip zip (~1 GB/month) caches in `scripts/raw/` (git-ignored) and disappears with the cloud container; re-download takes ~30 s.
- Station capacity comes from today's GBFS, not the data day's.
- Solver must stay deterministic (fixed work, no randomness) or players get graded against different "best" plans.
- Cloudflare connector in cloud sessions is read-only; deploys go through the Git integration, not `wrangler`.
- Dev params: `?date=`, `?day=`, `?speed=5000`, `?replay=1`.

## Pointers
- `ROADMAP.md` — Now / Next / Later
- `README.md` — pipeline, day-pack format, assumptions, how to add a day
- `src/sim.js`, `src/solver.js` — game logic; `tests/` — vitest

## Log
- 2026-10-24 11:38 CDT — Deployed to Cloudflare Pages with CARTO key; live play-through passed on 390×844
- 2026-10-23 22:08 CDT — PR #1 merged: pipeline, simulator, solver, UI, 27 tests
