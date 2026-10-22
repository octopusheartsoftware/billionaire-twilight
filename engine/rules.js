// Billionaire Twilight rules engine.
// Pure game logic, shared by the server function and the bot tests.
// The whole game state is plain JSON so it can be stored in the database.

export const COLORS = [
  { name: "Red", hex: "#ef5a5a" }, { name: "Blue", hex: "#4d9bf0" },
  { name: "Green", hex: "#4cc38a" }, { name: "Amber", hex: "#f2b33d" },
  { name: "Violet", hex: "#a77cf0" }, { name: "Cyan", hex: "#3fd0d4" },
  { name: "Pink", hex: "#f07cc0" },
];
export const MAX_PLAYERS = 7;
export const TRAP_CHANCE = [0, 0.25, 0.45, 0.58, 0.68, 0.75, 0.80, 0.80]; // 7 traps = same as 6
export const ITEMS_PER_PLAYER = 5;      // operatives and traps each, lying on the map
export const INVENTORY_CAP = 3;
export const FACE_COUNT = 14;
export const VOICE_COUNT = 7;
export const IDENT_COPIES = 3;          // copies of each passport, face and voice on the map
export const RAY_POINTS = 3;            // operative spots needed for a Space Ray
export const SEDUCE_TURNS = 2;
export const TOUR_BAND = [61, 63];      // balanced dealing: best tour length in turns (median deal)
export const PING_COOLDOWN_MS = 5000;
const KINDS = ["passport", "face", "voice"];
const CONT_NAMES = ["Northern Americas", "Southern Americas", "Africa", "Europe", "Russia/North Asia", "Southern/East Asia", "Australia"];

// ------------------------------------------------------------ map helpers
export function prepareMap(GM) {
  const idx = {}; GM.regions.forEach((r, i) => idx[r.id] = i);
  const routesAt = {}; const routeById = {};
  GM.routes.forEach(rt => {
    routeById[rt.id] = rt;
    (routesAt[rt.a] ||= []).push(rt); (routesAt[rt.b] ||= []).push(rt);
  });
  const byCont = GM.continents.map((_, c) => GM.regions.filter(r => r.c === c).map(r => r.id));
  const R = Object.fromEntries(GM.regions.map(r => [r.id, r]));
  // all-pairs travel time in turns: a land move is 1, a ship route is its turns + 1 for boarding
  const n = GM.regions.length, D = [];
  for (let s = 0; s < n; s++) {
    const dist = new Array(n).fill(1e9); dist[s] = 0;
    const done = new Array(n).fill(false);
    for (;;) {
      let u = -1, best = 1e9;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = true;
      const r = GM.regions[u];
      for (const v of r.adj) { const j = idx[v]; if (best + 1 < dist[j]) dist[j] = best + 1; }
      for (const rt of routesAt[r.id] || []) {
        const j = idx[rt.a === r.id ? rt.b : rt.a], w = best + rt.turns + 1;
        if (w < dist[j]) dist[j] = w;
      }
    }
    D.push(dist);
  }
  return { GM, R, idx, routesAt, routeById, byCont, D, ids: GM.regions.map(r => r.id) };
}
const dist = (M, a, b) => M.D[M.idx[a]][M.idx[b]];

// ------------------------------------------------------------ randomness (seeded, stored in state)
function rand(g) {
  g.rs = (g.rs + 1831565813) >>> 0;
  let t = g.rs; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr, g) => arr[Math.floor(rand(g) * arr.length)];
function shuffle(arr, g) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand(g) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function uid(g) { return Math.floor(rand(g) * 2 ** 32).toString(36) + Math.floor(rand(g) * 2 ** 32).toString(36); }

