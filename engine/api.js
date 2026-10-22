// Billionaire Twilight game API: rooms, lobby, timers and private views.
// handle(body, db) is called by the Supabase function (and by local tests).
import { GAMEMAP } from "./gamemap.js";
import * as R from "./rules.js";

export const M = R.prepareMap(GAMEMAP);
const TIMER_CHOICES = [30, 45, 60, 0];
const GRACE_MS = 1200;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const turnMs = data => { const t = data.timer ?? 30; return t ? t * 1000 : 0; };

class Fail extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (m, s) => { throw new Fail(m, s); };
const cleanName = n => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 14);
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const token = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

function me(data, tok) {
  const p = data.lobby.find(x => x.token === tok);
  if (!p) fail("You are not in this game. Join again with the room code.", 403);
  return p;
}

function resolveNow(data, now) {
  R.resolveTurn(M, data.game, data.actions || {});
  data.actions = {};
  // when nobody has anything to do (everyone at sea or frozen, with no items), play on
  let guard = 0;
  while (!data.game.over && !R.expectedIds(data.game).length && guard++ < 20) R.resolveTurn(M, data.game, {});
  if (data.game.over) { data.deadline = null; return "over"; }
  data.deadline = turnMs(data) ? now + turnMs(data) : null;
  return "playing";
}
function maybeTimeout(row, now) {
  if (row.status !== "playing" || !row.data.deadline) return null;
  if (now < row.data.deadline + GRACE_MS) return null;
  return resolveNow(row.data, now);
}
function allIn(data) {
  const waiting = R.expectedIds(data.game).filter(id => !(id in (data.actions || {})));
  return !waiting.length;
}

function buildView(row, tok, now) {
  const data = row.data;
  const meP = data.lobby.find(x => x.token === tok);
  const base = {
    code: row.code, status: row.status, version: row.version, me: meP ? meP.id : null, host: data.host,
    timer: data.timer ?? 30, lobby: data.lobby.map(p => ({ id: p.id, name: p.name, ready: !!p.ready })),
  };
  if (!data.game) return base;
  const pid = meP ? meP.pid : null;
  const v = R.playerView(M, data.game, pid, row.status === "over");
  return {
    ...base, ...v,
    msLeft: data.deadline ? Math.max(0, data.deadline - now) : null,
    expected: R.expectedIds(data.game),
    submitted: Object.keys(data.actions || {}).map(Number),
    myAction: pid != null ? (data.actions || {})[pid] || null : null,
  };
}

