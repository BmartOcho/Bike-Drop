# Bike Drop — Roadmap

**Goal:** a daily, shareable rebalancing puzzle on real Citi Bike trips that people come back to every morning.

_Draft from the 2026-10-24 session — edit freely._

## Now
- **Daily content.** Build 2–4 weeks of data days so every play date is a fresh puzzle (`scripts/build_day.py --play-date`).
- **Lock down the CARTO key** to `bike-drop.pages.dev`.

## Next
- **Smoke test in repo.** Playwright play-through as `npm run smoke`, run against the dev server and the live URL.
- **Batch pipeline.** One command that builds N days from a month and assigns consecutive play dates.
- **Polish from real phone play.** Tap targets on dense Midtown clusters, replay legibility, share text.

## Later
- Monthly data refresh as Citi Bike publishes new months.
- Difficulty variety: other neighborhoods, other time windows (evening rush), weekend days.
- Practice mode / archive of past puzzles.
- Lightweight stats (score distribution) — needs a backend, so only if traction warrants it.

## Shipped
- 2026-10-24 — MVP (PR #1): pipeline, simulator, solver, mobile UI, tests; live at https://bike-drop.pages.dev