// ------------------------------------------------------------ dealing
export function bestTour(M, start, targets, home) {
  const k = targets.length; if (!k) return dist(M, start, home);
  const best = new Map();
  targets.forEach((t, i) => best.set((1 << i) * 8 + i, dist(M, start, t)));
  for (let mask = 1; mask < 1 << k; mask++) for (let last = 0; last < k; last++) {
    const c = best.get(mask * 8 + last); if (c === undefined) continue;
    for (let nx = 0; nx < k; nx++) {
      if (mask & (1 << nx)) continue;
      const key = (mask | (1 << nx)) * 8 + nx, v = c + dist(M, targets[last], targets[nx]);
      if (!best.has(key) || v < best.get(key)) best.set(key, v);
    }
  }
  let out = 1e9; const full = (1 << k) - 1;
  for (let l = 0; l < k; l++) out = Math.min(out, best.get(full * 8 + l) + dist(M, targets[l], home));
  return out;
}
function blockedNear(M, g) {
  const bad = new Set();
  g.players.forEach(p => { if (!p.sea) { bad.add(p.pos); M.R[p.pos].adj.forEach(a => bad.add(a)); } });
  return bad;
}
function spawnItem(M, g, kind) {
  const bad = blockedNear(M, g);
  const free = M.ids.filter(r => !bad.has(r));
  const r = pick(free.length ? free : M.ids, g);
  (g.items[r] ||= []).push(kind);
}

export function newGame(M, names, opts = {}) {
  const g = {
    rs: (opts.seed == null ? Math.floor(Math.random() * 4294967296) : opts.seed) >>> 0,
    turn: 1, players: [], items: {}, idents: [], traps: {}, trapLog: [], operatives: [],
    publicLog: [], history: [], pings: [], trades: [], over: false, winner: null, draw: false, trapFires: 0, seq: 0,
  };
  const conts = shuffle([0, 1, 2, 3, 4, 5, 6], g).slice(0, names.length);
  const faces = shuffle([...Array(FACE_COUNT).keys()], g);
  const voices = shuffle([...Array(VOICE_COUNT).keys()], g);
  g.players = names.map((name, i) => {
    const home = pick(M.byCont[conts[i]], g);
    return {
      id: i, name, color: COLORS[i].hex, homeCont: conts[i], home, pos: home, sea: null,
      resources: {}, have: [], seventhAt: null, canEnd: false,
      ops: 0, traps: 0, rays: 0, rayPoints: 0, seducers: 0, frozen: 0,
      held: [], taken: [], assigned: {}, intel: {}, bunkerKnown: {}, report: [], lastPing: {},
      sprites: { passport: conts[i], face: faces[i], voice: voices[i] },
    };
  });
  const starts = new Set();
  g.players.forEach(p => { starts.add(p.home); M.R[p.home].adj.forEach(a => starts.add(a)); });
  // balanced dealing: reroll each player's resources until their best tour is in the band
  g.players.forEach(p => {
    for (let attempt = 0; attempt < 400; attempt++) {
      for (let c = 0; c < 7; c++) p.resources[c] = pick(M.byCont[c].filter(r => !starts.has(r)), g);
      p.tour = bestTour(M, p.home, Object.values(p.resources), p.home);
      if (p.tour >= TOUR_BAND[0] && p.tour <= TOUR_BAND[1]) break;
    }
  });
  for (let i = 0; i < ITEMS_PER_PLAYER * names.length; i++) { spawnItem(M, g, "op"); spawnItem(M, g, "trap"); }
  g.players.forEach(p => KINDS.forEach(kind => {
    for (let c = 0; c < IDENT_COPIES; c++) {
      g.idents.push({ id: uid(g), owner: p.id, kind, sprite: p.sprites[kind],
        region: pick(M.ids.filter(r => !starts.has(r)), g) });
    }
  }));
  g.history.push(snapshot(g));
  return g;
}

// ------------------------------------------------------------ queries
export function canMove(p) { return !p.sea && p.frozen <= 0; }
const hasItems = p => p.ops + p.traps + p.rays + p.seducers > 0;
export function legalMoves(M, g, p) {
  if (!canMove(p)) return { regions: [], routes: [] };
  return { regions: M.R[p.pos].adj.slice(), routes: (M.routesAt[p.pos] || []).map(rt => rt.id) };
}
// players who must confirm this turn: anyone who can move, and anyone who could use an item
export function expectedIds(g) {
  return g.players.filter(p => canMove(p) || hasItems(p) || p.canEnd).map(p => p.id);
}
const nameOf = (g, id) => g.players[id].name;
const rname = (M, r) => M.R[r].n;
const knowsFace = (g, viewer, target) => g.players[viewer].assigned[target]?.face != null;
const knowsVoice = (g, viewer, target) => g.players[viewer].assigned[target]?.voice != null;
const REPORT_CAP = 100;
function note(g, pid, entry) {
  const r = g.players[pid].report;
  r.push({ seq: g.seq = (g.seq || 0) + 1, turn: g.turn, ...entry });
  if (r.length > REPORT_CAP) r.splice(0, r.length - REPORT_CAP);
}
function pub(g, entry) {
  g.publicLog.push({ seq: g.seq = (g.seq || 0) + 1, turn: g.turn, public: true, ...entry });
  if (g.publicLog.length > REPORT_CAP) g.publicLog.splice(0, g.publicLog.length - REPORT_CAP);
}
// replay: per turn, [pos or null at sea, route or null, resources held]
function snapshot(g) {
  return { t: g.turn, p: g.players.map(p => [p.sea ? null : p.pos, p.sea ? p.sea.route : null, p.have.length]) };
}