const handlers = {
  join(row, b) {
    if (row.status !== "lobby") fail("That game has already started.");
    if (row.data.lobby.length >= R.MAX_PLAYERS) fail("That room is full. Seven players is the limit.");
    const name = cleanName(b.name);
    if (!name) fail("Enter a name first.");
    if (row.data.lobby.some(p => p.name.toLowerCase() === name.toLowerCase())) fail(`Someone in this room is already called ${name}. Pick another name.`);
    const t = token();
    const id = (row.data.nextId = (row.data.nextId || row.data.lobby.length) + 1) - 1;
    row.data.lobby.push({ id, name, token: t, ready: false });
    return { token: t };
  },
  name(row, b) {
    if (row.status !== "lobby") fail("Names are locked once the game starts.");
    const p = me(row.data, b.token);
    const name = cleanName(b.name);
    if (!name) fail("Enter a name first.");
    if (row.data.lobby.some(q => q !== p && q.name.toLowerCase() === name.toLowerCase())) fail(`Someone in this room is already called ${name}. Pick another name.`);
    p.name = name;
  },
  timer(row, b) {
    if (row.status !== "lobby") fail("The timer is locked once the game starts.");
    const p = me(row.data, b.token);
    if (p.id !== row.data.host) fail("Only the host can change the timer.", 403);
    const t = Number(b.timer);
    if (!TIMER_CHOICES.includes(t)) fail("Pick 30, 45 or 60 seconds, or no timer.");
    row.data.timer = t;
  },
  ready(row, b) {
    if (row.status !== "lobby") fail("The game has already started.");
    me(row.data, b.token).ready = !!b.ready;
  },
  leave(row, b) {
    if (row.status !== "lobby") fail("You can only leave from the lobby.");
    const p = me(row.data, b.token);
    row.data.lobby = row.data.lobby.filter(q => q !== p);
    if (row.data.host === p.id && row.data.lobby.length) row.data.host = row.data.lobby[0].id;
  },
  start(row, b, now) {
    if (row.status !== "lobby") fail("The game has already started.");
    const p = me(row.data, b.token);
    if (p.id !== row.data.host) fail("Only the host can start the game.", 403);
    const L = row.data.lobby;
    if (L.length < 2) fail("You need at least 2 players.");
    if (!L.every(q => q.ready)) fail("Everyone has to tap Ready first.");
    row.data.game = R.newGame(M, L.map(q => q.name));
    L.forEach((q, i) => (q.pid = i));
    row.data.actions = {};
    row.data.deadline = turnMs(row.data) ? now + turnMs(row.data) : null;
    row.status = "playing";
  },
  submit(row, b, now) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const g = row.data.game;
    if (b.turn !== g.turn) fail("That turn has already ended.", 409);
    if (!R.expectedIds(g).includes(p.pid)) fail("You have nothing to do this turn.");
    const a = R.checkAction(M, g, g.players[p.pid], { move: b.move, place: b.place || null, end: !!b.end });
    if (typeof a === "string") fail(a);
    (row.data.actions ||= {})[p.pid] = a;
    if (allIn(row.data)) row.status = resolveNow(row.data, now);
  },
  unsubmit(row, b) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const g = row.data.game;
    if (b.turn !== g.turn) fail("That turn has already ended.", 409);
    if (row.data.actions) delete row.data.actions[p.pid];
  },
  trade(row, b, now) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const r = R.offerTrade(row.data.game, p.pid, Number(b.target), String(b.ident), now);
    if (r.error) fail(r.error);
  },
  tradeanswer(row, b) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const r = R.answerTrade(row.data.game, p.pid, String(b.trade), String(b.ident));
    if (r.error) fail(r.error);
  },
  tradeclose(row, b) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const r = R.closeTrade(row.data.game, p.pid, String(b.trade));
    if (r.error) fail(r.error);
  },
  assign(row, b) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const r = R.assignIdent(row.data.game, p.pid, String(b.ident), Number(b.target));
    if (r.error) fail(r.error);
    return { correct: r.correct };
  },
  ping(row, b, now) {
    if (row.status !== "playing") fail("The game is not running.");
    const p = me(row.data, b.token);
    const r = R.pingIdent(row.data.game, p.pid, String(b.ident), now);
    if (r.error) fail(r.error, 429);
  },
};

export async function handle(body, db, now = Date.now()) {
  try {
    const action = body && body.action;
    if (action === "create") {
      const name = cleanName(body.name);
      if (!name) fail("Enter a name first.");
      const t = token();
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const row = { code, version: 1, status: "lobby", data: { host: 0, nextId: 1, timer: 30, lobby: [{ id: 0, name, token: t, ready: false }] } };
        if (await db.insert(code, row)) return { status: 200, json: { ok: true, token: t, view: buildView(row, t, now) } };
      }
      fail("Could not create a room. Try again.", 500);
    }
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length !== 4) fail("Room codes are 4 letters.");
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await db.load(code);
      if (!row) fail(`No room called ${code}. Check the code with your host.`, 404);
      const v0 = row.version;
      let extra = {}, changed = false;
      const ts = maybeTimeout(row, now);
      if (ts) { row.status = ts; changed = true; }
      if (action === "view") { /* read only */ }
      else if (handlers[action]) {
        if ((action === "submit" || action === "unsubmit") && ts) extra = { late: true };
        else { extra = handlers[action](row, body, now) || {}; changed = true; }
      } else fail("Unknown action.");
      if (changed) {
        row.version = v0 + 1;
        const ok = await db.update(code, row, v0);
        if (!ok) continue;                       // someone else wrote first: retry on fresh data
      }
      const tok = extra.token || body.token;
      if (extra.late) return { status: 409, json: { ok: false, error: "Time ran out before your move arrived. You were moved at random.", view: buildView(row, tok, now) } };
      return { status: 200, json: { ok: true, ...extra, view: buildView(row, tok, now) } };
    }
    fail("The server was busy. Try again.", 503);
  } catch (e) {
    if (e instanceof Fail) return { status: e.status, json: { ok: false, error: e.message } };
    return { status: 500, json: { ok: false, error: "Something went wrong on the server.", detail: String(e && e.message || e) } };
  }
}
