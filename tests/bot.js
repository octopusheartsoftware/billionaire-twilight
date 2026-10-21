// A simple bot that plays Billionaire Twilight through a player's private view.
// It plans toward its nearest uncollected resource, then home; detours for green
// hints; places traps/operatives at random ports; assigns identifiers it holds
// (correctly half the time, to exercise both outcomes); pings them too.
export function botAction(M, view, rnd = Math.random) {
  const me = view.players[view.pid];
  if (view.canEnd) return { end: true };
  const place = view.step === 1 ? choosePlacement(M, view, rnd) : null;
  if (me.sea) return { place };
  const pos = me.pos;
  const D = (a, b) => M.D[M.idx[a]][M.idx[b]];
  const remaining = Object.entries(view.resources).filter(([c]) => !view.have.includes(+c)).map(([, r]) => r);
  const target = remaining.length ? remaining.reduce((best, r) => (D(pos, r) < D(pos, best) ? r : best)) : me.home;
  const cands = M.R[pos].adj.map(r => ({ move: r, cost: 1 + D(r, target) }));
  for (const rt of M.routesAt[pos] || []) {
    const dest = rt.a === pos ? rt.b : rt.a;
    cands.push({ move: "route:" + rt.id, cost: 2 * rt.turns + (view.step === 1 ? 1 : 0) + D(dest, target) });
  }
  const best = Math.min(...cands.map(c => c.cost));
  const hinted = cands.filter(c => view.hints.includes(c.move) && c.cost - best <= 2);
  const pool = hinted.length && rnd() < 0.8 ? hinted : cands.filter(c => c.cost === best);
  return { move: pool[Math.floor(rnd() * pool.length)].move, place };
}

function choosePlacement(M, view, rnd) {
  const ports = Object.keys(M.routesAt);
  const r = () => (rnd() < 0.5 ? ports[Math.floor(rnd() * ports.length)] : M.ids[Math.floor(rnd() * M.ids.length)]);
  if (view.traps > 0 && rnd() < 0.6) {
    const region = r();
    if (!view.myTraps.includes(region)) return { kind: "trap", region };
  }
  if (view.ops > 0) return { kind: "op", region: r() };
  return null;
}