// ------------------------------------------------------------ validation (used by the server on submit)
export function checkAction(M, g, p, a) {
  const out = { move: null, place: null, end: false };
  if (a.end) { if (!p.canEnd) return "You can only end the world from your bunker with all 7 resources."; out.end = true; }
  if (canMove(p) && !out.end) {
    const lm = legalMoves(M, g, p);
    if (lm.regions.includes(a.move)) out.move = a.move;
    else if (typeof a.move === "string" && a.move.startsWith("route:") && lm.routes.includes(a.move.slice(6))) out.move = a.move;
    else return "That move is not allowed. Pick a highlighted neighbor or a ship route from your port.";
  }
  if (a.place) {
    const pl = a.place;
    if (pl.kind === "op" || pl.kind === "trap") {
      if (!M.R[pl.region]) return "Pick a region on the map for your item.";
      if (pl.kind === "op" && p.ops < 1) return "You have no operatives to place.";
      if (pl.kind === "trap" && p.traps < 1) return "You have no traps to place.";
      if (pl.kind === "trap" && (g.traps[pl.region] || []).includes(p.id)) return "You already have a trap there.";
      out.place = { kind: pl.kind, region: pl.region };
    } else if (pl.kind === "ray") {
      if (p.rays < 1) return "You have no Space Ray.";
      const c = Number(pl.cont); if (!(c >= 0 && c < 7)) return "Pick a continent for the Space Ray.";
      out.place = { kind: "ray", cont: c };
    } else if (pl.kind === "seduce") {
      if (p.seducers < 1) return "You have no Seductress.";
      const t = Number(pl.target); if (!g.players[t] || t === p.id) return "Pick a rival for the Seductress.";
      out.place = { kind: "seduce", target: t };
    } else return "Unknown item.";
  }
  return out;
}

