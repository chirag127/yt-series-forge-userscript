// ==UserScript==
// @name         YT Series Forge
// @namespace    https://github.com/chirag127
// @version      2.0.0
// @description  Builds explanation/recap playlists for a series: learns the real episode count, ranks channels on the quality of their videos (never subscriber count), reuses an existing playlist when the channel already has one, and makes exactly ONE AI call at the end with all gathered context.
// @author       chirag127
// @license      MIT
// @match        https://www.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @homepageURL  https://github.com/chirag127/yt-series-forge-userscript
// @supportURL   https://github.com/chirag127/yt-series-forge-userscript/issues
// @downloadURL  https://github.com/chirag127/yt-series-forge-userscript/raw/main/yt-series-forge.user.js
// @updateURL    https://github.com/chirag127/yt-series-forge-userscript/raw/main/yt-series-forge.user.js
// @require      https://raw.githubusercontent.com/chirag127/yt-core-lib/main/yt-core-lib-1.4.0.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.tvmaze.com
// @connect      graphql.anilist.co
// @connect      api.themoviedb.org
// @connect      *
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * DESIGN (why this file is long)
 *
 * 1. QUALITY, NOT POPULARITY. Channels are ranked on the videos that actually cover the
 *    series: coverage first, then how well those videos performed per video, then breadth.
 *    Subscriber count is reported as context and used for nothing. A 20M-subscriber channel
 *    with 0 of 12 episodes scores 0.
 *
 * 2. REUSE BEFORE CREATE. If a channel already owns a playlist covering the series, that
 *    playlist is offered instead of minting a near-duplicate. Matching is fuzzy over
 *    normalised titles (diacritics stripped, non-Latin scripts preserved) plus channel id.
 *
 * 3. ONE AI CALL. All gathering — metadata, searches, channel enumeration, coverage,
 *    existing playlists — happens deterministically first. Exactly one model call happens at
 *    the end, receiving everything at once, and it only ORDERS and NAMES. Every id it returns
 *    is re-validated against the real candidate set before anything is written.
 *
 * 4. COVERAGE CAN BE SPLIT. Many series are not explained end to end by one channel. When no
 *    single channel reaches a useful coverage threshold, the run can assemble one
 *    cross-channel "complete" playlist, one video per episode, choosing the best available
 *    video for each episode. That is a distinct playlist from the per-channel ones.
 *
 * 5. NOTHING IS DESTRUCTIVE. No deletion. Creation happens only after an explicit confirm that
 *    lists every playlist, its videos and its coverage.
 */

