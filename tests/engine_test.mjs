// Plays many bot games straight through the rules engine and checks invariants.
import { GAMEMAP } from "../engine/gamemap.js";
import * as R from "../engine/rules.js";
import { botAction } from "./bot.js";

const M = R.prepareMap(GAMEMAP);
const games = +(process.argv[2] || 300), players = +(process.argv[3] || 4);
const turns = [], fails = [];
let trapFires = 0, assigns = 0, correct = 0, reveals = 0, pings = 0;
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

for (let n = 0; n < games; n++) {
  const g = R.newGame(M, Array.from({ length: players }, (_, i) => "P" + i), { seed: n + 1 });
  // invariants at setup
  g.players.forEach(p => {
    if (Object.keys(p.resources).length !== 7) fails.push("resources not dealt");
    if (p.tour < R.TOUR_BAND[0] || p.tour > R.TOUR_BAND[1]) fails.push(`tour out of band: ${p.tour}`);
  });
  let guard = 0;
  while (!g.over && guard++ < 600) {
    const acts = {};
    for (const id of R.expectedIds(g)) {
      const v = R.playerView(M, g, id, false);
      const a = botAction(M, v, rnd);
      const checked = R.checkAction(M, g, g.players[id], a);
      if (typeof checked === "string") { fails.push(`rejected bot action: ${checked} ${JSON.stringify(a)}`); continue; }
      acts[id] = checked;
      // identifiers: ping and assign sometimes
      for (const h of v.held) {
        if (rnd() < 0.3) { const r = R.pingIdent(g, id, h.id, Date.now() + guard * 10000); if (r.ok) pings++; }
        if (rnd() < 0.2) {
          const ident = g.idents.find(i => i.id === h.id);
          const target = rnd() < 0.5 ? ident.owner : g.players.find(q => q.id !== id && q.id !== ident.owner)?.id ?? ident.owner;
          const res = R.assignIdent(g, id, h.id, target);
          if (res.ok) { assigns++; if (res.correct) correct++; }
        }
      }
    }
    R.resolveStep(M, g, acts);
  }
  if (!g.over) { fails.push("game did not finish"); continue; }
  turns.push(g.turn); trapFires += g.trapFires;
  reveals += g.players.reduce((s, p) => s + Object.keys(p.bunkerKnown).length, 0);
  // hidden info check: a living view never leaks rival positions
  const v = R.playerView(M, g, 0, false);
  v.players.forEach(p => { if (p.id !== 0 && (p.pos !== null || p.sea !== null)) fails.push("view leaked a rival position"); });
}
turns.sort((a, b) => a - b);
const q = f => turns[Math.floor(f * (turns.length - 1))];
console.log(JSON.stringify({ games, players, turns_p10: q(0.1), turns_median: q(0.5), turns_p90: q(0.9),
  trapFiresPerGame: +(trapFires / games).toFixed(1), assigns, correct, pings, bunkerReveals: reveals,
  failures: fails.length, firstFailures: [...new Set(fails)].slice(0, 5) }));