// ------------------------------------------------------------ resolution: one turn
export function resolveTurn(M, g, actions) {
  if (g.over) return;
  const T = g.turn;
  const acts = {};
  // 1. fill missing actions
  for (const p of g.players) {
    let a = actions[p.id];
    if (!a || typeof a !== "object") a = {};
    if (!actions[p.id] && p.canEnd) a = { end: true };            // the button presses itself
    if (canMove(p) && !a.end && !a.move) {
      const lm = legalMoves(M, g, p);
      a = { move: lm.regions.length ? pick(lm.regions, g) : "route:" + pick(lm.routes, g), random: true };
      note(g, p.id, { kind: "timeout", region: a.move.startsWith("route:") ? null : a.move,
        text: a.move.startsWith("route:") ? "Time ran out. You boarded a ship at random." : `Time ran out. You were moved to ${rname(M, a.move)}.` });
    }
    acts[p.id] = a;
  }
  // 2. items: operatives, traps, Space Rays, Seductresses
  const frozenConts = new Set();
  for (const p of g.players) {
    const pl = acts[p.id].place; if (!pl) continue;
    if (pl.kind === "op" && p.ops > 0) {
      g.operatives.push({ owner: p.id, region: pl.region, turn: T }); p.ops -= 1;
      note(g, p.id, { kind: "placed", region: pl.region, text: `Your operative is in place in ${rname(M, pl.region)}.` });
    } else if (pl.kind === "trap" && p.traps > 0 && !(g.traps[pl.region] || []).includes(p.id)) {
      (g.traps[pl.region] ||= []).push(p.id); p.traps -= 1;
      g.trapLog.push({ owner: p.id, region: pl.region, turn: T });
      note(g, p.id, { kind: "placed", region: pl.region, text: `Your trap is set in ${rname(M, pl.region)}.` });
    } else if (pl.kind === "ray" && p.rays > 0) {
      p.rays -= 1; frozenConts.add(pl.cont);
      note(g, p.id, { kind: "rayfired", cont: pl.cont, text: `You fired your Space Ray at ${CONT_NAMES[pl.cont]}.` });
    } else if (pl.kind === "seduce" && p.seducers > 0) {
      const q = g.players[pl.target];
      p.seducers -= 1; q.frozen = Math.max(q.frozen, SEDUCE_TURNS);
      note(g, p.id, { kind: "seduced", who: q.id, text: `Your Seductress is keeping ${q.name} busy for ${SEDUCE_TURNS} turns.` });
      note(g, q.id, { kind: "seduced", who: p.id, text: `${p.name}'s Seductress has you distracted. You can't move this turn or next.` });
    }
  }
  [...frozenConts].forEach(c => pub(g, { kind: "ray", cont: c,
    text: `A Space Ray hit ${CONT_NAMES[c]}. Nobody there could move this turn.` }));
  // end the world
  const enders = g.players.filter(p => acts[p.id].end && p.canEnd);
  if (enders.length) {
    const first = Math.min(...enders.map(p => p.seventhAt));
    const w = enders.filter(p => p.seventhAt === first);
    g.over = true;
    if (w.length === 1) { g.winner = w[0].id; pub(g, { kind: "win", who: w[0].id, text: `${w[0].name} ended the world from their bunker in ${rname(M, w[0].home)}.` }); }
    else { g.draw = true; pub(g, { kind: "draw", text: "Two billionaires ended the world at the same moment. It's a draw." }); }
    g.history.push(snapshot(g));
    return;
  }
  // 3. move
  const attempts = [];
  for (const p of g.players) {
    const a = acts[p.id];
    if (p.sea) {
      if (T >= p.sea.arrive) {
        if (p.frozen > 0) note(g, p.id, { kind: "frozen", text: "Your ship is holding offshore while you're distracted." });
        else attempts.push({ p, to: p.sea.dest, arriving: true });
      }
      continue;
    }
    if (p.frozen > 0) continue;                       // seduced: already told
    if (frozenConts.has(M.R[p.pos].c)) {
      note(g, p.id, { kind: "frozen", region: p.pos, text: `A Space Ray froze you in ${rname(M, p.pos)}. You couldn't move this turn.` });
      continue;
    }
    if (!a.move) continue;
    if (a.move.startsWith("route:")) {
      const rt = M.routeById[a.move.slice(6)];
      const dest = rt.a === p.pos ? rt.b : rt.a;
      p.sea = { route: rt.id, dest, from: p.pos, arrive: T + rt.turns };
      note(g, p.id, { kind: "board", text: `You boarded a ship on the ${rt.name} route to ${rname(M, dest)}. Arrival: turn ${T + rt.turns}.` });
      continue;
    }
    attempts.push({ p, to: a.move });
  }
  // 4. traps roll (your own traps can stop you too; 7 traps act like 6)
  const entered = [];
  for (const { p, to, arriving } of attempts) {
    const owners = g.traps[to] || [];
    if (owners.length && rand(g) < TRAP_CHANCE[Math.min(owners.length, 7)]) {
      g.trapFires += 1;
      const own = owners.includes(p.id);
      note(g, p.id, { kind: "trapped", region: to, text: arriving
        ? `A trap held your ship off ${rname(M, to)}. It will try again next turn.`
        : own && owners.length === 1 ? `Your own trap held you at the ${rname(M, to)} border.`
        : `A trap held you at the ${rname(M, to)} border.` });
      owners.filter(o => o !== p.id).forEach(o => {
        g.players[o].seducers += 1;
        const named = knowsFace(g, o, p.id);
        note(g, o, { kind: "trapfired", region: to, who: named ? p.id : null,
          text: `Your trap in ${rname(M, to)} held ${named ? p.name : "someone"}. You earned a Seductress.` });
      });
      continue;
    }
    p.pos = to; if (arriving) { p.sea = null; note(g, p.id, { kind: "arrive", region: to, text: `Your ship arrived in ${rname(M, to)}.` }); }
    entered.push(p);
  }
  // 5. pick up and respawn
  for (const p of entered) {
    const r = p.pos;
    for (const [c, reg] of Object.entries(p.resources)) {
      if (reg === r && !p.have.includes(+c)) {
        p.have.push(+c);
        pub(g, { kind: "collect", who: p.id, cont: +c, text: `${p.name} collected the ${M.GM.continents[c].resource}.` });
        if (p.have.length === 7) p.seventhAt = T;
      }
    }
    const it = g.items[r] || [];
    for (const kind of it.slice()) {
      if (kind === "op" && p.ops < INVENTORY_CAP) { it.splice(it.indexOf(kind), 1); p.ops += 1; note(g, p.id, { kind: "pickup", text: `You picked up an operative in ${rname(M, r)}.` }); spawnItem(M, g, "op"); }
      else if (kind === "trap" && p.traps < INVENTORY_CAP) { it.splice(it.indexOf(kind), 1); p.traps += 1; note(g, p.id, { kind: "pickup", text: `You picked up a trap in ${rname(M, r)}.` }); spawnItem(M, g, "trap"); }
    }
    if (!it.length) delete g.items[r];
    for (const ident of g.idents.filter(i => i.region === r && i.owner !== p.id && !p.taken.includes(i.id))) {
      p.taken.push(ident.id); p.held.push(ident.id);
      note(g, p.id, { kind: "pickup", text: `You found a ${ident.kind} in ${rname(M, r)}. Tap it to make its owner's phone react.` });
    }
    // walking into a rival's bunker marks it for you
    for (const q of g.players) {
      if (q !== p && q.home === r && !p.bunkerKnown[q.id]) {
        p.bunkerKnown[q.id] = r;
        note(g, p.id, { kind: "bunker", region: r, who: q.id, text: `You found ${q.name}'s bunker in ${rname(M, r)}.` });
      }
    }
  }
  // 6. operatives report, and earn Space Ray points
  const spottedBy = new Set(), pointsFor = new Set();
  for (const o of g.operatives) {
    const vision = new Set([o.region, ...M.R[o.region].adj]);
    const opCont = M.R[o.region].c;
    for (const q of g.players) {
      if (q.id === o.owner || q.sea) continue;
      if (vision.has(q.pos)) {
        const named = knowsFace(g, o.owner, q.id);
        note(g, o.owner, { kind: "sighting", region: q.pos, op: o.region, who: named ? q.id : null,
          text: named ? `Your operative in ${rname(M, o.region)} saw ${q.name} in ${rname(M, q.pos)}.`
                      : `Your operative in ${rname(M, o.region)} saw someone in ${rname(M, q.pos)}.` });
        if (named) (g.players[o.owner].intel[q.id] ||= {}).seen = { region: q.pos, turn: T };
        const key = q.id + ":" + o.owner;
        if (!spottedBy.has(key)) {
          spottedBy.add(key);
          note(g, q.id, { kind: "spotted", who: o.owner, text: `You were spotted by ${nameOf(g, o.owner)}'s operative.` });
        }
        if (!pointsFor.has(key)) {                    // one point per rival spotted, per turn
          pointsFor.add(key);
          const own = g.players[o.owner];
          own.rayPoints += 1;
          if (own.rayPoints >= RAY_POINTS) { own.rayPoints -= RAY_POINTS; own.rays += 1;
            note(g, own.id, { kind: "rayearned", text: "Your operatives have spotted 3 rivals. You earned a Space Ray." }); }
        }
      } else if (knowsVoice(g, o.owner, q.id) && M.R[q.pos].c === opCont) {
        const intel = (g.players[o.owner].intel[q.id] ||= {});
        if (!(intel.heard && intel.heard.turn === T)) {
          intel.heard = { cont: opCont, turn: T };
          note(g, o.owner, { kind: "voice", who: q.id, cont: opCont,
            text: `Your operatives heard ${q.name}'s voice somewhere in ${M.GM.continents[opCont].name}.` });
        }
      }
    }
  }
  // 7. same-region sightings
  for (const p of g.players) {
    if (p.sea) continue;
    for (const q of g.players) {
      if (q === p || q.sea || q.pos !== p.pos) continue;
      const named = knowsFace(g, p.id, q.id);
      note(g, p.id, { kind: "together", region: p.pos, who: named ? q.id : null,
        text: named ? `${q.name} is here with you in ${rname(M, p.pos)}.` : `Someone else is here with you in ${rname(M, p.pos)}.` });
      if (named) (p.intel[q.id] ||= {}).seen = { region: p.pos, turn: T };
    }
  }
  // 8. bunker check, freezes wear off, next turn
  for (const p of g.players) {
    const was = p.canEnd;
    p.canEnd = !p.sea && p.pos === p.home && p.have.length === 7;
    if (p.canEnd && !was) note(g, p.id, { kind: "ready", text: "You're in your bunker with all 7 resources. End the world." });
    if (p.frozen > 0) p.frozen -= 1;
  }
  g.turn += 1;
  g.history.push(snapshot(g));
}

