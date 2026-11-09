// ==UserScript==
// @name         YT Series Forge
// @namespace    https://github.com/chirag127
// @version      1.0.0
// @description  Finds the best channels that explain a series, learns the real episode count from TVMaze/AniList, loops to hunt missing episodes, and builds one playlist per top channel.
// @author       chirag127
// @license      MIT
// @match        https://www.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @homepageURL  https://github.com/chirag127/yt-series-forge-userscript
// @supportURL   https://github.com/chirag127/yt-series-forge-userscript/issues
// @downloadURL  https://github.com/chirag127/yt-series-forge-userscript/raw/main/yt-series-forge.user.js
// @updateURL    https://github.com/chirag127/yt-series-forge-userscript/raw/main/yt-series-forge.user.js
// @require      https://raw.githubusercontent.com/chirag127/yt-core-lib/main/yt-core-lib.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.tvmaze.com
// @connect      graphql.anilist.co
// @connect      api.themoviedb.org
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * A SEPARATE SCRIPT ON PURPOSE — this is a different job from the playlist toolkit.
 *
 * It shares storage, the single AI key and the whole InnerTube layer with the other
 * scripts via `@require .../yt-core-lib.js`, so nothing is duplicated.
 *
 * Episode truth comes from metadata, not guesswork:
 *   TVMaze   keyless, CC BY-SA — /search/shows?q= then /shows/:id/episodes
 *   AniList  keyless GraphQL — used when the AI says the series is anime
 *   TMDB     optional free key, only when the user supplies one
 */

