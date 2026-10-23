// Leaderboard screen. Three data sources, picked at open time:
//  - server:  the backend's verified boards (GET /v1/leaderboard).
//  - shared:  the published artifact's shared database (claude.ai only). Each tester writes their own row; scores
//             are reported by the device, so the page says they're unverified.
//  - local:   nothing to compare with; shows the player's own standing.

import { REGIONS, fmtPoints, halfPoints, regionName, seasonEnd, seasonId } from './social.js';

const BOARDS = ['season', 'lifetime', 'prestige', 'precision'];
const TIE = 1e12;
const SHARED_COLLECTION = 'board';
/** Server pages are reused briefly, so flicking between tabs and regions costs no extra requests. */
const CACHE_MS = 15_000;

/**
 * `deps.me()` returns the player's current standing:
 *   { online, name, region, lifetime: {perfects, cleans, closes}, prestige, rating, season: {id, half} }
 * `deps.onRegion(code)` and `deps.onReroll()` change it (and resolve to an error message or null).
 */
export function createBoards(deps) {
  const { api, store, $ } = deps;
  const state = { board: store.get('board', 'season'), region: store.get('boardRegion', 'GLOBAL'), shared: null, sharedRows: null };
  if (!BOARDS.includes(state.board)) state.board = 'season';
  if (state.region !== 'GLOBAL' && !REGIONS.some((r) => r.code === state.region)) state.region = 'GLOBAL';
  let request = 0;
  const cache = new Map();

  // Region chips and the region picker.
  const chips = $('board-regions');
  for (const r of [{ code: 'GLOBAL', name: 'Global' }, ...REGIONS]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.region = r.code;
    b.textContent = r.name.toUpperCase();
    b.addEventListener('click', () => select({ region: r.code }));
    chips.append(b);
  }
  const picker = $('board-region');
  for (const r of [{ code: '', name: 'Choose a region' }, ...REGIONS]) picker.add(new Option(r.name, r.code));
  picker.addEventListener('change', async () => {
    const msg = await deps.onRegion(picker.value || null);
    cache.clear();
    $('board-region-note').textContent = msg ?? '';
    renderYou();
    load();
  });
  for (const b of document.querySelectorAll('.board-tabs button')) b.addEventListener('click', () => select({ board: b.dataset.board }));
  $('board-reroll').addEventListener('click', async () => {
    const msg = await deps.onReroll();
    cache.clear();
    $('board-region-note').textContent = msg ?? '';
    renderYou();
    load();
  });

  function select(next) {
    Object.assign(state, next);
    store.set('board', state.board);
    store.set('boardRegion', state.region);
    load();
  }

  function renderChrome() {
    for (const b of document.querySelectorAll('.board-tabs button')) b.setAttribute('aria-checked', String(b.dataset.board === state.board));
    for (const b of chips.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.region === state.region));
    const now = new Date();
    const days = Math.max(1, Math.ceil((seasonEnd(now) - now) / 86_400_000));
    $('board-eyebrow').textContent =
      state.board === 'season' ? `SEASON ${seasonId(now)} · ENDS IN ${days} DAY${days > 1 ? 'S' : ''}` : 'ALL TIME';
    $('board-note').textContent = {
      season: 'Points from Ranked this month: PERFECT 2, CLEAN 1.5, SO CLOSE 1. Slow-Mo rings never count.',
      lifetime: 'Points from every Ranked run: PERFECT 2, CLEAN 1.5, SO CLOSE 1. Slow-Mo rings never count.',
      prestige: 'Highest Prestige level. Ties go to lifetime points.',
      precision: 'Precision rating from Ranked runs. Ties go to lifetime points.',
    }[state.board];
  }

  function renderYou() {
    const me = deps.me();
    $('board-name').textContent = me.name;
    picker.value = me.region ?? '';
  }

  function formatValue(board, value, points) {
    if (board === 'prestige') return value >= 100 ? 'ZERO' : `LVL ${value}`;
    if (board === 'precision') return String(value);
    return `${fmtPoints(points)} pts`;
  }

  function row(e) {
    const li = document.createElement('li');
    li.className = `board-row${e.isMe ? ' mine' : ''}`;
    li.dataset.rank = String(e.rank);
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${e.rank}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = e.isMe ? `${e.name} (you)` : e.name;
    const reg = document.createElement('span');
    reg.className = 'reg';
    reg.textContent = e.region ?? '';
    reg.title = e.region ? regionName(e.region) : '';
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = formatValue(state.board, e.value, e.points);
    li.append(rank, who, reg, val);
    return li;
  }

  function show(result, status) {
    const list = $('board-list');
    list.textContent = '';
    for (const e of result.entries) list.append(row(e));
    const meEl = $('board-me');
    const meVisible = result.me && !result.entries.some((e) => e.isMe);
    meEl.hidden = !meVisible;
    if (meVisible) meEl.replaceChildren(...row(result.me).childNodes);
    $('board-status').textContent = status ?? (result.entries.length ? '' : 'No scores here yet. Play Ranked to get on the board.');
  }

  /** The player's own row, computed the same way as the server's scores. */
  function myScore(board) {
    const me = deps.me();
    const life = halfPoints(me.lifetime);
    if (board === 'season') return { value: me.season.half, points: me.season.half, score: me.season.half };
    if (board === 'lifetime') return { value: life, points: life, score: life };
    const value = board === 'prestige' ? me.prestige : me.rating;
    return { value, points: life, score: value * TIE + Math.min(life, TIE - 1) };
  }

  async function load() {
    renderChrome();
    renderYou();
    const ticket = ++request;
    const me = deps.me();
    if (me.online) {
      const key = `${state.board}:${state.region}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return show(hit.res, null);
      $('board-status').textContent = 'Loading…';
      try {
        const res = await api.request('GET', `/v1/leaderboard?board=${state.board}&region=${state.region}&limit=100`);
        cache.set(key, { at: Date.now(), res });
        if (ticket === request) show(res, null);
      } catch (e) {
        if (ticket === request) show({ entries: [], me: null }, `Couldn't load the leaderboard (${e.code ?? 'network_error'}).`);
      }
      return;
    }
    const shared = await sharedBoard();
    if (ticket !== request) return;
    if (shared) {
      const rows = await shared.rows();
      if (ticket !== request) return;
      if (rows) return show(rank(rows, shared.myId), 'Test board: scores come from each player’s device and aren’t server-verified.');
    }
    const mine = myScore(state.board);
    const self = { rank: 1, name: me.name, region: me.region, ...mine, isMe: true };
    show({ entries: [], me: self }, 'Leaderboards need the game server. This shows your own score on this device.');
  }

  /** Ranks shared rows like the server: shared ranks on ties, filtered by region. */
  function rank(rows, myId) {
    const season = seasonId(new Date());
    const scored = rows
      .filter((r) => state.region === 'GLOBAL' || r.region === state.region)
      .map((r) => {
        const life = Number(r.lifetimeHalf) || 0;
        const seasonHalf = r.seasonId === season ? Number(r.seasonHalf) || 0 : 0;
        const v = state.board === 'prestige' ? Number(r.prestige) || 0 : Number(r.rating) || 0;
        const s =
          state.board === 'season'
            ? { value: seasonHalf, points: seasonHalf, score: seasonHalf }
            : state.board === 'lifetime'
              ? { value: life, points: life, score: life }
              : { value: v, points: life, score: v * TIE + Math.min(life, TIE - 1) };
        return { id: r.id, name: typeof r.name === 'string' ? r.name.slice(0, 40) : 'Player', region: r.region ?? null, ...s };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    let rankNo = 0;
    const entries = scored.map((r, i) => {
      if (i === 0 || r.score !== scored[i - 1].score) rankNo = i + 1;
      return { rank: rankNo, name: r.name, region: r.region, value: r.value, points: r.points, isMe: r.id === myId };
    });
    return { entries: entries.slice(0, 100), me: entries.find((e) => e.isMe) ?? null };
  }

  /** The artifact's shared database, or null outside claude.ai. Resolved once, never on first paint. */
  async function sharedBoard() {
    if (state.shared !== null) return state.shared || null;
    state.shared = false;
    const use = window.claude?.use;
    if (typeof use !== 'function') return null;
    try {
      const [db, user] = await Promise.all([use('db'), use('user')]);
      const myId = user ? await user.id() : null;
      if (!db) return null;
      state.shared = {
        myId,
        async rows() {
          try {
            const snap = await db.collection(SHARED_COLLECTION).limit(1000).get();
            return snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }));
          } catch {
            return null;
          }
        },
        async write(row) {
          if (!myId) return;
          try {
            await db.doc(`${SHARED_COLLECTION}/${myId}`).set(row);
          } catch {
            // View-only viewers can't write; the board stays read-only for them.
          }
        },
      };
    } catch {
      return null;
    }
    return state.shared;
  }

  let writing = Promise.resolve();
  return {
    open() {
      load();
    },
    /** A verified run changed the standings. */
    invalidate() {
      cache.clear();
    },
    /** After an offline Ranked run (or a name/region change): publish this device's row to the shared board. */
    publishShared() {
      writing = writing.then(async () => {
        const shared = await sharedBoard();
        if (!shared) return;
        const me = deps.me();
        await shared.write({
          name: me.name,
          region: me.region,
          lifetimeHalf: halfPoints(me.lifetime),
          prestige: me.prestige,
          rating: me.rating,
          seasonId: me.season.id,
          seasonHalf: me.season.half,
          updatedAt: new Date().toISOString(),
        });
      });
      return writing;
    },
  };
}
