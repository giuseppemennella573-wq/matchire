# Matchire.ai

Before changing any website copy, layout or pricing, read docs/positioning.md and follow it. If a request conflicts with it, flag the conflict instead of guessing.

## Project notes
- Next.js app with a SQLite database; see README.md for setup, deploys, backups and the code map.
- The marketing page is `public/landing.html` (served at `/`); the vendor app lives under `src/app/app`.
- Pushes to `main` deploy to production on Render. Only push when Giuseppe says so.
