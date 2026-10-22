// Plays many bot games straight through the rules engine and checks invariants.
import { GAMEMAP } from "../engine/gamemap.js";
import * as R from "../engine/rules.js";
import { botAction } from "./bot.js";

const M = R.prepareMap(GAMEMAP);
const games = +(process.argv[2] || 300), players = +(process.argv[3] || 4);
const turns = [], fails = [];
const stats = { trapFires: 0, selfTraps: 0, assigns: 0, correct: 0, pings: 0, bunkers: 0, rays: 0, seduced: 0, trades: 0, rayEarned: 0, seductressEarned: 0, frozenMoves: 0 };
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

for (let n = 0; n < games; n++) {
  const g = R.newGame(M, Array.from({ length: players }, (_, i) => "P" + i), { seed: n + 1 });
  g.players.forEach(p => {
    if (Object.keys(p.resources).length !== 7) fails.push("resources not dealt");
    if (p.tour < R.TOUR_BAND[0] || p.tour > R.TOUR_BAND[1]) fails.push(`tour out of band: ${p.tour}`);
  });
  if (g.idents.length !== players * 3 * R.IDENT_COPIES) fails.push("wrong identifier count");
  let guard = 0;
  while (!g.over && guard++ < 600) {
    const acts = {};
    for (const id of R.expectedIds(g)) {
      const v = R.playerView(M, g, id, false);
      const a = botAction(M, v, rnd);
      const checked = R.checkAction(M, g, g.players[id], a);
      if (typeof checked === "string") { fails.push(`rejected bot action: ${checked} ${JSON.stringify(a)}`); continue; }
      acts[id] = checked;
      for (const h of v.held) {
        if (rnd() < 0.3 && R.pingIdent(g, id, h.id, Date.now() + guard * 10000).ok) stats.pings++;
        if (rnd() < 0.15 && !h.mine) {
          const ident = g.idents.find(i => i.id === h.id);
          const target = rnd() < 0.5 ? ident.owner : g.players.find(q => q.id !== id && q.id !== ident.owner)?.id ?? ident.owner;
          const res = R.assignIdent(g, id, h.id, target);
          if (res.ok) { stats.assigns++; if (res.correct) stats.correct++; }
        }
      }
      // trading: offer, and answer any open offer
      if (v.held.length && rnd() < 0.1) {
        const t = g.players.find(q => q.id !== id && rnd() < 0.5);
        if (t) R.offerTrade(g, id, t.id, v.held[0].id, Date.now());
      }
      const open = g.trades.find(t => t.status === "open" && t.to === id);
      if (open) {
        const mine = g.players[id].held;
        if (mine.length && rnd() < 0.6) { if (R.answerTrade(g, id, open.id, mine[0]).ok) stats.trades++; }
        else R.closeTrade(g, id, open.id);
      }
    }
    for (const p of g.players) if (p.frozen > 0 && acts[p.id] && acts[p.id].move) fails.push("frozen player was asked to move");
    const before = g.players.map(p => p.pos);
    const frozenNow = g.players.map(p => p.frozen > 0 && !p.sea);
    R.resolveTurn(M, g, acts);
    g.players.forEach((p, i) => { if (frozenNow[i] && p.pos !== before[i]) fails.push("a seduced player moved"); });
  }
  if (!g.over) { fails.push("game did not finish"); continue; }
  turns.push(g.turn); stats.trapFires += g.trapFires;
  for (const p of g.players) for (const r of p.report) {
    if (r.kind === "rayfired") stats.rays++;
    if (r.kind === "seduced" && /keeping/.test(r.text)) stats.seduced++;
    if (r.kind === "rayearned") stats.rayEarned++;
    if (r.kind === "trapfired") stats.seductressEarned++;
    if (r.kind === "trapped" && /own trap/.test(r.text)) stats.selfTraps++;
    if (r.kind === "bunker") stats.bunkers++;
    if (r.kind === "frozen") stats.frozenMoves++;
  }
  const v = R.playerView(M, g, 0, false);
  v.players.forEach(p => { if (p.id !== 0 && (p.pos !== null || p.sea !== null)) fails.push("view leaked a rival position"); });
}
turns.sort((a, b) => a - b);
const q = f => turns[Math.floor(f * (turns.length - 1))];
const per = k => +(stats[k] / games).toFixed(1);
console.log(JSON.stringify({ games, players, turns_p10: q(0.1), turns_median: q(0.5), turns_p90: q(0.9),
  perGame: Object.fromEntries(Object.keys(stats).map(k => [k, per(k)])),
  failures: fails.length, firstFailures: [...new Set(fails)].slice(0, 6) }));