(function () {
  'use strict';

  if (typeof Ytk === 'undefined') {
    console.error('[series-forge] yt-core-lib did not load — @require failed.');
    return;
  }

  var DEFAULTS = {
    channels: 3,
    maxRounds: 3,
    maxQueries: 6,
    queriesPerGap: 4,
    queries: [
      '{q} all episodes explained',
      '{q} full story explained',
      '{q} explained in hindi',
      '{q} recap',
      '{q} recapped in hindi',
      '{q} complete series explained',
      '{q} movie explained'
    ]
  };

  function fsettings() {
    var saved = Ytk.storeGet('forge', {}) || {};
    var out = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        out[k] = saved[k] === undefined ? DEFAULTS[k] : saved[k];
      }
    }
    if (!Array.isArray(out.queries) || !out.queries.length) out.queries = DEFAULTS.queries;
    return out;
  }

  function saveFsettings(patch) {
    var next = fsettings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    Ytk.storeSet('forge', next);
    return next;
  }

  // ------------------------------------------------------------ http

  function httpJson(d) {
    return new Promise(function (resolve) {
      try {
        GM_xmlhttpRequest({
          method: d.method || 'GET',
          url: d.url,
          headers: d.headers || {},
          data: d.data,
          timeout: 20000,
          onload: function (res) {
            if (res.status < 200 || res.status >= 300) {
              resolve({ ok: false, error: 'HTTP ' + res.status + ' from ' + d.url });
              return;
            }
            try { resolve({ ok: true, data: JSON.parse(res.responseText) }); }
            catch (e) { resolve({ ok: false, error: 'not JSON from ' + d.url }); }
          },
          onerror: function () { resolve({ ok: false, error: 'network error for ' + d.url }); },
          ontimeout: function () { resolve({ ok: false, error: 'timeout for ' + d.url }); }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // ------------------------------------------------------------ metadata

  async function seriesTruth(name, isAnime) {
    var truth = { source: null, show: null, total: null, seasons: [] };

    var tv = await httpJson({ url: 'https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name) });
    if (tv.ok && Array.isArray(tv.data) && tv.data.length) {
      var shows = tv.data.map(function (r) { return r.show; }).filter(Boolean);
      shows.sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); });
      var best = shows[0];
      if (best && best.id) {
        var eps = await httpJson({ url: 'https://api.tvmaze.com/shows/' + best.id + '/episodes' });
        if (eps.ok && Array.isArray(eps.data)) {
          var numbered = eps.data.filter(function (e) { return typeof e.number === 'number'; });
          truth.source = 'TVMaze';
          truth.show = best.name || name;
          truth.total = numbered.length;
          var seen = {};
          numbered.forEach(function (e) {
            if (!seen[e.season]) { seen[e.season] = 1; truth.seasons.push(e.season); }
          });
          return truth;
        }
      }
    }

    if (isAnime) {
      var gql = 'query{Media(search:' + JSON.stringify(name) + ',type:ANIME){title{romaji}episodes}}';
      var an = await httpJson({
        method: 'POST',
        url: 'https://graphql.anilist.co',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ query: gql })
      });
      if (an.ok && an.data && an.data.data && an.data.data.Media && an.data.data.Media.episodes) {
        truth.source = 'AniList';
        truth.show = (an.data.data.Media.title && an.data.data.Media.title.romaji) || name;
        truth.total = an.data.data.Media.episodes;
        return truth;
      }
    }

    var key = String(Ytk.settings().tmdbKey || '').trim();
    if (key) {
      var sr = await httpJson({ url: 'https://api.themoviedb.org/3/search/tv?api_key=' + encodeURIComponent(key) + '&query=' + encodeURIComponent(name) });
      if (sr.ok && sr.data && Array.isArray(sr.data.results) && sr.data.results.length) {
        var show = sr.data.results[0];
        var det = await httpJson({ url: 'https://api.themoviedb.org/3/tv/' + show.id + '?api_key=' + encodeURIComponent(key) });
        if (det.ok && det.data && typeof det.data.number_of_episodes === 'number') {
          truth.source = 'TMDB';
          truth.show = show.name || name;
          truth.total = det.data.number_of_episodes;
          return truth;
        }
      }
    }

    return truth;
  }

  // ------------------------------------------------------------ ranking

  function expandQueries(name, templates) {
    var out = [];
    for (var i = 0; i < templates.length; i++) {
      var q = String(templates[i]).replace(/\{q\}/g, name).replace(/\s+/g, ' ').trim();
      if (q && out.indexOf(q) === -1) out.push(q);
    }
    return out.length ? out : [name];
  }

  function seriesMatcher(name) {
    var want = String(name).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(function (w) { return w.length > 2; });
    return function (title) {
      if (!want.length) return true;
      var hay = String(title || '').toLowerCase();
      for (var i = 0; i < want.length; i++) if (hay.indexOf(want[i]) !== -1) return true;
      return false;
    };
  }

  function coverageOf(videos) {
    var seen = {};
    var size = 0;
    for (var i = 0; i < videos.length; i++) {
      var e = Ytk.parseEpisode(videos[i].title);
      if (e && !seen[e.episode]) { seen[e.episode] = 1; size += 1; }
    }
    return { has: function (n) { return !!seen[n]; }, size: size };
  }

  /** Subscribers dominate, then series coverage, then views. */
  function scoreChannel(subs, covered, total, views) {
    var subScore = subs > 0 ? Math.log10(subs + 1) * 20 : 0;
    var ratio = total ? Math.min(covered / total, 1.5) : Math.min(covered, 40) / 40;
    var viewScore = views > 0 ? Math.log10(views + 1) * 6 : 0;
    return Math.round(subScore + ratio * 60 + viewScore);
  }

  // ------------------------------------------------------------ progress

  var panel = null;

  function closeProgress() {
    if (panel && panel.box.parentNode) panel.box.remove();
    panel = null;
  }

  function openProgress(title) {
    if (!document.getElementById('forge-css')) {
      var st = document.createElement('style');
      st.id = 'forge-css';
      st.textContent = '.forge-panel{position:fixed;left:16px;bottom:112px;z-index:2147483001;width:min(440px,calc(100vw - 32px));max-height:64vh;overflow:auto;border-radius:14px;background:#1c1c1c;color:#eaeaea;box-shadow:0 8px 40px rgba(0,0,0,.6);font:400 12.5px/1.55 system-ui,sans-serif}'
        + '.forge-panel header{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:11px 14px;border-bottom:1px solid #2e2e2e;background:#1c1c1c}'
        + '.forge-panel header b{flex:1;font-size:13px;font-weight:650}'
        + '.forge-panel .x{border:0;background:transparent;color:#9a9a9a;cursor:pointer;font-size:16px}'
        + '.forge-panel .body{padding:10px 14px 14px}'
        + '.forge-line{padding:1px 0;font-size:11.5px;color:#b9b9b9;word-break:break-word}'
        + '.forge-line.ok{color:#7ee787}.forge-line.warn{color:#ffa657}.forge-line.err{color:#ff8a80}';
      (document.head || document.documentElement).appendChild(st);
    }
    var body = Ytk.h('div', { class: 'body' });
    var box = Ytk.h('div', { class: 'forge-panel' },
      Ytk.h('header', {}, Ytk.h('b', { text: title }), Ytk.h('button', { class: 'x', text: '✕', onclick: closeProgress })),
      body
    );
    (document.body || document.documentElement).appendChild(box);
    panel = { box: box, body: body };
    return {
      log: function (msg, cls) {
        body.appendChild(Ytk.h('div', { class: 'forge-line ' + (cls || ''), text: msg }));
        body.scrollTop = body.scrollHeight;
      }
    };
  }

  // ------------------------------------------------------------ the agentic loop

  async function forge() {
    var raw = prompt('Series name — I will find the best channels that explain it.\nExample: Breaking Bad', '');
    if (!raw || !raw.trim()) return;
    var name = raw.trim();
    var cfg = fsettings();
    var ui = openProgress('Forging: ' + name);

    ui.log('Step 1 — how many episodes actually exist?');
    var isAnime = false;
    if (Ytk.aiReady()) {
      var guess = await Ytk.aiJson(
        'Answer with STRICT JSON only: {"isAnime":true|false,"canonicalTitle":"string"}. isAnime is true only for Japanese animated series.',
        JSON.stringify({ title: name })
      );
      if (guess.ok && guess.data) {
        isAnime = !!guess.data.isAnime;
        if (guess.data.canonicalTitle) ui.log('  AI canonical title: ' + guess.data.canonicalTitle);
      }
    }

    var truth = await seriesTruth(name, isAnime);
    if (truth.total) ui.log('  ' + truth.source + ' says "' + truth.show + '" has ' + truth.total + ' episode(s)', 'ok');
    else ui.log('  No metadata source matched — coverage cannot be measured, one round only.', 'warn');

    var match = seriesMatcher(name);
    var pool = new Map();
    var channels = new Map();
    var round = 0;
    var pending = expandQueries(name, cfg.queries).slice(0, Math.max(1, cfg.maxQueries));
    var maxRounds = truth.total ? Math.max(1, cfg.maxRounds) : 1;

    while (pending.length && round < maxRounds) {
      round += 1;
      ui.log('Round ' + round + ' — ' + pending.length + ' search(es)');

      for (var qi = 0; qi < pending.length; qi++) {
        var q = pending[qi];
        try {
          var found = await Ytk.searchVideos(q, 40);
          var added = 0;
          for (var fi = 0; fi < found.length; fi++) {
            if (!found[fi].id || pool.has(found[fi].id)) continue;
            pool.set(found[fi].id, found[fi]);
            added += 1;
          }
          ui.log('  "' + q + '" → ' + found.length + ' results, ' + added + ' new');
        } catch (e) {
          ui.log('  "' + q + '" failed: ' + e.message, 'err');
        }
        await Ytk.sleep(180);
      }

      channels.clear();
      pool.forEach(function (v) {
        if (!v.channelId || !match(v.title)) return;
        if (!channels.has(v.channelId)) channels.set(v.channelId, { id: v.channelId, name: v.channel || v.channelId, videos: [] });
        channels.get(v.channelId).videos.push(v);
      });

      var ranked = Array.from(channels.values());
      for (var ri = 0; ri < ranked.length; ri++) {
        ranked[ri].subs = await Ytk.channelSubscribers(ranked[ri].id);
        ranked[ri].eps = coverageOf(ranked[ri].videos);
        ranked[ri].views = ranked[ri].videos.reduce(function (a, v) { return a + Ytk.parseCount(v.views); }, 0);
        ranked[ri].score = scoreChannel(ranked[ri].subs, ranked[ri].eps.size, truth.total, ranked[ri].views);
        await Ytk.sleep(90);
      }
      ranked.sort(function (a, b) { return b.score - a.score; });

      ui.log('  Ranked ' + ranked.length + ' channel(s):');
      for (var sj = 0; sj < Math.min(5, ranked.length); sj++) {
        var rc = ranked[sj];
        var cov = truth.total ? rc.eps.size + '/' + truth.total : rc.eps.size + ' eps';
        ui.log('    ' + rc.score + '  ' + rc.name + ' — ' + (rc.subs ? rc.subs.toLocaleString() : '?') + ' subs, ' + cov);
      }

      if (!truth.total || !ranked.length) break;

      var leader = ranked[0];
      var missing = [];
      for (var n = 1; n <= truth.total; n++) if (!leader.eps.has(n)) missing.push(n);
      ui.log('  "' + leader.name + '" is missing ' + missing.length + ' episode(s)');

      if (!missing.length) { ui.log('  Coverage complete — stopping the loop.', 'ok'); break; }
      if (round >= maxRounds) { ui.log('  Round cap reached; reporting what exists.', 'warn'); break; }

      pending = missing.slice(0, Math.max(1, cfg.queriesPerGap)).map(function (e) {
        return name + ' episode ' + e + ' explained';
      });
      ui.log('  Next round hunts the gaps: ' + pending.length + ' targeted search(es)', 'warn');
    }

    var finalRanked = Array.from(channels.values()).sort(function (a, b) { return b.score - a.score; });
    if (!finalRanked.length) {
      ui.log('Nothing matched the series name. Try a shorter title or the native-language name.', 'err');
      return;
    }

    var top = finalRanked.slice(0, Math.max(1, Math.min(5, cfg.channels)));
    var plan = [];

    for (var pi = 0; pi < top.length; pi++) {
      var chan = top[pi];
      var vids = chan.videos.slice();

      if (Ytk.aiReady() && truth.total) {
        var res = await Ytk.aiJson(
          'Order explanation/recap videos of ONE series into episode order. STRICT JSON only. '
          + 'Schema: {"episodes":[{"videoId":"string","episode":number|null,"kind":"single|combined|split"}],'
          + '"playlistTitle":"string","warnings":["string"]}. Use ONLY the given videoIds. '
          + 'A combined upload covers several episodes in one video: list it once. Never invent episodes or ids.',
          JSON.stringify({
            series: name,
            channel: chan.name,
            expectedEpisodes: truth.total,
            videos: chan.videos.map(function (v) { return { videoId: v.id, title: v.title, duration: v.duration }; })
          })
        );
        if (res.ok && res.data) {
          var byId = {};
          chan.videos.forEach(function (v) { byId[v.id] = v; });
          var ordered = [];
          var seenId = {};
          var eps = res.data.episodes || [];
          for (var ei = 0; ei < eps.length; ei++) {
            var ep = eps[ei];
            if (!ep || !ep.videoId || seenId[ep.videoId] || !byId[ep.videoId]) continue;
            seenId[ep.videoId] = 1;
            ordered.push(byId[ep.videoId]);
          }
          if (ordered.length) vids = ordered;
          chan.aiTitle = res.data.playlistTitle;
          chan.aiWarnings = res.data.warnings || [];
        }
      } else {
        vids.sort(function (a, b) {
          var ea = Ytk.parseEpisode(a.title);
          var eb = Ytk.parseEpisode(b.title);
          return (ea ? ea.episode : 1e9) - (eb ? eb.episode : 1e9);
        });
      }

      chan.finalVideos = vids.slice(0, Ytk.settings().capAdd);
      plan.push(chan);
    }

    var lines = ['Series: ' + name + (truth.total ? ' (' + truth.total + ' episodes per ' + truth.source + ')' : ''), '', 'Playlists to create (' + plan.length + '):'];
    for (var pli = 0; pli < plan.length; pli++) {
      var pc = plan[pli];
      lines.push('');
      lines.push('• ' + (pc.aiTitle || (name + ' — ' + pc.name + ' (' + pc.finalVideos.length + ')')));
      lines.push('  channel: ' + pc.name + ' · ' + (pc.subs ? pc.subs.toLocaleString() : '?') + ' subs · score ' + pc.score);
      lines.push('  ' + pc.finalVideos.length + ' video(s)' + (truth.total ? ', covers ' + pc.eps.size + '/' + truth.total : ''));
      if (pc.aiWarnings && pc.aiWarnings.length) lines.push('  notes: ' + pc.aiWarnings.slice(0, 2).join('; '));
    }
    lines.push('');
    lines.push('Privacy: ' + (Ytk.settings().seriesPrivacy || 'PRIVATE'));
    lines.push('');
    lines.push('Create all ' + plan.length + '?');

    ui.log('Waiting for confirmation…');
    if (!confirm(lines.join('\n'))) { ui.log('Cancelled. Nothing was written.', 'warn'); return; }

    for (var ci = 0; ci < plan.length; ci++) {
      var target = plan[ci];
      var title = target.aiTitle || (name + ' — ' + target.name + ' (' + target.finalVideos.length + ')');
      ui.log('Creating "' + title + '"…');
      try {
        var ids = target.finalVideos.map(function (v) { return v.id; });
        if (!ids.length) { ui.log('  no videos, skipped', 'warn'); continue; }
        var playlistId = await Ytk.createPlaylist({
          title: title,
          description: 'Built by YT Series Forge from ' + target.name + (truth.total ? '. Series has ' + truth.total + ' episodes per ' + truth.source + '.' : '.'),
          privacyStatus: Ytk.settings().seriesPrivacy || 'PRIVATE',
          videoIds: ids.slice(0, 50)
        });
        var addedCount = Math.min(ids.length, 50);
        if (ids.length > 50) addedCount += await Ytk.addVideos(playlistId, ids.slice(50));
        ui.log('  ✓ ' + title + ' — ' + addedCount + ' video(s) → youtube.com/playlist?list=' + playlistId, 'ok');
        await Ytk.sleep(400);
      } catch (e) {
        ui.log('  ✕ "' + title + '" failed: ' + e.message, 'err');
      }
    }
    ui.log('Done.', 'ok');
  }

  // ------------------------------------------------------------ menu

  function editForgeSettings() {
    var cur = fsettings();
    var ch = prompt('How many channels should each get their own playlist? (1-5)', String(cur.channels));
    if (ch === null) return;
    var rounds = prompt('Max agentic rounds — each round hunts the missing episodes', String(cur.maxRounds));
    if (rounds === null) return;
    var q = prompt('Max search phrasings per round', String(cur.maxQueries));
    if (q === null) return;
    saveFsettings({
      channels: Math.max(1, Math.min(5, parseInt(ch, 10) || cur.channels)),
      maxRounds: Math.max(1, Math.min(6, parseInt(rounds, 10) || cur.maxRounds)),
      maxQueries: Math.max(1, Math.min(10, parseInt(q, 10) || cur.maxQueries))
    });
    alert('Forge settings saved.');
  }

  function editQueries() {
    var cur = fsettings();
    var v = prompt('Search phrasings, one per line. {q} is replaced by the series name.', cur.queries.join('\n'));
    if (v === null) return;
    var list = v.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!list.length) { alert('Kept the previous list.'); return; }
    saveFsettings({ queries: list });
    alert('Saved ' + list.length + ' phrasing(s).');
  }

  function showTruth() {
    var raw = prompt('Series name — check how many episodes exist', '');
    if (!raw || !raw.trim()) return;
    seriesTruth(raw.trim(), false).then(function (t) {
      if (!t.total) { alert('No metadata source matched "' + raw.trim() + '".'); return; }
      alert(t.source + ': "' + t.show + '"\n' + t.total + ' episodes\nSeasons: ' + (t.seasons.length ? t.seasons.join(', ') : 'n/a'));
    });
  }

  function showSetup() {
    var s = Ytk.settings();
    var f = fsettings();
    alert([
      'Shared AI settings — one key for every script:',
      '  endpoint: ' + s.aiBaseUrl,
      '  key: ' + (s.aiKey ? 'set (' + s.aiKey.length + ' chars)' : 'NOT set'),
      '  model: ' + (s.aiModel || 'NOT set'),
      '  edit these in the YouTube Toolkit script, set once',
      '',
      'Forge:',
      '  playlists made per run: ' + f.channels,
      '  agentic rounds: ' + f.maxRounds,
      '  phrasings per round: ' + f.maxQueries,
      '  gap searches per round: ' + f.queriesPerGap,
      '  privacy: ' + (s.seriesPrivacy || 'PRIVATE'),
      '',
      'Metadata: TVMaze keyless · AniList keyless (anime) · TMDB only with a key'
    ].join('\n'));
  }

  // Bootstrap marker: proves @require resolved and this file executed. Readable from the
  // page because localStorage is same-origin, which is how the harness verifies loading.
  try {
    localStorage.setItem('ytk.forge.boot', JSON.stringify({ at: Date.now(), core: Ytk.VERSION }));
  } catch (e) { /* ignore */ }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Forge playlists for a series…', forge);
    GM_registerMenuCommand('Forge: settings…', editForgeSettings);
    GM_registerMenuCommand('Forge: search phrasings…', editQueries);
    GM_registerMenuCommand('Forge: check episode count…', showTruth);
    GM_registerMenuCommand('Forge: AI + current setup', showSetup);
  }
})();