// ------------------------------------------------------------ immediate actions (any time during play)
export function assignIdent(g, pid, identId, targetId) {
  const p = g.players[pid];
  if (!p.held.includes(identId)) return { error: "You don't hold that identifier." };
  const ident = g.idents.find(i => i.id === identId);
  if (targetId === pid || !g.players[targetId]) return { error: "Drop it on a rival." };
  if (p.assigned[targetId]?.[ident.kind] != null) return { error: `You already know ${g.players[targetId].name}'s ${ident.kind}.` };
  p.held = p.held.filter(i => i !== identId);
  cancelTradesWith(g, identId);
  if (ident.owner === targetId) {
    (p.assigned[targetId] ||= {})[ident.kind] = ident.sprite;
    const unlock = { passport: `${g.players[targetId].name}'s bunker is somewhere in this continent.`,
      face: `Your operatives will now name ${g.players[targetId].name}.`,
      voice: `Your operatives will now hear ${g.players[targetId].name} anywhere on their continent.` }[ident.kind];
    note(g, pid, { kind: "assign", who: targetId, text: `Match! That ${ident.kind} belongs to ${g.players[targetId].name}. ${unlock}` });
    return { ok: true, correct: true };
  }
  note(g, pid, { kind: "assign", text: `Wrong person. That ${ident.kind} is gone for good.` });
  return { ok: true, correct: false };
}