(function () {
  'use strict';

  if (typeof Ytk === 'undefined') {
    console.error('[yt-series-forge] core did not load — @require failed.');
    return;
  }

  // ------------------------------------------------------------------ config

  const DEFAULTS = {
    channels: 3,             // fallback number of per-channel playlists
    maxRounds: 3,            // agentic gap-hunting rounds
    maxQueries: 6,           // phrasings per round
    queriesPerGap: 4,        // targeted searches per gap round
    minEpisodes: 2,          // a channel must cover at least this many episodes
    strongCoverage: 0.5,     // fraction of the series that counts as "complete enough"
    maxPlaylists: 15,        // hard cap
    videosPerPlaylist: 100,  // cap per playlist
    reuseExisting: true,     // offer an existing playlist instead of creating one
    buildComplete: true,     // allow the cross-channel complete playlist
    queries: [
      '{q} all episodes explained',
      '{q} full story explained',
      '{q} explained in hindi',
      '{q} recap',
      '{q} recapped in hindi',
      '{q} complete series explained',
      '{q} episode 1 explained'
    ]
  };

  function cfg() {
    const stored = Ytk.storeGet('forge', {}) || {};
    const out = {};
    for (const k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      out[k] = stored[k] === undefined ? DEFAULTS[k] : stored[k];
    }
    if (!Array.isArray(out.queries) || !out.queries.length) out.queries = DEFAULTS.queries;
    return out;
  }

  // ------------------------------------------------------------------ text

  const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

  /** Lowercase, strip combining marks, collapse anything that is not a letter or digit. */
  function normalise(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(DIACRITICS, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function tokens(text) {
    return normalise(text).split(' ').filter(function (w) { return w.length > 1; });
  }

  /**
   * Fuzzy series match. Handles Latin titles with accents, non-Latin scripts (Hindi, Tamil,
   * Thai, CJK) and repunctuated titles like "Baldur's Gate" vs "Baldurs Gate".
   */
  function seriesAffinity(title, series) {
    const t = normalise(title);
    const s = normalise(series);
    if (!s) return 0;
    if (t.indexOf(s) !== -1) return 1;
    const want = tokens(series);
    if (!want.length) return t === s ? 1 : 0;
    const have = tokens(title);
    if (!have.length) return 0;
    let hit = 0;
    for (const w of want) if (have.indexOf(w) !== -1) hit++;
    const ratio = hit / want.length;
    // A single distinctive token can be enough for short series names.
    if (want.length === 1 && hit === 1) return 0.9;
    return ratio;
  }

  // ------------------------------------------------------------------ metadata

  function httpJson(d) {
    return new Promise(function (resolve) {
      try {
        GM_xmlhttpRequest({
          method: d.method || 'GET',
          url: d.url,
          headers: d.headers || {},
          data: d.data,
          timeout: 20000,
          onload: function (r) {
            if (r.status < 200 || r.status >= 300) { resolve({ ok: false, error: 'HTTP ' + r.status }); return; }
            try { resolve({ ok: true, data: JSON.parse(r.responseText) }); }
            catch (e) { resolve({ ok: false, error: 'not JSON' }); }
          },
          onerror: function () { resolve({ ok: false, error: 'network error' }); },
          ontimeout: function () { resolve({ ok: false, error: 'timeout' }); }
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  /**
   * How many episodes really exist. TVMaze first (keyless, CC BY-SA), AniList as a second
   * keyless source, TMDB last and only if the user supplied a key. Returns total: null when
   * nothing matches — the pipeline then runs a single round and says so rather than inventing
   * a target.
   */
  async function seriesTruth(name) {
    const truth = { source: null, show: null, total: null, seasons: [], tried: [] };

    const tv = await httpJson({ url: 'https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name) });
    if (tv.ok && Array.isArray(tv.data) && tv.data.length) {
      const candidates = tv.data.map(function (row) { return row.show; }).filter(Boolean);
      candidates.sort(function (a, b) {
        return seriesAffinity(b.name, name) - seriesAffinity(a.name, name) || (b.weight || 0) - (a.weight || 0);
      });
      const best = candidates[0];
      if (best && best.id) {
        const eps = await httpJson({ url: 'https://api.tvmaze.com/shows/' + best.id + '/episodes' });
        if (eps.ok && Array.isArray(eps.data)) {
          const numbered = eps.data.filter(function (e) { return typeof e.number === 'number'; });
          if (numbered.length) {
            truth.source = 'TVMaze';
            truth.show = best.name || name;
            truth.total = numbered.length;
            const seen = {};
            numbered.forEach(function (e) {
              if (e.season !== undefined && e.season !== null && !seen[e.season]) { seen[e.season] = 1; truth.seasons.push(e.season); }
            });
            return truth;
          }
        }
      }
    }
    truth.tried.push('TVMaze');

    const gql = 'query{Media(search:' + JSON.stringify(name) + ',type:ANIME){title{romaji english}episodes}}';
    const an = await httpJson({
      method: 'POST',
      url: 'https://graphql.anilist.co',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ query: gql })
    });
    if (an.ok && an.data && an.data.data && an.data.data.Media && an.data.data.Media.episodes) {
      const media = an.data.data.Media;
      truth.source = 'AniList';
      truth.show = (media.title && (media.title.english || media.title.romaji)) || name;
      truth.total = media.episodes;
      return truth;
    }
    truth.tried.push('AniList');

    const tmdbKey = String(Ytk.settings().tmdbKey || '').trim();
    if (tmdbKey) {
      const sr = await httpJson({ url: 'https://api.themoviedb.org/3/search/tv?api_key=' + encodeURIComponent(tmdbKey) + '&query=' + encodeURIComponent(name) });
      if (sr.ok && sr.data && Array.isArray(sr.data.results) && sr.data.results.length) {
        const show = sr.data.results[0];
        const det = await httpJson({ url: 'https://api.themoviedb.org/3/tv/' + show.id + '?api_key=' + encodeURIComponent(tmdbKey) });
        if (det.ok && det.data && typeof det.data.number_of_episodes === 'number') {
          truth.source = 'TMDB';
          truth.show = show.name || name;
          truth.total = det.data.number_of_episodes;
          return truth;
        }
      }
      truth.tried.push('TMDB');
    }

    return truth;
  }

  // ------------------------------------------------------------------ ranking

  function expandQueries(name, templates, limit) {
    const out = [];
    for (const raw of templates) {
      const q = String(raw).replace(/\{q\}/g, name).replace(/\s+/g, ' ').trim();
      if (q && out.indexOf(q) === -1) out.push(q);
      if (limit && out.length >= limit) break;
    }
    return out.length ? out : [name];
  }

  /** Distinct episode numbers a candidate set covers. */
  function coverageOf(videos) {
    const seen = {};
    let size = 0;
    for (const v of videos) {
      const e = Ytk.parseEpisode(v.title);
      if (e && !seen[e.episode]) { seen[e.episode] = 1; size += 1; }
    }
    return { has: function (n) { return !!seen[n]; }, size: size, numbers: Object.keys(seen).map(Number) };
  }

  /**
   * Quality of a channel's coverage. Subscribers are deliberately absent.
   *   coverage 70 | per-video reach 10 | breadth 0.5 per covered episode (cap 40 episodes)
   */
  function qualityScore(covered, total, views) {
    const coverage = total ? Math.min(covered / total, 1) : Math.min(covered, 40) / 40;
    const perVideo = covered > 0 ? views / covered : 0;
    const reach = perVideo > 0 ? Math.log10(perVideo + 1) : 0;
    return Math.round(coverage * 70 + reach * 10 + Math.min(covered, 40) * 0.5);
  }

  // ------------------------------------------------------------------ existing playlists

  /**
   * Playlists this channel already has that look like they cover the series. Reads only.
   * Matching is fuzzy: normalised series affinity over the playlist title, plus an owner
   * check on the channel name or its browse id.
   */
  async function findExistingPlaylists(channel, seriesName) {
    const found = [];
    try {
      const queries = [seriesName + ' ' + channel.name, seriesName + ' playlist ' + channel.name];
      for (const q of queries) {
        let res;
        try { res = await Ytk.itPost('search', { query: q }); } catch (e) { continue; }
        const lists = Ytk.collect(res, 'playlistRenderer') || [];
        for (const pl of lists) {
          if (!pl || !pl.playlistId) continue;
          const title = Ytk.textOf(pl.title);
          const owner = Ytk.textOf(pl.shortBylineText);
          const ownerId = (Ytk.collect(pl, 'browseId') || [])[0] || '';
          const ownedByChannel =
            (channel.id && ownerId === channel.id) ||
            (owner && normalise(owner).indexOf(normalise(channel.name)) !== -1) ||
            (owner && normalise(channel.name).indexOf(normalise(owner)) !== -1);
          if (!ownedByChannel) continue;
          if (seriesAffinity(title, seriesName) < 0.6) continue;
          if (found.some(function (f) { return f.id === pl.playlistId; })) continue;
          found.push({
            id: pl.playlistId,
            title: title,
            count: Ytk.textOf(pl.videoCountText),
            videos: Ytk.textOf(pl.videoCountShortText) || Ytk.parseCount(Ytk.textOf(pl.videoCountText)),
            affinity: seriesAffinity(title, seriesName)
          });
        }
        await Ytk.sleep(160);
      }
    } catch (e) { /* a failed lookup must never block the run */ }
    found.sort(function (a, b) { return b.affinity - a.affinity; });
    return found;
  }

  // ------------------------------------------------------------------ progress

  let box = null;

  function closeProgress() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  function openProgress(title) {
    if (!document.getElementById('forge-css')) {
      const st = document.createElement('style');
      st.id = 'forge-css';
      st.textContent = '.forge-panel{position:fixed;left:16px;bottom:112px;z-index:2147483001;width:min(460px,calc(100vw - 32px));max-height:64vh;overflow:auto;border-radius:14px;background:#1c1c1c;color:#eaeaea;box-shadow:0 8px 40px rgba(0,0,0,.6);font:400 12.5px/1.55 system-ui,sans-serif}'
        + '.forge-panel header{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:11px 14px;border-bottom:1px solid #2e2e2e;background:#1c1c1c}'
        + '.forge-panel header b{flex:1;font-size:13px;font-weight:650}'
        + '.forge-panel .x{border:0;background:transparent;color:#9a9a9a;cursor:pointer;font-size:16px}'
        + '.forge-panel .body{padding:10px 14px 14px}'
        + '.forge-line{padding:1px 0;font-size:11.5px;color:#b9b9b9;word-break:break-word}'
        + '.forge-line.ok{color:#7ee787}.forge-line.warn{color:#ffa657}.forge-line.err{color:#ff8a80}';
      (document.head || document.documentElement).appendChild(st);
    }
    const body = Ytk.h('div', { class: 'body' });
    const panel = Ytk.h('div', { class: 'forge-panel' },
      Ytk.h('header', {}, Ytk.h('b', { text: title }), Ytk.h('button', { class: 'x', text: '✕', onclick: closeProgress })),
      body
    );
    (document.body || document.documentElement).appendChild(panel);
    box = panel;
    return {
      log: function (msg, cls) {
        body.appendChild(Ytk.h('div', { class: 'forge-line ' + (cls || ''), text: msg }));
        body.scrollTop = body.scrollHeight;
      }
    };
  }

  // ------------------------------------------------------------------ gather

  /**
   * Deterministic gathering. No model call happens here. Returns everything the single final
   * AI call will need.
   */
  async function gather(name, ui) {
    const c = cfg();

    ui.log('Step 1 — how many episodes exist?');
    const truth = await seriesTruth(name);
    if (truth.total) {
      ui.log('  ' + truth.source + ': "' + truth.show + '" has ' + truth.total + ' episode(s)'
        + (truth.seasons.length ? ' across ' + truth.seasons.length + ' season(s)' : ''), 'ok');
    } else {
      ui.log('  No metadata source matched (' + truth.tried.join(', ') + '). Coverage cannot be measured; one round only.', 'warn');
    }

    const pool = new Map();
    let round = 0;
    let pending = expandQueries(name, c.queries, c.maxQueries);
    const maxRounds = truth.total ? Math.max(1, c.maxRounds) : 1;

    while (pending.length && round < maxRounds) {
      round += 1;
      ui.log('Round ' + round + ' — ' + pending.length + ' search(es)');
      for (const q of pending) {
        try {
          const found = await Ytk.searchVideos(q, 40);
          let added = 0;
          for (const v of found) {
            if (!v.id || pool.has(v.id)) continue;
            pool.set(v.id, v);
            added += 1;
          }
          ui.log('  "' + q + '" → ' + found.length + ' results, ' + added + ' new (pool ' + pool.size + ')');
        } catch (e) {
          ui.log('  "' + q + '" failed: ' + e.message, 'err');
        }
        await Ytk.sleep(180);
      }

      const ranked = rankChannels(pool, name, truth, c);
      for (let i = 0; i < Math.min(6, ranked.length); i++) {
        const r = ranked[i];
        ui.log('  ' + r.score + '  ' + r.name + ' — ' + r.eps.size
          + (truth.total ? '/' + truth.total : '') + ' episodes, ' + (r.subs ? r.subs.toLocaleString() : '?') + ' subs');
      }

      if (!truth.total || !ranked.length) break;

      const strong = ranked.filter(function (r) { return r.eps.size >= c.minEpisodes; });
      if (!strong.length) {
        ui.log('  No channel covers at least ' + c.minEpisodes + ' episode(s) yet.', 'warn');
        break;
      }
      const leader = strong[0];
      const missing = [];
      for (let n = 1; n <= truth.total; n++) if (!leader.eps.has(n)) missing.push(n);
      ui.log('  "' + leader.name + '" is missing ' + missing.length + ' episode(s)');

      if (!missing.length) { ui.log('  Coverage complete — stopping the loop.', 'ok'); break; }
      if (round >= maxRounds) { ui.log('  Round cap reached.', 'warn'); break; }

      pending = missing.slice(0, Math.max(1, c.queriesPerGap)).map(function (n) {
        return name + ' episode ' + n + ' explained';
      });
      ui.log('  Next round hunts the gaps: ' + pending.length + ' search(es)', 'warn');
    }

    const rankedFinal = rankChannels(pool, name, truth, c);

    ui.log('Looking for playlists these channels already have…');
    for (const ch of rankedFinal.slice(0, 8)) {
      if (ch.eps.size < c.minEpisodes) continue;
      const existing = c.reuseExisting ? await findExistingPlaylists(ch, name) : [];
      ch.existing = existing;
      if (existing.length) ui.log('  ' + ch.name + ' already has: ' + existing.map(function (p) { return p.title; }).join(' | '), 'ok');
      await Ytk.sleep(120);
    }

    return { truth: truth, ranked: rankedFinal, poolSize: pool.size, rounds: round };
  }

  /** Group the pool by channel, score on quality, keep the useful ones. */
  function rankChannels(pool, name, truth, c) {
    const byChannel = new Map();
    pool.forEach(function (v) {
      if (!v.channelId) return;
      if (seriesAffinity(v.title, name) < 0.4) return;
      if (!byChannel.has(v.channelId)) {
        byChannel.set(v.channelId, { id: v.channelId, name: v.channel || v.channelId, videos: [], subs: 0 });
      }
      byChannel.get(v.channelId).videos.push(v);
    });

    const out = Array.from(byChannel.values());
    for (const ch of out) {
      ch.eps = coverageOf(ch.videos);
      ch.views = ch.videos.reduce(function (a, v) { return a + Ytk.parseCount(v.views); }, 0);
      ch.score = qualityScore(ch.eps.size, truth.total, ch.views);
      ch.existing = [];
    }
    out.sort(function (a, b) {
      if (b.eps.size !== a.eps.size) return b.eps.size - a.eps.size;
      return b.score - a.score;
    });
    return out;
  }

  /** Subscriber counts are fetched only to be *reported*, never to rank. */
  async function attachSubscribers(ranked, ui) {
    for (const ch of ranked.slice(0, 10)) {
      ch.subs = await Ytk.channelSubscribers(ch.id);
      await Ytk.sleep(80);
    }
    if (ui) ui.log('Subscriber counts fetched for context only — they do not affect ranking.');
  }

  // ------------------------------------------------------------------ the ONE AI call

  /**
   * Exactly one model call for the whole run. It receives the series, the expected episode
   * count, every candidate channel with its coverage and titles, and the playlists those
   * channels already own. It decides: which existing playlist to reuse, how many new ones to
   * build, their titles, and whether a cross-channel complete playlist makes sense.
   */
  async function decide(ctx, name) {
    const c = cfg();
    const truth = ctx.truth;
    const ranked = ctx.ranked;

    if (!Ytk.aiReady()) {
      return { ok: false, error: 'AI is not configured', plan: null };
    }

    const channels = ranked.slice(0, 12).map(function (ch) {
      return {
        channelId: ch.id,
        channel: ch.name,
        episodesCovered: ch.eps.size,
        expectedEpisodes: truth.total || null,
        qualityScore: ch.score,
        existingPlaylists: (ch.existing || []).slice(0, 3).map(function (p) {
          return { playlistId: p.id, title: p.title, videoCount: p.count };
        }),
        candidates: ch.videos.slice(0, 40).map(function (v) {
          return { videoId: v.id, title: v.title, duration: v.duration, views: v.views || '' };
        })
      };
    });

    const res = await Ytk.aiJson(
      'You are assembling explanation/recap playlists for one series on YouTube. '
        + 'STRICT JSON only, no prose. Schema: '
        + '{"reason":"string","playlists":[{"channelId":"string","reusePlaylistId":"string|null",'
        + '"title":"string","videoIds":["string"],"why":"string"}],'
        + '"completePlaylist":{"build":boolean,"title":"string","perEpisode":[{"episode":number,"videoId":"string"}]},'
        + '"warnings":["string"]}. '
        + 'Rules: (a) use ONLY videoId and channelId values that appear in the input, never invent ids; '
        + '(b) if a channel already has a suitable playlist, set reusePlaylistId instead of listing videoIds; '
        + '(c) prefer channels that cover more of the series — subscriber count is irrelevant; '
        + '(d) build at most ' + c.maxPlaylists + ' playlists; '
        + '(e) if no single channel covers most of the series but the episodes are spread across channels, '
        + 'set completePlaylist.build true and give one videoId per episode, best quality available; '
        + '(f) order videoIds by season then episode; a video covering several episodes appears once; '
        + '(g) titles must be plain, human, and distinct from each other.',
      JSON.stringify({
        series: name,
        metadataShow: truth.show,
        metadataSource: truth.source,
        expectedEpisodes: truth.total,
        totalCandidatesFound: ctx.poolSize,
        roundsRun: ctx.rounds,
        channels: channels
      })
    );

    if (!res.ok || !res.data) return { ok: false, error: res.error || 'no reply', plan: null };
    return { ok: true, plan: res.data };
  }

  /** Re-validate everything the model proposed against the real data. */
  function validatePlan(plan, ctx, name) {
    const c = cfg();
    const byChannel = new Map();
    const videoOwner = new Map();
    for (const ch of ctx.ranked) {
      byChannel.set(ch.id, ch);
      for (const v of ch.videos) videoOwner.set(v.id, ch.id);
    }

    const playlists = [];
    const warnings = (plan.warnings || []).map(String).slice(0, 10);
    const titles = {};
    let droppedIds = 0;
    let droppedChannels = 0;

    const cleanTitle = function (raw, fallback) {
      let t = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 140);
      if (!t) t = fallback;
      let base = t;
      let n = 2;
      while (titles[t]) { t = base + ' (' + n + ')'; n += 1; }
      titles[t] = 1;
      return t;
    };

    for (const p of (plan.playlists || []).slice(0, c.maxPlaylists)) {
      if (!p || !p.channelId) { droppedChannels += 1; continue; }
      const ch = byChannel.get(p.channelId);
      if (!ch) { droppedChannels += 1; continue; }

      const reuse = p.reusePlaylistId && (ch.existing || []).some(function (e) { return e.id === p.reusePlaylistId; })
        ? p.reusePlaylistId : null;

      const ids = [];
      const seen = {};
      for (const id of (p.videoIds || [])) {
        if (!id || seen[id]) continue;
        if (videoOwner.get(id) !== ch.id) { droppedIds += 1; continue; }
        seen[id] = 1;
        ids.push(id);
      }

      if (!reuse && !ids.length) { droppedChannels += 1; continue; }

      const byId = {};
      for (const v of ch.videos) byId[v.id] = v;
      playlists.push({
        channel: ch.name,
        channelId: ch.id,
        reuse: reuse,
        title: cleanTitle(p.title, name + ' - ' + ch.name),
        why: String(p.why || '').slice(0, 200),
        videos: ids.slice(0, c.videosPerPlaylist).map(function (id) { return byId[id]; }).filter(Boolean),
        covered: ch.eps.size
      });
    }

    // cross-channel complete playlist, if the model asked for one and the ids are real
    let complete = null;
    const cp = plan.completePlaylist;
    if (c.buildComplete && cp && cp.build) {
      const per = (cp.perEpisode || []).filter(function (x) {
        return x && typeof x.episode === 'number' && x.videoId && videoOwner.has(x.videoId);
      });
      const seenEps = {};
      const picked = [];
      let droppedComplete = 0;
      for (const x of per) {
        if (seenEps[x.episode]) { droppedComplete += 1; continue; }
        seenEps[x.episode] = 1;
        picked.push(x);
      }
      if (picked.length >= Math.max(2, Math.ceil((ctx.truth.total || picked.length) * 0.3))) {
        const byId = new Map();
        for (const ch of ctx.ranked) for (const v of ch.videos) byId.set(v.id, v);
        complete = {
          title: cleanTitle(cp.title, name + ' - Complete (cross-channel)'),
          videos: picked.sort(function (a, b) { return a.episode - b.episode; })
            .slice(0, c.videosPerPlaylist)
            .map(function (x) { return byId.get(x.videoId); })
            .filter(Boolean),
          episodes: picked.length
        };
        if (droppedComplete) warnings.push(droppedComplete + ' duplicate episode id(s) dropped from the complete playlist.');
      } else if (picked.length) {
        warnings.push('Complete playlist skipped: only ' + picked.length + ' valid episode(s) proposed.');
      }
    }

    if (droppedChannels) warnings.push(droppedChannels + ' channel(s) proposed by the model were unknown or empty and were dropped.');
    if (droppedIds) warnings.push(droppedIds + ' video id(s) belonged to another channel and were dropped.');

    return { playlists: playlists, complete: complete, warnings: warnings, reason: String(plan.reason || '').slice(0, 300) };
  }

  // ------------------------------------------------------------------ run

  async function forge(presetName) {
    const raw = presetName || prompt('Series name — I will find the channels that actually explain it.\nExample: Bad Buddy', '');
    if (!raw || !raw.trim()) return;
    const name = raw.trim();
    const c = cfg();

    closeProgress();
    const ui = openProgress('Forging: ' + name);

    const ctx = await gather(name, ui);
    if (!ctx.ranked.length) {
      ui.log('No channel matched the series name. Try the native-language title or a shorter name.', 'err');
      return;
    }

    await attachSubscribers(ctx.ranked, ui);

    const strong = ctx.ranked.filter(function (ch) { return ch.eps.size >= c.minEpisodes; });
    if (!strong.length) {
      ui.log('No channel covers at least ' + c.minEpisodes + ' episode(s), so nothing was built.', 'err');
      return;
    }
    ui.log('Channels worth considering: ' + strong.length + ' of ' + ctx.ranked.length, 'ok');

    ui.log('Making the single AI call with all gathered context…');
    const decided = await decide({ truth: ctx.truth, ranked: strong, poolSize: ctx.poolSize, rounds: ctx.rounds }, name);
    if (!decided.ok) {
      ui.log('AI call failed: ' + decided.error + ' — using a deterministic fallback.', 'warn');
      const fallback = strong.slice(0, Math.max(1, Math.min(c.channels, c.maxPlaylists))).map(function (ch) {
        return {
          channelId: ch.id,
          title: name + ' - ' + ch.name,
          videoIds: ch.videos.slice(0, c.videosPerPlaylist).map(function (v) { return v.id; }),
          why: 'fallback: best available coverage'
        };
      });
      decided.plan = { playlists: fallback, completePlaylist: { build: false }, warnings: ['AI unavailable; deterministic plan used.'], reason: 'fallback' };
      decided.ok = true;
    }

    const plan = validatePlan(decided.plan, ctx, name);
    ui.log('Model reasoning: ' + (plan.reason || '(none)'), 'ok');

    if (!plan.playlists.length && !plan.complete) {
      ui.log('Nothing to build: the model proposed no valid playlist.', 'warn');
      if (plan.warnings.length) plan.warnings.forEach(function (w) { ui.log('  ' + w, 'warn'); });
      return;
    }

    const lines = ['Series: ' + name + (ctx.truth.total ? ' (' + ctx.truth.total + ' episodes per ' + ctx.truth.source + ')' : ' (episode count unknown)'), ''];
    if (plan.complete) {
      lines.push('Cross-channel complete playlist:');
      lines.push('  ' + plan.complete.title + ' — ' + plan.complete.videos.length + ' video(s), '
        + plan.complete.episodes + ' episode(s)');
      lines.push('');
    }
    lines.push('Per-channel playlists (' + plan.playlists.length + '):');
    for (const p of plan.playlists) {
      lines.push('');
      if (p.reuse) {
        lines.push('• REUSE existing: ' + p.title);
        lines.push('  channel: ' + p.channel + ' — nothing new will be created');
      } else {
        lines.push('• ' + p.title);
        lines.push('  channel: ' + p.channel + ' — ' + p.videos.length + ' video(s), covers '
          + p.covered + (ctx.truth.total ? '/' + ctx.truth.total : '') + ' episode(s)');
      }
      if (p.why) lines.push('  why: ' + p.why);
    }
    if (plan.warnings.length) {
      lines.push('');
      lines.push('Warnings:');
      plan.warnings.forEach(function (w) { lines.push('  - ' + w); });
    }
    lines.push('');
    lines.push('Privacy: ' + (Ytk.settings().seriesPrivacy || 'PRIVATE'));
    lines.push('');
    lines.push('Create these? Existing playlists are reused, never duplicated.');

    if (!confirm(lines.join('\n'))) {
      ui.log('Cancelled. Nothing was written.', 'warn');
      return;
    }

    const privacy = Ytk.settings().seriesPrivacy || 'PRIVATE';

    if (plan.complete) {
      try {
        const ids = plan.complete.videos.map(function (v) { return v.id; });
        const pid = await Ytk.createPlaylist({
          title: plan.complete.title,
          description: 'Cross-channel complete playlist for ' + name
            + (ctx.truth.total ? '. Series has ' + ctx.truth.total + ' episodes per ' + ctx.truth.source + '.' : '.'),
          privacyStatus: privacy,
          videoIds: ids.slice(0, 50)
        });
        let added = Math.min(ids.length, 50);
        if (ids.length > 50) added += await Ytk.addVideos(pid, ids.slice(50));
        ui.log('  ✓ ' + plan.complete.title + ' — ' + added + ' video(s) → youtube.com/playlist?list=' + pid, 'ok');
        await Ytk.sleep(400);
      } catch (e) {
        ui.log('  ✕ complete playlist failed: ' + e.message, 'err');
      }
    }

    let reuseCount = 0;
    let createdCount = 0;

    for (const p of plan.playlists) {
      if (p.reuse) {
        reuseCount += 1;
        ui.log('  ↺ reused existing playlist "' + p.title + '" → youtube.com/playlist?list=' + p.reuse, 'ok');
        continue;
      }
      const ids = p.videos.map(function (v) { return v.id; });
      if (!ids.length) { ui.log('  - skipped "' + p.title + '": no videos', 'warn'); continue; }
      ui.log('Creating "' + p.title + '"…');
      try {
        const pid = await Ytk.createPlaylist({
          title: p.title,
          description: 'Built by YT Series Forge from ' + p.channel + '.'
            + (ctx.truth.total ? ' Covers ' + p.covered + ' of ' + ctx.truth.total + ' episodes per ' + ctx.truth.source + '.' : ''),
          privacyStatus: privacy,
          videoIds: ids.slice(0, 50)
        });
        let added = Math.min(ids.length, 50);
        if (ids.length > 50) added += await Ytk.addVideos(pid, ids.slice(50));
        createdCount += 1;
        ui.log('  ✓ ' + p.title + ' — ' + added + ' video(s) → youtube.com/playlist?list=' + pid, 'ok');
        await Ytk.sleep(400);
      } catch (e) {
        ui.log('  ✕ "' + p.title + '" failed: ' + e.message, 'err');
      }
    }

    ui.log('Done. ' + createdCount + ' created, ' + reuseCount + ' reused.', 'ok');
  }

  // ------------------------------------------------------------------ settings

  function openForgeSettings() {
    if (typeof Ytk.openSettings !== 'function') {
      alert('The shared core is out of date (v' + Ytk.VERSION + '). Reinstall this script.');
      return;
    }
    const c = cfg();
    Ytk.openSettings({
      title: 'YT Series Forge',
      subtitle: 'Ranks channels on the quality of their videos, reuses playlists that already exist, and makes one AI call at the end.',
      sectionTitle: 'Forging',
      fields: [
        { key: 'minEpisodes', label: 'Minimum episodes a channel must cover', type: 'number', def: c.minEpisodes },
        { key: 'channels', label: 'Fallback playlists when the AI cannot decide', type: 'number', def: c.channels },
        { key: 'maxRounds', label: 'Gap-hunting rounds', type: 'number', def: c.maxRounds },
        { key: 'maxQueries', label: 'Search phrasings per round', type: 'number', def: c.maxQueries },
        { key: 'reuseExisting', label: 'Reuse a playlist the channel already has', type: 'checkbox', def: c.reuseExisting },
        { key: 'buildComplete', label: 'Allow a cross-channel complete playlist', type: 'checkbox', def: c.buildComplete },
        { key: 'seriesPrivacy', label: 'Privacy for new playlists', type: 'select', options: ['PRIVATE', 'UNLISTED', 'PUBLIC'], def: Ytk.settings().seriesPrivacy || 'PRIVATE' },
        { key: 'tmdbKey', label: 'TMDB key (optional third metadata source)', type: 'password', def: Ytk.settings().tmdbKey || '' },
        { key: 'forgeQueries', label: 'Search phrasings, one per line — {q} is the series name', type: 'textarea', def: c.queries, split: true }
      ],
      actions: [
        { label: 'Forge a series now', run: function () { forge(); } },
        { label: 'Check the episode count for a series', run: function () {
          const s = prompt('Series name', '');
          if (!s || !s.trim()) return;
          seriesTruth(s.trim()).then(function (t) {
            alert(t.total
              ? t.source + ': "' + t.show + '" has ' + t.total + ' episode(s)'
                + (t.seasons.length ? ' across ' + t.seasons.length + ' season(s)' : '')
              : 'No metadata source matched "' + s.trim() + '".');
          });
        } },
        { label: 'Reset the search phrasings', run: function () {
          Ytk.storeSet('forge', Object.assign(cfg(), { queries: DEFAULTS.queries }));
          Ytk.toast('Phrasings reset');
        } }
      ],
      onSave: function (saved) {
        // openSettings writes flat keys; mirror the ones this script owns into its own blob.
        const blob = Object.assign(cfg(), {
          minEpisodes: saved.minEpisodes !== undefined ? saved.minEpisodes : cfg().minEpisodes,
          channels: saved.channels !== undefined ? saved.channels : cfg().channels,
          maxRounds: saved.maxRounds !== undefined ? saved.maxRounds : cfg().maxRounds,
          maxQueries: saved.maxQueries !== undefined ? saved.maxQueries : cfg().maxQueries,
          reuseExisting: saved.reuseExisting !== undefined ? saved.reuseExisting : cfg().reuseExisting,
          buildComplete: saved.buildComplete !== undefined ? saved.buildComplete : cfg().buildComplete
        });
        if (Array.isArray(saved.forgeQueries) && saved.forgeQueries.length) blob.queries = saved.forgeQueries;
        Ytk.storeSet('forge', blob);
        if (saved.seriesPrivacy) Ytk.saveSettings({ seriesPrivacy: saved.seriesPrivacy });
      }
    });
  }

  // ------------------------------------------------------------------ boot

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Settings…', openForgeSettings);
  }

  // Deep link: youtube.com/...#ytk-forge=Bad+Buddy starts a run without a native prompt.
  // This also makes an end-to-end run drivable by an automated test.
  if (location.hash.indexOf('#ytk-forge=') === 0) {
    const preset = decodeURIComponent(location.hash.slice('#ytk-forge='.length)).split('+').join(' ').trim();
    if (preset) setTimeout(function () { forge(preset); }, 700);
  }

  try {
    localStorage.setItem('ytk.forge.boot', JSON.stringify({ at: Date.now(), core: Ytk.VERSION, version: '2.0.0' }));
  } catch (e) { /* ignore */ }
})();
