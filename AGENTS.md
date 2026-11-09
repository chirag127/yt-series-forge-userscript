# AGENTS.md — yt-series-forge-userscript

Read the collection AGENTS.md, PLAN.md and yt-core-lib/AGENTS.md first.

## What this script is

The series workflow, deliberately separate from the playlist scripts: learn how many episodes
exist from a metadata API, rank channels by subscriber count and coverage, then loop until the
missing episodes are found, and build one playlist per top channel.

## Non-negotiables

1. Requires yt-core-lib. Never copy InnerTube, AI, storage or the settings popup in here.
2. EXACTLY ONE context-menu entry: Settings…, which opens Ytk.openSettings with the forge fields
   (channels per run, agentic rounds, phrasings per round, privacy) plus the shared AI section.
   Actions such as running the forge belong on the button inside that popup or on the toolbar,
   not as extra menu entries.
3. Metadata order is fixed: TVMaze (keyless) then AniList (anime) then TMDB (only with a key).
   TVMaze data is CC BY-SA and the playlist description credits it.
4. Channel scoring is deterministic: log10(subscribers+1)*20 + coverage*60 + log10(views+1)*6.
   Do not hand channel choice to the model; the model may order episodes, it may not invent ids.
5. Every AI-proposed videoId is re-validated against the real candidate set. Ids from another
   channel or invented ids are dropped and reported.
6. Nothing is written without an explicit confirm that shows the title, count and coverage.
7. Graphite rule: no innerHTML, no unhandled promise rejections, no silent failures.

## Known limits

- Coverage is measured from episode numbers in titles. A channel that never numbers its uploads
  under-reports coverage.
- TVMaze is rate limited per IP; repeat runs may see 429.