export function pingIdent(g, pid, identId, now) {
  const p = g.players[pid];
  if (!p.held.includes(identId)) return { error: "You don't hold that identifier." };
  const last = p.lastPing[identId] || 0;
  if (now - last < PING_COOLDOWN_MS) return { error: "Wait a moment before tapping it again.", wait: PING_COOLDOWN_MS - (now - last) };
  p.lastPing[identId] = now;
  const ident = g.idents.find(i => i.id === identId);
  g.pings.push({ to: ident.owner, kind: ident.kind, at: now });
  if (g.pings.length > 40) g.pings = g.pings.slice(-40);
  return { ok: true };
}

// trades: one player offers an identifier, the other answers with one of theirs or says no
function cancelTradesWith(g, identId) {
  g.trades.filter(t => t.status === "open" && t.give === identId).forEach(t => { t.status = "cancelled"; });
}
export function offerTrade(g, pid, targetId, identId, now) {
  const p = g.players[pid], q = g.players[targetId];
  if (!q || q === p) return { error: "Pick a rival to trade with." };
  if (!p.held.includes(identId)) return { error: "Offer one of your identifiers." };
  if (g.trades.some(t => t.status === "open" && (t.from === pid || t.to === pid))) return { error: "Finish your open trade first." };
  if (g.trades.some(t => t.status === "open" && (t.from === targetId || t.to === targetId))) return { error: `${q.name} is already in a trade. Try again in a moment.` };
  const t = { id: uid(g), from: pid, to: targetId, give: identId, status: "open", at: now };
  g.trades.push(t);
  if (g.trades.length > 30) g.trades = g.trades.slice(-30);
  return { ok: true, trade: t.id };
}
export function answerTrade(g, pid, tradeId, identId) {
  const t = g.trades.find(x => x.id === tradeId);
  if (!t || t.status !== "open") return { error: "That trade is no longer open." };
  if (t.to !== pid) return { error: "That trade isn't yours to answer." };
  const from = g.players[t.from], to = g.players[t.to];
  if (!from.held.includes(t.give)) { t.status = "cancelled"; return { error: `${from.name} no longer has that identifier.` }; }
  if (!to.held.includes(identId)) return { error: "Offer one of your identifiers." };
  from.held = from.held.filter(i => i !== t.give); from.held.push(identId);
  to.held = to.held.filter(i => i !== identId); to.held.push(t.give);
  t.get = identId; t.status = "done";
  const gk = g.idents.find(i => i.id === t.give).kind, rk = g.idents.find(i => i.id === identId).kind;
  note(g, from.id, { kind: "trade", who: to.id, text: `Trade done: you gave ${to.name} a ${gk} and got a ${rk}.` });
  note(g, to.id, { kind: "trade", who: from.id, text: `Trade done: you gave ${from.name} a ${rk} and got a ${gk}.` });
  return { ok: true };
}
export function closeTrade(g, pid, tradeId) {
  const t = g.trades.find(x => x.id === tradeId);
  if (!t || t.status !== "open") return { ok: true };
  if (t.to === pid) { t.status = "rejected"; note(g, t.from, { kind: "trade", who: pid, text: `${g.players[pid].name} turned down your trade.` }); return { ok: true }; }
  if (t.from === pid) { t.status = "cancelled"; return { ok: true }; }
  return { error: "That trade isn't yours." };
}

