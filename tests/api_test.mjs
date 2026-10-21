// Full games through the API with an in-memory database, like phones would play.
import { handle, M } from "../engine/api.js";
import { botAction } from "./bot.js";

function memDb() {
  const rows = new Map();
  return {
    rows,
    async load(code) { const r = rows.get(code); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async insert(code, row) { if (rows.has(code)) return false; rows.set(code, JSON.parse(JSON.stringify(row))); return true; },
    async update(code, row, expected) {
      const cur = rows.get(code); if (!cur || cur.version !== expected) return false;
      rows.set(code, JSON.parse(JSON.stringify(row))); return true;
    },
  };
}
const fails = [];
const expect = (cond, msg) => { if (!cond) fails.push(msg); };

async function playGame(nPlayers, { timeoutEvery = 0 } = {}) {
  const db = memDb();
  let now = Date.now();
  const call = async body => (await handle(body, db, now)).json;
  const host = await call({ action: "create", name: "Host" });
  expect(host.ok, "create failed");
  const code = host.view.code;
  const players = [{ token: host.token }];
  for (let i = 1; i < nPlayers; i++) {
    const j = await call({ action: "join", code, name: "Bot" + i });
    expect(j.ok, "join failed: " + j.error);
    players.push({ token: j.token });
  }
  const dup = await call({ action: "join", code, name: "bot1" });
  expect(!dup.ok && /already called/.test(dup.error), "duplicate name allowed");
  const early = await call({ action: "start", code, token: host.token });
  expect(!early.ok, "started before ready");
  for (const p of players) await call({ action: "ready", code, token: p.token, ready: true });
  const st = await call({ action: "start", code, token: host.token });
  expect(st.ok && st.view.status === "playing", "start failed: " + st.error);

  let view = st.view, steps = 0;
  while (view.status === "playing" && steps < 400) {
    steps++;
    const expected = view.expected;
    for (let k = 0; k < players.length; k++) {
      const v = (await call({ action: "view", code, token: players[k].token })).view;
      if (!expected.includes(v.pid)) continue;
      if (timeoutEvery && steps % timeoutEvery === 0 && k === 0) continue;   // let the timer run out
      // identifiers: occasionally ping and assign
      for (const h of v.held || []) {
        if (Math.random() < 0.3) await call({ action: "ping", code, token: players[k].token, ident: h.id });
        if (Math.random() < 0.15) {
          const target = v.players.filter(q => q.id !== v.pid)[Math.floor(Math.random() * (v.players.length - 1))].id;
          const r = await call({ action: "assign", code, token: players[k].token, ident: h.id, target });
          expect(r.ok, "assign failed: " + r.error);
        }
      }
      const a = botAction(M, v);
      const r = await call({ action: "submit", code, token: players[k].token, turn: v.turn, step: v.step, ...a });
      if (!r.ok && !/already ended/.test(r.error)) fails.push("submit rejected: " + r.error);
      // hidden info: a player never sees rivals' positions while playing
      if (r.ok && r.view.status === "playing") r.view.players.forEach(q => {
        if (q.id !== v.pid && (q.pos !== null || q.sea !== null)) fails.push("rival position leaked");
      });
    }
    view = (await call({ action: "view", code, token: host.token })).view;
    if (view.status === "playing" && timeoutEvery && steps % timeoutEvery === 0) {
      now += 31000 + 1300;                         // timer + grace passes
      view = (await call({ action: "view", code, token: host.token })).view;
    }
  }
  expect(view.status === "over", "game did not finish");
  expect(view.history && view.history.length > 10, "no replay history at the end");
  expect(view.winner !== null || view.draw, "no winner or draw");
  const size = JSON.stringify(db.rows.get(code)).length;
  return { turns: view.turn, steps, winner: view.winner, rowKB: Math.round(size / 1024) };
}

const results = [];
for (const n of [2, 4, 7]) results.push(await playGame(n));
results.push(await playGame(4, { timeoutEvery: 7 }));
console.log(JSON.stringify({ results, failures: fails.length, first: [...new Set(fails)].slice(0, 8) }, null, 1));
