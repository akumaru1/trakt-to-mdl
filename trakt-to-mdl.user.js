// ==UserScript==
// @name         Trakt → MyDramaList importer
// @namespace    akumaru.trakt2mdl
// @version      2.0.3
// @updateURL    https://raw.githubusercontent.com/akumaru1/trakt-to-mdl/main/trakt-to-mdl.user.js
// @downloadURL  https://raw.githubusercontent.com/akumaru1/trakt-to-mdl/main/trakt-to-mdl.user.js
// @description  One-click sync of your Trakt watched history into your MyDramaList list, split by season
// @match        https://mydramalist.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.trakt.tv
// ==/UserScript==

(() => {
  'use strict';

  /* Page window: hooks and MDL calls must run against the page, not the userscript sandbox. */
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const LS = W.localStorage;
  const doc = W.document;

  /* ---------- config ---------- */
  const NS = 'trakt2mdl';
  const STORE = `${NS}:state:v2`;
  const STORE_V1 = `${NS}:state:v1`;
  const SETTINGS = `${NS}:settings:v1`;
  const SEASON_CACHE = `${NS}:seasons:v1`;
  const ARM = `${NS}:arm:v1`;
  const CANDS = `${NS}:cands:v1`;
  const SEARCH_DELAY_MS = 1500;
  const IMPORT_DELAY_MS = 4000;
  const TRAKT_DELAY_MS = 300;
  const AUTO_MIN_SCORE = 7;
  const AUTO_MIN_GAP = 2;
  const EP_KEY_RE = /ep|progress|watched|seen/i;
  const PROGRESS_KEYS = ['episode_seen', 'episodes_seen', 'progress', 'ep_seen', 'episode', 'ep'];
  const USERDATA_KEYS = ['score', 'note', 'date_start', 'date_finish', 'times_rewatched', 'rewatch_value', 'priority'];
  const ASIAN = new Set(['jp', 'kr', 'cn', 'tw', 'th', 'hk', 'ph', 'sg', 'my', 'id', 'vn']);
  const AIRING = new Set(['returning series', 'continuing', 'in production', 'planned', 'upcoming', 'pilot']);
  const IGNORE_URL_RE = /\/api\/event|\/v1\/users\/data|\/(?:log|track|analytics|stats|beacon|ping)\b|google|doubleclick|quantserve|htlbid|seedtag/i;
  const STATUS_NAMES = { 1: 'Watching', 2: 'Completed', 3: 'Plan to Watch', 4: 'On Hold', 5: 'Dropped', 6: 'Not Interested' };

  const origFetch = W.fetch.bind(W);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.4);
  const kindOf = (o) => Object.prototype.toString.call(o).slice(8, -1); // cross-realm safe type check

  /* ---------- storage ---------- */
  const load = (k, d) => { try { return JSON.parse(LS.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(NS, 'save failed', e); } };
  const getSettings = () => ({ clientId: '', username: 'akumaru', ...load(SETTINGS, {}) });

  function getState() {
    const s = load(STORE, null) || { rows: {}, templates: {}, order: [] };
    s.rows ||= {}; s.templates ||= {}; s.order ||= [];
    if (!s.migrated) {   // carry over captured requests and matches from v1
      const v1 = load(STORE_V1, null);
      if (v1?.templates) s.templates = { ...v1.templates, ...s.templates };
      s.v1rows = v1?.rows || {};
      s.migrated = true;
    }
    return s;
  }
  let state = null;
  const persist = () => save(STORE, state);

  /* ---------- helpers ---------- */
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const titleIdFromPath = (p = W.location.pathname) => (p.match(/^\/(\d+)-/) || [])[1] || '';
  const idFromHref = (h) => (String(h || '').match(/(?:mydramalist\.com)?\/(\d+)-[^/?#]*/) || [])[1] || '';
  const absUrl = (u) => { try { return new URL(u, W.location.href).href; } catch { return String(u); } };
  const getToken = () => (doc.cookie.match(/(?:^|;\s*)jl_sess=([^;]+)/) || [])[1] || '';
  const yearOf = (iso) => Number(String(iso || '').slice(0, 4)) || 0;

  function similarity(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 5;
    if (x.includes(y) || y.includes(x)) return 3.5;
    const A = new Set(x.split(' ')), B = new Set(y.split(' '));
    const inter = [...A].filter((w) => B.has(w)).length;
    return (inter / new Set([...A, ...B]).size) * 4;
  }

  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  function seasonNumOf(title) {
    const t = String(title || '');
    let m = t.match(/season\s*(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i) || t.match(/\bpart\s*(\d{1,2})\b/i);
    if (m) return Number(m[1]);
    m = t.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\s*$/i);
    if (m) return ROMAN[m[1].toLowerCase()];
    m = t.match(/[\s:]\s*(\d{1,2})\s*$/);
    if (m && Number(m[1]) < 30) return Number(m[1]);
    return 0;
  }

  function scoreCandidate(row, c) {
    let s = Math.max(...row.queries.map((q) => similarity(q, c.title)));
    const y = row.seasonYear || row.year;
    if (c.year && y) {
      const d = Math.abs(c.year - y);
      s += d === 0 ? 3 : d === 1 ? 1.5 : -2;
    }
    const isMovie = /movie/i.test(c.type);
    if (c.type) s += (row.kind === 'movie') === isMovie ? 2 : -2;
    if (row.kind === 'show' && /special/i.test(c.type)) s -= 2;
    if (row.kind === 'show' && c.eps && row.total) {
      const d = Math.abs(c.eps - row.total);
      s += d === 0 ? 2 : d === 1 ? 1 : -1;
    }
    if (row.kind === 'show' && row.seasonCount > 1) {
      const n = seasonNumOf(c.title);
      if (row.season === 1) s += n > 1 ? -3 : 1;
      else if (n === row.season) s += 3;
      else if (n) s -= 3;
      else s -= 1;
    }
    return Math.round(s * 10) / 10;
  }

  /* ---------- Trakt ---------- */
  function httpGet(url, headers) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout: 30000,
        onload: (r) => {
          const h = (name) => Number((String(r.responseHeaders || '').match(new RegExp(`${name}:\\s*(\\d+)`, 'i')) || [])[1]) || 0;
          resolve({ status: r.status, text: r.responseText, retryAfter: h('retry-after'), pageCount: h('x-pagination-page-count') });
        },
        onerror: () => reject(new Error('network error reaching Trakt')),
        ontimeout: () => reject(new Error('Trakt timed out')),
      }));
    }
    return origFetch(url, { headers }).then(async (r) => ({
      status: r.status, text: await r.text(),
      retryAfter: Number(r.headers?.get?.('retry-after')) || 0,
      pageCount: Number(r.headers?.get?.('x-pagination-page-count')) || 0,
    }));
  }

  async function trakt(path) {
    const { clientId } = getSettings();
    if (!clientId) throw new Error('No Trakt Client ID set. Click Settings.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await httpGet(`https://api.trakt.tv${path}`, {
        'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId,
      });
      if (r.status === 429) { await sleep((r.retryAfter || 5) * 1000); continue; }
      if (r.status === 401 || r.status === 403) throw new Error(`Trakt refused (${r.status}): check the Client ID, and that your Trakt profile is public.`);
      if (r.status === 404) throw new Error('Trakt user not found. Check the username in Settings.');
      if (r.status < 200 || r.status >= 300) throw new Error(`Trakt HTTP ${r.status}`);
      trakt.lastPageCount = r.pageCount;
      return JSON.parse(r.text);
    }
    throw new Error('Trakt rate limit: try again in a few minutes.');
  }

  async function traktPaged(path, onPage) {
    const all = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await trakt(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`);
      if (!Array.isArray(data) || !data.length) break;
      all.push(...data);
      onPage?.(page, trakt.lastPageCount);
      if (!trakt.lastPageCount || page >= trakt.lastPageCount) break;
      await sleep(TRAKT_DELAY_MS);
    }
    return all;
  }

  async function getSeasons(traktId, airing) {
    const cache = load(SEASON_CACHE, {});
    const hit = cache[traktId];
    if (hit && hit.until > Date.now()) return hit.seasons;
    const raw = await trakt(`/shows/${traktId}/seasons?extended=full`);
    const seasons = raw.filter((s) => s.number > 0).map((s) => ({
      number: s.number, total: s.episode_count || 0, aired: s.aired_episodes || 0, year: yearOf(s.first_aired),
    }));
    cache[traktId] = { until: Date.now() + (airing ? 1 : 14) * 86400000, seasons };
    save(SEASON_CACHE, cache);
    await sleep(TRAKT_DELAY_MS);
    return seasons;
  }

  let traktInfo = '';
  const isAsian = (o) => ASIAN.has(String(o.country || '').toLowerCase());
  const isAnimated = (o) => (o.genres || []).some((g) => /^(anime|animation)$/i.test(g));

  // Turn Trakt watched data into one row per MDL entry: one per movie, one per watched season.
  async function buildRowsFromTrakt(onProgress) {
    const { username } = getSettings();
    const u = encodeURIComponent(username);
    const shows = await trakt(`/users/${u}/watched/shows?extended=full`);
    const movies = await trakt(`/users/${u}/watched/movies?extended=full`);
    const out = [];
    const skipped = [];

    for (const m of movies) {
      const mv = m.movie;
      if (!isAsian(mv) || isAnimated(mv)) { skipped.push(mv.title); continue; }
      out.push({
        key: `m${mv.ids.trakt}`, slug: mv.ids.slug, kind: 'movie', title: mv.title, year: mv.year,
        season: 0, seasonCount: 0, seasonYear: mv.year, total: 1, aired: 1, watched: 1,
        status: 'completed', episodes: 1, airing: false,
        queries: [...new Set([mv.title, mv.original_title].filter(Boolean))],
      });
    }

    const asianShows = shows.filter((s) => isAsian(s.show) && !isAnimated(s.show));
    shows.filter((s) => !asianShows.includes(s)).forEach((s) => skipped.push(s.show.title));

    // Trakt may return watched shows without the per-season episode list.
    // If so, rebuild it from your episode history (every play has season + episode number).
    const hist = new Map();   // trakt show id -> Map(season -> Set(episode))
    const withSeasons = asianShows.filter((s) => (s.seasons || []).length).length;
    let histCount = 0;
    if (withSeasons < asianShows.length) {
      const items = await traktPaged(`/users/${u}/history/episodes`, (p, pc) => onProgress?.(`Reading episode history page ${p}${pc ? `/${pc}` : ''}…`));
      histCount = items.length;
      for (const it of items) {
        const id = it.show?.ids?.trakt; const e = it.episode;
        if (!id || !e || !(e.season > 0)) continue;
        if (!hist.has(id)) hist.set(id, new Map());
        const sm = hist.get(id);
        if (!sm.has(e.season)) sm.set(e.season, new Set());
        sm.get(e.season).add(e.number);
      }
    }
    traktInfo = `Trakt: ${shows.length} shows (${asianShows.length} Asian live-action, ${withSeasons} with season data), ${movies.length} movies${histCount ? `, ${histCount} history entries` : ''}`;
    let n = 0;
    for (const s of asianShows) {
      n += 1;
      const sh = s.show;
      onProgress?.(`Reading seasons ${n}/${asianShows.length}: ${sh.title}`);
      const airing = AIRING.has(String(sh.status || '').toLowerCase());
      let seasons = [];
      try { seasons = await getSeasons(sh.ids.trakt, airing); } catch (e) { console.warn(NS, 'seasons failed', sh.title, e); }
      const lastSeason = Math.max(0, ...seasons.map((x) => x.number));
      let watchedSeasons = (s.seasons || []).filter((x) => x.number > 0);
      if (!watchedSeasons.length && hist.has(sh.ids.trakt)) {
        watchedSeasons = [...hist.get(sh.ids.trakt)].map(([number, set]) => ({ number, episodes: [...set].map((e) => ({ number: e, plays: 1 })) }));
      }
      if (!watchedSeasons.length) {
        // No episode-level data at all: one row from the show totals, flagged so you check the season by hand.
        const total = seasons.length === 1 ? seasons[0].total : (sh.aired_episodes || 0);
        const plays = Math.min(s.plays || 0, total || s.plays || 0);
        const done = total > 0 && plays >= total && !airing;
        out.push({
          key: `s${sh.ids.trakt}:1`, slug: sh.ids.slug, kind: 'show', title: sh.title, year: sh.year,
          season: 1, seasonCount: 1, seasonYear: seasons[0]?.year || sh.year, total, aired: total, watched: plays, airing,
          status: done ? 'completed' : 'watching', episodes: done ? total : plays,
          queries: [...new Set([sh.title, sh.original_title].filter(Boolean))],
          noEpisodeData: seasons.length > 1,
        });
        continue;
      }
      for (const ws of watchedSeasons) {
        const eps = (ws.episodes || []).filter((e) => e.plays > 0);
        if (!eps.length) continue;
        const meta = seasons.find((x) => x.number === ws.number) || {};
        const total = meta.total || (watchedSeasons.length === 1 ? sh.aired_episodes : 0) || 0;
        const aired = meta.aired || total;
        const maxEp = Math.max(...eps.map((e) => e.number));
        const stillAiring = airing && ws.number === lastSeason && aired < total;
        const done = total > 0 && eps.length >= total && !stillAiring;
        const multi = Math.max(seasons.length, watchedSeasons.length) > 1;
        const base = [sh.title, sh.original_title].filter(Boolean);
        const queries = multi && ws.number > 1
          ? base.flatMap((t) => [`${t} Season ${ws.number}`, `${t} ${ws.number}`]).concat(base)
          : base;
        out.push({
          key: `s${sh.ids.trakt}:${ws.number}`, slug: sh.ids.slug, kind: 'show',
          title: sh.title, year: sh.year, season: ws.number, seasonCount: multi ? Math.max(seasons.length, watchedSeasons.length) : 1,
          seasonYear: meta.year || sh.year, total, aired, watched: eps.length, airing: stillAiring,
          status: done ? 'completed' : 'watching', episodes: done ? total : maxEp,
          queries: [...new Set(queries)],
        });
      }
    }
    return { rows: out, skipped };
  }

  /* ---------- MDL search ---------- */
  function parseSearch(html) {
    const d = new W.DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const seen = new Set();
    const push = (anchor, box) => {
      const id = idFromHref(anchor.getAttribute('href'));
      const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!id || !title || seen.has(id)) return;
      seen.add(id);
      const meta = (box?.querySelector('.text-muted')?.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({
        id, title,
        url: `https://mydramalist.com${new URL(anchor.getAttribute('href'), 'https://mydramalist.com').pathname}`,
        meta,
        type: (meta.split(' - ')[0] || '').trim(),
        year: Number((meta.match(/\b(19|20)\d{2}\b/) || [])[0]) || 0,
        eps: Number((meta.match(/(\d+)\s+episodes?/i) || [])[1]) || 0,
      });
    };
    d.querySelectorAll('[id^="mdl-"]').forEach((box) => {
      const a = box.querySelector('h6 a[href], .title a[href]')
        || [...box.querySelectorAll('a[href]')].find((x) => /^\/\d+-/.test(x.getAttribute('href')) && x.textContent.trim());
      if (a) push(a, box);
    });
    if (!out.length) {
      d.querySelectorAll('a[href]').forEach((a) => {
        if (!/^\/\d+-[^/?#]+$/.test(a.getAttribute('href'))) return;
        if (a.closest('nav, header, footer')) return;
        push(a, a.closest('.box, li, div'));
      });
    }
    return out;
  }

  const searchCache = new Map();
  async function searchMdl(q) {
    if (searchCache.has(q)) return searchCache.get(q);
    const r = await origFetch(`/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`search HTTP ${r.status}`);
    const res = parseSearch(await r.text());
    searchCache.set(q, res);
    await sleep(jitter(SEARCH_DELAY_MS));
    return res;
  }

  /* ---------- your MDL list ---------- */
  // Returns { id: rawItem } or null if the check itself failed (never read a failure as "not on list").
  async function checkInList(ids) {
    const token = getToken();
    if (!token) return null;
    const map = {};
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const p = new URLSearchParams({ token, lang: 'en-US', mylist: chunk.join('-'), t: 'z' });
      const r = await origFetch(`/v1/users/data?${p}`, { headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' }).catch(() => null);
      if (!r?.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j) return null;
      const items = Array.isArray(j.mylist) ? j.mylist : Object.values(j.mylist || {});
      items.forEach((it, idx) => {
        const id = String(it?.rid || it?.id || it?.title_id || it?.tid || (items.length === chunk.length ? chunk[idx] : '') || '');
        if (id && it?.status) map[id] = it;
      });
    }
    return map;
  }

  const progressOf = (item) => {
    const k = PROGRESS_KEYS.find((x) => item && item[x] != null && /^\d+$/.test(String(item[x])));
    return k ? { key: k, value: Number(item[k]) } : null;
  };

  /* ---------- request capture ---------- */
  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    if (kindOf(h) === 'Headers') h.forEach((v, k) => { o[k] = v; });
    else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; });
    else Object.assign(o, h);
    return o;
  }

  function serializeBody(body) {
    if (body == null) return { kind: 'none', body: null };
    if (typeof body === 'string') return { kind: 'text', body };
    const k = kindOf(body);
    if (k === 'URLSearchParams') return { kind: 'text', body: body.toString() };
    if (k === 'FormData') return { kind: 'form', body: [...body.entries()].filter(([, v]) => typeof v === 'string') };
    return null;
  }

  function maybeCapture(url, method, headers, rawBody) {
    const arm = load(ARM, null);
    if (!arm) return;
    method = String(method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
    url = absUrl(url);
    if (!/^https:\/\/(?:[\w-]+\.)?mydramalist\.com\//.test(url)) return;
    if (IGNORE_URL_RE.test(url)) return;
    const titleId = titleIdFromPath();
    if (!titleId || titleId.length < 3) return;
    const ser = serializeBody(rawBody);
    if (!ser) return;
    const bodyText = ser.kind === 'form' ? ser.body.map((e) => e.join('=')).join('&') : String(ser.body || '');
    const idRe = new RegExp(`(^|\\D)${titleId}(\\D|$)`);
    if (!idRe.test(url) && !idRe.test(bodyText)) return;
    const tpl = { mode: arm.mode, url, method, headers, bodyKind: ser.kind, body: ser.body, titleId, epValue: String(arm.epValue), capturedAt: new Date().toISOString() };
    if (!epKeysOf(tpl).length) {
      const seen = load(CANDS, []);
      seen.unshift({ tpl, bodyText: bodyText.slice(0, 300) });
      save(CANDS, seen.slice(0, 15));
      setTimeout(render, 50);
      return;
    }
    acceptTemplate(tpl);
  }

  function acceptTemplate(tpl) {
    const st = getState();
    st.templates[tpl.mode] = tpl;
    save(STORE, st);
    LS.removeItem(ARM); LS.removeItem(CANDS);
    if (state) state.templates = st.templates;
    toast(`Captured "${tpl.mode}" request.`);
    setTimeout(render, 50);
  }

  const pageFetch = W.fetch;
  W.fetch = function (input, init) {
    try {
      const isReq = kindOf(input) === 'Request';
      maybeCapture(isReq ? input.url : input, init?.method || (isReq ? input.method : 'GET'), headersToObj(init?.headers || (isReq ? input.headers : null)), init?.body);
    } catch (e) { console.warn(NS, e); }
    return pageFetch.apply(this, arguments);
  };
  const XP = W.XMLHttpRequest.prototype;
  const XO = XP.open, XH = XP.setRequestHeader, XS = XP.send;
  XP.open = function (method, url) { this.__t2m = { method, url, headers: {} }; return XO.apply(this, arguments); };
  XP.setRequestHeader = function (k, v) { if (this.__t2m) this.__t2m.headers[k] = v; return XH.apply(this, arguments); };
  XP.send = function (body) {
    try { if (this.__t2m) maybeCapture(this.__t2m.url, this.__t2m.method, this.__t2m.headers, body); } catch (e) { console.warn(NS, e); }
    return XS.apply(this, arguments);
  };

  /* ---------- replay ---------- */
  function epKeysOf(tpl) {
    const keys = [];
    const ep = tpl.epValue;
    if (tpl.bodyKind === 'form') tpl.body.forEach(([k, v]) => { if (v === ep && EP_KEY_RE.test(k)) keys.push(k); });
    if (tpl.bodyKind === 'text') {
      try {
        const walk = (o, path) => {
          if (o && typeof o === 'object') return Object.entries(o).forEach(([k, v]) => walk(v, path.concat(k)));
          if (String(o) === ep && EP_KEY_RE.test(path[path.length - 1] || '')) keys.push(path.join('.'));
        };
        walk(JSON.parse(tpl.body), []);
      } catch {
        new URLSearchParams(tpl.body).forEach((v, k) => { if (v === ep && EP_KEY_RE.test(k)) keys.push(k); });
      }
    }
    return keys;
  }

  function templateKeys(tpl) {
    if (tpl.bodyKind === 'form') return tpl.body.map(([k]) => k);
    if (tpl.bodyKind === 'text') {
      try { return Object.keys(JSON.parse(tpl.body)); } catch { return [...new URLSearchParams(tpl.body).keys()]; }
    }
    return [];
  }

  // keep: { fieldName: value } copied from your existing list entry (rating, dates, notes...) so updates don't wipe them
  // omit: field names to leave out of the request (used for updates so existing rating/notes/dates aren't sent)
  function buildRequest(tpl, id, ep, omit = []) {
    const idRe = new RegExp(`(^|\\D)${tpl.titleId}(?=\\D|$)`, 'g');
    const rep = (s) => String(s).replace(idRe, `$1${id}`);
    const epKeys = new Set(epKeysOf(tpl));
    const skip = new Set(omit);
    const swap = (k, v) => {
      if (epKeys.has(k)) return typeof v === 'number' ? Number(ep) : String(ep);
      if (String(v) === tpl.titleId) return typeof v === 'number' ? Number(id) : String(id);
      return typeof v === 'string' ? rep(v) : v;
    };
    const headers = { ...tpl.headers };
    delete headers['content-length']; delete headers['Content-Length'];
    let body = null;
    if (tpl.bodyKind === 'form') {
      body = new W.FormData();
      tpl.body.forEach(([k, v]) => { if (!skip.has(k)) body.append(k, swap(k, v)); });
    } else if (tpl.bodyKind === 'text') {
      try {
        const walk = (o, path) => {
          if (Array.isArray(o)) return o.map((v, i) => walk(v, path.concat(i)));
          if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k]) => !(path.length === 0 && skip.has(k))).map(([k, v]) => [k, walk(v, path.concat(k))]));
          return swap(path.join('.'), o);
        };
        body = JSON.stringify(walk(JSON.parse(tpl.body), []));
      } catch {
        const q = new URLSearchParams();
        new URLSearchParams(tpl.body).forEach((v, k) => { if (!skip.has(k)) q.append(k, swap(k, v)); });
        body = q.toString();
      }
    }
    return { url: rep(tpl.url), init: { method: tpl.method, headers, body, credentials: 'include' } };
  }

  /* ---------- status fix-up ---------- */
  function reconcile(r) {
    if (r.kind !== 'show' || r.statusManual) return;
    const c = (r.candidates || []).find((x) => x.id === r.choice);
    const total = c?.eps || 0;
    if (r.status === 'completed' && total && r.episodes < total) {
      r.status = 'watching';
      r.autoNote = `MDL lists ${total} eps, you watched ${r.episodes}`;
    } else if (r.autoNote && total && r.episodes >= total) {
      r.status = 'completed'; r.autoNote = '';
    }
  }

  /* ---------- pipeline ---------- */
  let busy = false;
  let stopFlag = false;
  const rowsInOrder = () => state.order.map((k) => state.rows[k]).filter(Boolean);

  function mergeTraktRows(fresh) {
    const v1 = state.v1rows || {};
    const keys = [];
    for (const f of fresh) {
      const old = state.rows[f.key];
      const r = old ? { ...old, ...f, autoNote: '' } : { ...f, candidates: null, choice: '', result: '', inList: null };
      if (old?.statusManual) { r.status = old.status; r.episodes = old.episodes; }
      // reuse a v1 match for single-season shows and movies
      if (!old && v1[f.slug] && (f.kind === 'movie' || f.seasonCount <= 1)) {
        const o = v1[f.slug];
        if (/^\d+$/.test(o.choice) || o.choice === 'skip') { r.choice = o.choice; r.candidates = o.candidates || []; }
      }
      reconcile(r);
      // you watched more since the last sync: let the list check decide whether an update is needed
      if (old && old.result === 'done' && (old.episodes !== r.episodes || old.status !== r.status)) r.result = '';
      state.rows[f.key] = r;
      keys.push(f.key);
    }
    state.order = keys.concat(state.order.filter((k) => !keys.includes(k) && state.rows[k]?.choice));
  }

  async function matchRows() {
    const todo = rowsInOrder().filter((r) => !r.candidates && r.choice !== 'skip');
    const byShow = new Map();
    todo.forEach((r) => { const k = r.kind === 'show' ? r.key.split(':')[0] : r.key; byShow.set(k, [...(byShow.get(k) || []), r]); });
    let n = 0;
    for (const group of byShow.values()) {
      if (stopFlag) return;
      n += 1;
      setStatus(`Searching MDL ${n}/${byShow.size}: ${group[0].title}`);
      const all = new Map();
      for (const q of [...new Set(group.flatMap((r) => r.queries))]) {
        try { (await searchMdl(q)).forEach((c) => all.set(c.id, c)); } catch (e) { group.forEach((r) => { r.result = `search error: ${e.message}`; }); }
        if (stopFlag) return;
      }
      const taken = new Set(rowsInOrder().filter((r) => /^\d+$/.test(r.choice)).map((r) => r.choice));
      for (const r of group.sort((a, b) => a.season - b.season)) {
        const cands = [...all.values()].map((c) => ({ ...c, score: scoreCandidate(r, c) }))
          .sort((a, b) => b.score - a.score).slice(0, 6);
        r.candidates = cands;
        const free = cands.filter((c) => !taken.has(c.id));
        const [a, b] = free;
        const auto = a && a.score >= AUTO_MIN_SCORE && (!b || a.score - b.score >= AUTO_MIN_GAP);
        r.choice = auto ? a.id : '';
        if (auto) taken.add(a.id);
        reconcile(r);
      }
      persist(); render();
    }
  }

  async function refreshListState() {
    const rows = rowsInOrder().filter((r) => /^\d+$/.test(r.choice));
    const inList = await checkInList(rows.map((r) => r.choice)).catch(() => null);
    if (!inList) return false;
    const tpl = state.templates.watching || state.templates.completed;
    const tKeys = tpl ? templateKeys(tpl) : [];
    const anyItem = Object.values(inList)[0];
    state.listFields = anyItem ? Object.keys(anyItem) : state.listFields;
    rows.forEach((r) => {
      const it = inList[r.choice];
      if (r.result === 'sent' || r.result === 'done') r.result = it ? 'done' : 'not added: request returned OK but title is not on your list';
      r.inList = it ? Number(it.status) : null;
      r.update = null;
      if (!it || Number(it.status) !== 1) return;            // only move "Watching" entries forward
      const prog = progressOf(it);
      const wantDone = r.status === 'completed';
      const behind = wantDone || (prog && r.episodes > prog.value);
      if (!behind) return;
      // Updates send only status + episodes; rating, notes, dates etc. are left out of the request entirely.
      r.update = { from: prog ? prog.value : '?', to: wantDone ? 'completed' : r.episodes, safe: true, omit: USERDATA_KEYS.filter((k) => tKeys.includes(k)) };
    });
    persist(); render();
    return true;
  }

  async function sendRows(rows, label) {
    let ok = 0, fail = 0;
    for (const r of rows) {
      if (stopFlag) break;
      const tpl = state.templates[r.status];
      const cand = (r.candidates || []).find((c) => c.id === r.choice);
      const ep = r.status === 'completed' ? (r.kind === 'movie' ? 1 : (cand?.eps || r.total || r.episodes)) : r.episodes;
      setStatus(`${label} ${ok + fail + 1}/${rows.length}: ${rowName(r)}`);
      try {
        const { url, init } = buildRequest(tpl, r.choice, ep, r.update?.omit || []);
        const res = await origFetch(url, init);
        const txt = await res.text().catch(() => '');
        if (res.ok) { r.result = 'sent'; ok += 1; }
        else { r.result = `HTTP ${res.status} ${txt.slice(0, 80)}`; fail += 1; }
        if ([401, 403, 419].includes(res.status)) { stopFlag = true; r.result += ' (auth/CSRF: re-capture)'; }
      } catch (e) { r.result = `error: ${e.message}`; fail += 1; }
      persist(); render();
      await sleep(jitter(IMPORT_DELAY_MS));
    }
    return { ok, fail };
  }

  function importable() {
    return rowsInOrder().filter((r) => /^\d+$/.test(r.choice) && !r.inList && !['done', 'sent'].includes(r.result));
  }
  const updatable = () => rowsInOrder().filter((r) => r.update?.safe && r.result !== 'sent');

  async function runSync() {
    if (busy) return;
    busy = true; stopFlag = false;
    try {
      setStatus('Fetching your watched history from Trakt…');
      const { rows, skipped } = await buildRowsFromTrakt(setStatus);
      mergeTraktRows(rows);
      state.skippedTrakt = skipped;
      state.traktInfo = traktInfo;
      persist(); render();
      await matchRows();
      if (stopFlag) { setStatus('Stopped.'); return; }
      setStatus('Checking your MDL list…');
      if (!(await refreshListState())) { setStatus('Could not read your MDL list (logged in?). Stopped before importing.'); return; }
      const missing = ['completed', 'watching'].filter((m) => !state.templates[m]);
      const adds = importable();
      const ups = updatable();
      if (missing.length && (adds.length || ups.length)) {
        setStatus(`Matched. Capture the "${missing.join('" and "')}" request first (buttons 2a/2b), then click Sync again.`);
        return;
      }
      const a = await sendRows(adds, 'Adding');
      const u = await sendRows(ups, 'Updating');
      setStatus('Verifying against your MDL list…');
      await refreshListState();
      const done = rowsInOrder().filter((r) => r.result === 'done').length;
      const notAdded = rowsInOrder().filter((r) => /^not added/.test(r.result)).length;
      const review = rowsInOrder().filter((r) => r.candidates && !/^\d+$/.test(r.choice) && r.choice !== 'skip').length;
      const manualUp = rowsInOrder().filter((r) => r.update && !r.update.safe).length;
      setStatus(`Sync done: ${a.ok} added, ${u.ok} updated, ${a.fail + u.fail} errors, ${notAdded} not confirmed. ${review} need review, ${manualUp} need a manual update. (${done} confirmed in total)`);
    } catch (e) {
      setStatus(`Sync failed: ${e.message}`);
    } finally {
      busy = false;
      persist(); render();
    }
  }

  function arm(mode) {
    const help = mode === 'completed'
      ? 'Open a DRAMA you have finished that is NOT on your list. Click "Add to List", choose Completed, keep Episodes Watched at the full count.\n\nEnter that Episodes Watched number:'
      : 'Open a DRAMA you are partway through that is NOT on your list. Click "Add to List", choose Currently Watching, set Episodes Watched to e.g. 3.\n\nEnter that number:';
    const v = W.prompt(help, mode === 'completed' ? '' : '3');
    if (v == null || !/^\d+$/.test(v.trim())) return;
    save(ARM, { mode, epValue: v.trim(), at: Date.now() });
    LS.removeItem(CANDS);
    toast(`Armed for "${mode}". Save a title to your list once.`);
    render();
  }

  function openSettings() {
    const s = getSettings();
    const id = W.prompt('Trakt Client ID (from trakt.tv/oauth/applications). Stored only in this browser:', s.clientId);
    if (id == null) return;
    const user = W.prompt('Trakt username:', s.username);
    if (user == null) return;
    save(SETTINGS, { clientId: id.trim(), username: user.trim() || 'akumaru' });
    toast('Settings saved.');
    render();
  }

  function exportCsv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['trakt_title', 'season', 'year', 'type', 'status', 'episodes', 'mdl_id', 'mdl_title', 'mdl_url', 'result'].join(',')];
    rowsInOrder().forEach((r) => {
      const c = (r.candidates || []).find((x) => x.id === r.choice);
      lines.push([r.title, r.season || '', r.seasonYear || r.year, r.kind, r.status, r.episodes, r.choice, c?.title, c?.url,
        r.result || (r.inList ? `on list: ${STATUS_NAMES[r.inList]}` : '')].map(esc).join(','));
    });
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = 'trakt2mdl-results.csv';
    a.click();
  }

  /* ---------- UI ---------- */
  let panel, statusEl, tbody;
  let filterVal = 'ALL';
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }
  function toast(msg) {
    const go = () => {
      const d = doc.createElement('div');
      d.className = `${NS}-toast`; d.textContent = msg;
      doc.body.appendChild(d);
      setTimeout(() => d.remove(), 6000);
    };
    doc.body ? go() : W.addEventListener('DOMContentLoaded', go);
  }
  const rowName = (r) => (r.kind === 'show' && r.seasonCount > 1 ? `${r.title} — Season ${r.season}` : r.title);

  function rowBadge(r) {
    if (r.result === 'done') return ['DONE', '#3fb950'];
    if (r.result === 'sent') return ['SENT (unverified)', '#d29922'];
    if (/^not added/.test(r.result || '')) return ['NOT ADDED', '#f85149'];
    if (r.result) return ['ERROR', '#f85149'];
    if (r.update) return [r.update.safe ? 'UPDATE' : 'BEHIND (manual)', r.update.safe ? '#58a6ff' : '#d29922'];
    if (r.inList) return [`ON LIST (${STATUS_NAMES[r.inList]})`, '#8b949e'];
    if (r.choice === 'skip') return ['SKIP', '#8b949e'];
    if (r.candidates && !r.candidates.length) return ['NO MATCH', '#d29922'];
    if (/^\d+$/.test(r.choice)) return ['READY', '#58a6ff'];
    if (r.candidates) return ['REVIEW', '#d29922'];
    return ['NEW', '#8b949e'];
  }

  function render() {
    if (!tbody || !state) return;
    tbody.innerHTML = '';
    const counts = {};
    rowsInOrder().forEach((r) => {
      const [label, color] = rowBadge(r);
      const group = label.split(' ')[0];
      counts[group] = (counts[group] || 0) + 1;
      if (filterVal !== 'ALL' && group !== filterVal) return;
      const tr = doc.createElement('tr');

      const tdT = doc.createElement('td');
      tdT.innerHTML = '<b></b><div></div>';
      tdT.querySelector('b').textContent = rowName(r);
      const sub = tdT.querySelector('div');
      sub.className = `${NS}-sub`;
      sub.textContent = r.kind === 'movie'
        ? `${r.year} · movie`
        : `${r.seasonYear || r.year} · ${r.seasonCount > 1 ? `season ${r.season} of ${r.seasonCount}` : 'show'} · Trakt watched ${r.watched}/${r.total || '?'} eps${r.airing ? ' · airing' : ''}${r.noEpisodeData ? ' · ⚠ no episode data from Trakt, check which season' : ''}${r.autoNote ? ` · → watching: ${r.autoNote}` : ''}`;

      const tdS = doc.createElement('td');
      const sel = doc.createElement('select');
      ['completed', 'watching'].forEach((s) => sel.add(new W.Option(s, s, false, r.status === s)));
      sel.onchange = () => { r.status = sel.value; r.statusManual = true; r.autoNote = ''; persist(); render(); };
      const ep = doc.createElement('input');
      ep.type = 'number'; ep.min = 0; ep.value = r.episodes; ep.title = 'Episodes watched';
      ep.onchange = () => { r.episodes = Number(ep.value) || 0; r.statusManual = true; persist(); };
      tdS.append(sel, ep);

      const tdM = doc.createElement('td');
      const cs = doc.createElement('select');
      cs.add(new W.Option(r.candidates ? '— choose —' : '(not searched)', ''));
      (r.candidates || []).forEach((c) => cs.add(new W.Option(`[${c.score}] ${c.title} (${c.meta || c.year})`, c.id, false, r.choice === c.id)));
      if (/^\d+$/.test(r.choice) && !(r.candidates || []).some((c) => c.id === r.choice)) cs.add(new W.Option(`custom #${r.choice}`, r.choice, false, true));
      cs.add(new W.Option('Paste MDL URL…', '__url'));
      cs.add(new W.Option('Skip this title', 'skip', false, r.choice === 'skip'));
      cs.onchange = () => {
        if (cs.value === '__url') {
          const id = idFromHref(W.prompt('Paste the MDL title URL (e.g. https://mydramalist.com/12345-title):'));
          if (id) r.choice = id;
        } else r.choice = cs.value;
        r.inList = null; r.result = ''; r.update = null;
        reconcile(r);
        persist(); render();
      };
      const link = doc.createElement('a');
      link.textContent = '↗'; link.target = '_blank';
      const cur = (r.candidates || []).find((c) => c.id === r.choice);
      link.href = cur?.url || (/^\d+$/.test(r.choice) ? `https://mydramalist.com/${r.choice}` : `https://mydramalist.com/search?q=${encodeURIComponent(r.queries[0])}`);
      tdM.append(cs, link);

      const tdR = doc.createElement('td');
      const b = doc.createElement('span');
      b.className = `${NS}-badge`; b.style.background = color; b.textContent = label;
      tdR.append(b);
      const why = r.result && r.result !== 'done' ? r.result
        : r.update ? `MDL ${r.update.from} → ${r.update.to}` : '';
      if (why) {
        const d = doc.createElement('div');
        d.className = `${NS}-sub`; d.style.maxWidth = '260px'; d.style.wordBreak = 'break-word';
        d.textContent = why;
        tdR.append(d);
      }
      tr.append(tdT, tdS, tdM, tdR);
      tbody.append(tr);
    });

    const info = panel.querySelector(`.${NS}-tpl`);
    const armed = load(ARM, null);
    const st = getSettings();
    info.innerHTML = '';
    const line = (t, color) => { const d = doc.createElement('div'); d.textContent = t; if (color) d.style.color = color; info.append(d); return d; };
    line(st.clientId ? `Trakt: ${st.username} · Client ID set` : 'Trakt: no Client ID yet. Click Settings.', st.clientId ? '' : '#d29922');
    ['completed', 'watching'].forEach((m) => {
      const tpl = state.templates[m];
      if (tpl) {
        const ek = epKeysOf(tpl);
        line(`✔ ${m}: ${tpl.method} ${tpl.url.replace(/https:\/\/[^/]+/, '')} | episode field: ${ek.length ? ek.join(', ') : 'NOT FOUND'}`);
      } else line(`✘ ${m}: not captured${armed?.mode === m ? ` (ARMED, waiting for a save with Episodes Watched = ${armed.epValue})` : ''}`, '#d29922');
    });
    if (state.traktInfo) line(state.traktInfo);
    if (state.listFields) line(`MDL list fields: ${state.listFields.join(', ')}`);
    const cands = armed ? load(CANDS, []) : [];
    if (armed && cands.length) {
      line(`Requests seen while armed (none had an episode field = ${armed.epValue}). Pick the one sent when you clicked Save:`, '#d29922');
      cands.forEach((c, i) => {
        const d = doc.createElement('div');
        const use = doc.createElement('button');
        use.textContent = 'Use'; use.dataset.cand = String(i); use.className = `${NS}-mini`;
        const t = doc.createElement('span');
        t.textContent = ` ${c.tpl.method} ${c.tpl.url.replace(/https:\/\/[^/]+/, '')}  ${c.bodyText}`;
        d.append(use, t);
        info.append(d);
      });
    }
    if (armed) {
      const c = doc.createElement('button');
      c.textContent = 'Cancel capture'; c.dataset.a = 'cancel-arm'; c.className = `${NS}-mini`;
      info.append(c);
    }

    const order = ['READY', 'UPDATE', 'BEHIND', 'REVIEW', 'NO', 'NEW', 'SENT', 'DONE', 'NOT', 'ERROR', 'ON', 'SKIP'];
    const names = { NO: 'NO MATCH', NOT: 'NOT ADDED', ON: 'ON LIST', BEHIND: 'BEHIND' };
    const fsel = panel.querySelector(`.${NS}-filter`);
    fsel.innerHTML = '';
    fsel.add(new W.Option(`Show: all (${state.order.length})`, 'ALL', false, filterVal === 'ALL'));
    order.filter((k) => counts[k]).forEach((k) => fsel.add(new W.Option(`${names[k] || k} (${counts[k]})`, k, false, filterVal === k)));
    panel.querySelector(`.${NS}-counts`).textContent = order.filter((k) => counts[k]).map((k) => `${names[k] || k}: ${counts[k]}`).join('  ·  ')
      + (state.skippedTrakt?.length ? `  ·  not Asian live-action (ignored): ${state.skippedTrakt.length}` : '');
  }

  function buildUi() {
    state = getState();
    persist();
    const style = doc.createElement('style');
    style.textContent = `
      .${NS}-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#1f6feb;color:#fff;border:0;border-radius:20px;padding:9px 14px;font:600 13px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
      .${NS}-panel{position:fixed;inset:3vh 3vw;z-index:2147483647;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:10px;display:none;flex-direction:column;font:13px/1.4 system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
      .${NS}-panel.open{display:flex}
      .${NS}-bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px;border-bottom:1px solid #30363d;align-items:center}
      .${NS}-bar button,.${NS}-mini{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit}
      .${NS}-mini{padding:1px 8px;margin:2px 4px 2px 0}
      .${NS}-bar button.primary{background:#238636;border-color:#2ea043}
      .${NS}-tpl{padding:6px 10px;font:11px/1.5 ui-monospace,monospace;color:#8b949e;border-bottom:1px solid #30363d;word-break:break-all}
      .${NS}-status{padding:6px 10px;color:#58a6ff}
      .${NS}-counts{padding:0 10px 6px;color:#8b949e;font-size:12px}
      .${NS}-wrap{overflow:auto;flex:1}
      .${NS}-panel table{width:100%;border-collapse:collapse}
      .${NS}-panel td{border-top:1px solid #21262d;padding:6px 8px;vertical-align:top}
      .${NS}-panel select,.${NS}-panel input{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:3px;font:inherit;max-width:420px}
      .${NS}-panel input[type=number]{width:56px;margin-left:4px}
      .${NS}-panel a{color:#58a6ff;margin-left:6px;text-decoration:none}
      .${NS}-sub{color:#8b949e;font-size:11px}
      .${NS}-badge{color:#0d1117;font-weight:700;font-size:11px;padding:2px 6px;border-radius:4px;white-space:nowrap}
      .${NS}-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;background:#238636;color:#fff;padding:10px 16px;border-radius:8px;font:600 13px system-ui}
    `;
    doc.head.append(style);

    const fab = doc.createElement('button');
    fab.className = `${NS}-fab`; fab.textContent = 'Trakt → MDL';
    panel = doc.createElement('div');
    panel.className = `${NS}-panel`;
    panel.innerHTML = `
      <div class="${NS}-bar">
        <b style="margin-right:8px">Trakt → MDL</b>
        <button data-a="sync" class="primary">⟳ Sync from Trakt</button>
        <button data-a="stop">Stop</button>
        <button data-a="settings">Settings</button>
        <button data-a="arm-completed">Capture "Completed"</button>
        <button data-a="arm-watching">Capture "Watching"</button>
        <button data-a="recheck">Re-check my list</button>
        <button data-a="csv">Export CSV</button>
        <button data-a="retry">Clear captures &amp; failed</button>
        <button data-a="reset">Reset all</button>
        <select class="${NS}-filter" title="Filter rows"></select>
        <span style="flex:1"></span>
        <button data-a="close">✕</button>
      </div>
      <div class="${NS}-tpl"></div>
      <div class="${NS}-status">Click "Sync from Trakt".</div>
      <div class="${NS}-counts"></div>
      <div class="${NS}-wrap"><table><tbody></tbody></table></div>`;
    statusEl = panel.querySelector(`.${NS}-status`);
    tbody = panel.querySelector('tbody');
    panel.querySelector(`.${NS}-filter`).addEventListener('change', (e) => { filterVal = e.target.value; render(); });
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.cand != null) {
        const c = load(CANDS, [])[Number(btn.dataset.cand)];
        if (c && W.confirm(`Use this request as the "${c.tpl.mode}" template?\n\n${c.tpl.method} ${c.tpl.url}\n${c.bodyText}`)) acceptTemplate(c.tpl);
        return;
      }
      const a = btn.dataset.a;
      if (a === 'close') panel.classList.remove('open');
      if (a === 'sync') runSync();
      if (a === 'stop') { stopFlag = true; setStatus('Stopping after current item…'); }
      if (a === 'settings') openSettings();
      if (a === 'arm-completed') arm('completed');
      if (a === 'arm-watching') arm('watching');
      if (a === 'cancel-arm') { LS.removeItem(ARM); LS.removeItem(CANDS); render(); }
      if (a === 'csv') exportCsv();
      if (a === 'recheck' && !busy) {
        busy = true; setStatus('Checking your MDL list…');
        refreshListState().then((ok) => setStatus(ok ? 'List checked.' : 'Could not read your MDL list (logged in?).')).finally(() => { busy = false; });
      }
      if (a === 'retry' && W.confirm('Clear both captured requests and all failed/unverified results? Matches are kept.')) {
        state.templates = {};
        rowsInOrder().forEach((r) => { if (r.result && r.result !== 'done') r.result = ''; });
        LS.removeItem(ARM); LS.removeItem(CANDS);
        persist(); render();
      }
      if (a === 'reset' && W.confirm('Clear all rows, matches, captured requests and results? (Settings are kept)')) {
        [STORE, STORE_V1, ARM, CANDS, SEASON_CACHE].forEach((k) => LS.removeItem(k));
        state = getState(); persist(); render();
      }
    });
    fab.onclick = () => { panel.classList.toggle('open'); render(); };
    doc.body.append(fab, panel);
    render();
  }

  if (doc.body && doc.readyState !== 'loading') buildUi();
  else W.addEventListener('DOMContentLoaded', buildUi, { once: true });

  W.__trakt2mdl = { parseSearch, scoreCandidate, seasonNumOf, buildRequest, epKeysOf, buildRowsFromTrakt, getState: () => state };
})();