// ------------------------------------------------------------ what one player may see
export function playerView(M, g, pid, revealAll) {
  const me = pid != null ? g.players[pid] : null;
  const identInfo = id => { const i = g.idents.find(x => x.id === id); return { id, kind: i.kind, sprite: i.sprite, mine: me ? i.owner === me.id : false }; };
  const hints = [];
  if (me && !me.sea) {
    for (const r of M.R[me.pos].adj) {
      const it = g.items[r] || [];
      const id = g.idents.some(i => i.region === r && i.owner !== me.id && !me.taken.includes(i.id));
      if (it.length || id) hints.push(r);
    }
  }
  const players = g.players.map(p => {
    const mine = me && p.id === me.id;
    const a = me ? me.assigned[p.id] || {} : {};
    const intel = me ? me.intel[p.id] || {} : {};
    return {
      id: p.id, name: p.name, color: p.color, have: p.have.slice(),
      pos: revealAll || mine ? p.pos : null, sea: revealAll || mine ? p.sea : null,
      frozen: revealAll || mine ? p.frozen : undefined,
      home: revealAll || mine ? p.home : (me && me.bunkerKnown[p.id]) || null,
      homeCont: revealAll || mine || a.passport != null ? p.homeCont : null,
      slots: revealAll ? p.sprites : mine ? null : { passport: a.passport ?? null, face: a.face ?? null, voice: a.voice ?? null },
      seen: intel.seen || null, heard: intel.heard || null,
    };
  });
  const v = { turn: g.turn, over: g.over, winner: g.winner, draw: g.draw, players };
  if (me) Object.assign(v, {
    pid, resources: me.resources, have: me.have, canEnd: me.canEnd, frozen: me.frozen,
    ops: me.ops, traps: me.traps, rays: me.rays, rayPoints: me.rayPoints, seducers: me.seducers,
    held: me.held.map(identInfo),
    myOperatives: g.operatives.filter(o => o.owner === me.id).map(o => o.region),
    myTraps: Object.entries(g.traps).filter(([, os]) => os.includes(me.id)).map(([r]) => r),
    hints, tour: me.tour, mySprites: me.sprites,
    report: [...me.report, ...g.publicLog].sort((a, b) => a.seq - b.seq).slice(-200),
    pings: g.pings.filter(x => x.to === me.id),
    trades: g.trades.filter(t => t.from === me.id || t.to === me.id).slice(-6).map(t => ({
      id: t.id, from: t.from, to: t.to, status: t.status, at: t.at,
      give: identInfo(t.give), get: t.get ? identInfo(t.get) : null })),
  });
  if (revealAll) Object.assign(v, {
    allTraps: g.traps, trapLog: g.trapLog, allOperatives: g.operatives, items: g.items,
    idents: g.idents, allResources: g.players.map(p => p.resources), history: g.history,
  });
  return v;
}
