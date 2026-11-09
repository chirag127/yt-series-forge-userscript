# YT Series Forge

Give it a series name. It finds the channels that explain that series best, learns the **real**
episode count from a metadata API, then loops until it has the episodes — and builds one playlist
per top channel so you can pick whichever version you prefer.

**Separate repo on purpose** — this is a different job from the playlist toolkit. It shares storage,
the single AI key and the whole InnerTube layer via
[`yt-core-lib`](https://github.com/chirag127/yt-core-lib), so nothing is duplicated.

## Install

Read the [install guide](https://github.com/chirag127/userscript-install-guide), then:

```
https://github.com/chirag127/yt-series-forge-userscript/raw/main/yt-series-forge.user.js
```

## How it works — the loop

```
1. series name
2. AI (optional): is this anime? what is the canonical title?
3. metadata: how many episodes exist?        TVMaze → AniList → TMDB
4. ROUND 1  search N phrasings → merge → group by channel →
            score every channel → find the leader's missing episodes
5. ROUND 2  search ONLY the missing episodes → re-score → did coverage improve?
6. ROUND 3  …until coverage is complete, no progress, or the round cap
7. dry run: playlist per channel + coverage + warnings → confirm → create
```

It stops early when coverage is complete. Every round and every score is printed, so the decision is
auditable rather than a black box.

## Channel scoring

```
score = log10(subscribers + 1) × 20      ← subscribers dominate, as asked
      + (covered / totalEpisodes) × 60   ← did it actually explain the series
      + log10(views + 1) × 6             ← tie-break
```

## Episode truth, not guesswork

| Source | Key needed | Used for |
|---|---|---|
| **TVMaze** | none | `/search/shows?q=` → `/shows/:id/episodes`, full episode list |
| **AniList** | none | GraphQL `Media.episodes`, when the AI flags anime |
| TMDB | free key (optional) | only if you add one in settings |

TVMaze data is CC BY-SA and this script credits it in the playlist description. With no metadata
match the loop runs a single round and says so, instead of inventing a target.

## Settings — all in the context menu

| Entry | Does |
|---|---|
| `Forge playlists for a series…` | runs the loop |
| `Forge: settings…` | playlists per run (1-5), rounds (1-6), phrasings per round |
| `Forge: search phrasings…` | edit the phrasing list, `{q}` = series name |
| `Forge: check episode count…` | metadata lookup only, no YouTube calls |
| `Forge: AI + current setup` | shows the shared AI config and forge settings |

**The AI key is shared** with every other script in this collection (same storage namespace), so you
set it once in the YouTube Toolkit script's settings panel. ScriptCat's cloud sync carries it.

## Safety

- One playlist per channel, created only after an explicit confirm that shows title, count, coverage.
- AI-proposed video ids are re-validated: ids not in the real candidate set are dropped.
- Capped at 50 videos per create call, remainder appended in bursts.

## Known limits

- Coverage is measured from **episode numbers in titles**. A channel that uploads "Part 1/2" per
  episode, or never numbers them, will under-report coverage.
- Metadata lookup matches on the name you type. Renamed or regional titles may miss.
- TVMaze is rate-limited per IP; repeated runs may briefly get 429.

## License

MIT
