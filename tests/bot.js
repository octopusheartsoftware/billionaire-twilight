// A simple bot that plays Billionaire Twilight through a player's private view.
// It heads for its nearest uncollected resource, then home; detours for hinted
// neighbors; places traps/operatives at ports or random regions; fires Space Rays
// at a random continent and sends Seductresses at a random rival.
export function botAction(M, view, rnd = Math.random) {
  const me = view.players[view.pid];
  if (view.canEnd) return { end: true };
  const place = choosePlacement(M, view, rnd);
  if (me.sea || view.frozen > 0) return { place };
  const pos = me.pos;
  const D = (a, b) => M.D[M.idx[a]][M.idx[b]];
  const remaining = Object.entries(view.resources).filter(([c]) => !view.have.includes(+c)).map(([, r]) => r);
  const target = remaining.length ? remaining.reduce((best, r) => (D(pos, r) < D(pos, best) ? r : best)) : me.home;
  const cands = M.R[pos].adj.map(r => ({ move: r, cost: 1 + D(r, target) }));
  for (const rt of M.routesAt[pos] || []) {
    const dest = rt.a === pos ? rt.b : rt.a;
    cands.push({ move: "route:" + rt.id, cost: rt.turns + 1 + D(dest, target) });
  }
  // avoid stepping into regions holding my own traps unless it's the only way
  const best = Math.min(...cands.map(c => c.cost));
  const hinted = cands.filter(c => view.hints.includes(c.move) && c.cost - best <= 2);
  let pool = hinted.length && rnd() < 0.8 ? hinted : cands.filter(c => c.cost === best);
  const safe = pool.filter(c => !view.myTraps.includes(c.move));
  if (safe.length) pool = safe;
  return { move: pool[Math.floor(rnd() * pool.length)].move, place };
}

function choosePlacement(M, view, rnd) {
  const rivals = view.players.filter(p => p.id !== view.pid).map(p => p.id);
  if (view.seducers > 0 && rnd() < 0.5) return { kind: "seduce", target: rivals[Math.floor(rnd() * rivals.length)] };
  if (view.rays > 0 && rnd() < 0.5) return { kind: "ray", cont: Math.floor(rnd() * 7) };
  const ports = Object.keys(M.routesAt);
  const r = () => (rnd() < 0.5 ? ports[Math.floor(rnd() * ports.length)] : M.ids[Math.floor(rnd() * M.ids.length)]);
  if (view.traps > 0 && rnd() < 0.6) {
    const region = r();
    if (!view.myTraps.includes(region)) return { kind: "trap", region };
  }
  if (view.ops > 0) return { kind: "op", region: r() };
  return null;
}
