// Floor Plan: scan rooms in AR (WebXR hit tests on the floor), turn the taps into a clean 2D plan, edit it, save it as a
// PDF. Everything happens on the phone; the only things fetched are this page and its two libraries.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);
const KEY = "floorplan-v2";

// ---------- the plan, kept on this phone ----------
// rooms: [{name, pts: [[x, y], ...], open: [edge indices with no wall]}] in metres, squared up; doors: [{room, edge, t,
// w}]: on that room's wall, centred at t (0 to 1 along it), w metres wide. A scan is cleaned up once, when it ends, and
// added to the plan; from then on the plan is what's edited.
let fp = load();

function load() {
  try {
    const v2 = JSON.parse(localStorage.getItem(KEY));
    if (v2 && v2.rooms) return v2;
    const v1 = JSON.parse(localStorage.getItem("floorplan-scan-v1"));  // the first version's raw scans
    if (v1 && v1.rooms && v1.rooms.length) {
      const plan = { rooms: [], doors: [] };
      for (let p = 0; p < (v1.parts || 1); p++) add(plan, v1.rooms.filter((r) => r.part === p), v1.doors.filter((d) => d.part === p));
      return plan;
    }
  } catch { /* nothing saved, or a private window */ }
  return { rooms: [], doors: [] };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(fp)); } catch { /* private window: the plan lives until the page closes */ }
}

// ---------- AR ----------
let renderer, scene, camera, reticle, group, hitSource = null, session = null;
let floorY = null, onFloor = false, doorMode = false, doorPts = [], current = [];
let live = { rooms: [], doors: [] };  // this scan's rooms and doorways, in the AR session's own frame
const at = new THREE.Vector3();

function setupThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.style.display = "none";
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 60);
  reticle = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.095, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  group = new THREE.Group();
  scene.add(reticle, group);
}

function line(points, color, closed = false) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, floorY + 0.005, z)));
  return new (closed ? THREE.LineLoop : THREE.Line)(geo, new THREE.LineBasicMaterial({ color }));
}
function dot([x, z], color, size = 0.035) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, floorY + size, z);
  return m;
}

function redraw() {
  group.clear();
  if (floorY === null) return;
  for (const r of live.rooms) {
    group.add(line(r.pts, 0x7fb6ff, true));
    r.pts.forEach((p) => group.add(dot(p, 0x7fb6ff, 0.025)));
  }
  for (const d of live.doors) group.add(line([d.a, d.b], 0x7dd38a));
  if (current.length) {
    group.add(line(current, 0xffb454));
    current.forEach((p) => group.add(dot(p, 0xffb454)));
  }
  doorPts.forEach((p) => group.add(dot(p, 0x7dd38a)));
}

const preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.05, gapSize: 0.04 }));

function onFrame(_, frame) {
  if (!frame || !hitSource) return renderer.render(scene, camera);
  const ref = renderer.xr.getReferenceSpace();
  onFloor = false;
  for (const hit of frame.getHitTestResults(hitSource)) {
    const m = hit.getPose(ref).transform.matrix;
    const flat = m[5] > 0.9;  // the surface's up axis points up: a floor (or a table top)
    const level = floorY === null || Math.abs(m[13] - floorY) < 0.2;  // at the floor's height, not a table
    if (flat && level) {
      reticle.matrix.fromArray(m);
      at.set(m[12], m[13], m[14]);
      onFloor = true;
      break;
    }
  }
  reticle.visible = onFloor;
  $("#add").disabled = !onFloor;
  const last = doorMode ? doorPts[doorPts.length - 1] : current[current.length - 1];
  scene.remove(preview);
  if (onFloor && last && floorY !== null) {
    preview.geometry.setFromPoints([new THREE.Vector3(last[0], floorY + 0.005, last[1]), new THREE.Vector3(at.x, floorY + 0.005, at.z)]);
    preview.computeLineDistances();
    scene.add(preview);
  }
  hint(last);
  renderer.render(scene, camera);
}

function hint(last) {
  const n = live.rooms.length;
  let h, s = `${n} room${n === 1 ? "" : "s"} in this scan`;
  if (!onFloor) h = floorY === null ? "Point at the floor and move slowly" : "Find the floor again (keep the ring on it)";
  else if (doorMode) h = doorPts.length ? "Now tap the other side of the doorway" : "Tap one side of the doorway, on the floor";
  else if (!current.length) h = "Put the ring on a corner, where the wall meets the floor";
  else h = current.length < 3 ? "Next corner, going round the room" : "Next corner, or Close room";
  if (onFloor && last) s = `${Math.hypot(at.x - last[0], at.z - last[1]).toFixed(2)} m from the last point · ${s}`;
  $("#hint").textContent = h;
  $("#sub").textContent = s;
}

async function startAR() {
  if (!renderer) setupThree();
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay: { root: $("#overlay") },
    });
  } catch (e) {
    $("#support").textContent = `Couldn't start AR: ${e.message || e}`;
    $("#support").classList.add("bad");
    return;
  }
  floorY = null; current = []; doorPts = []; doorMode = false; live = { rooms: [], doors: [] };
  renderer.xr.setReferenceSpaceType("local");
  await renderer.xr.setSession(session);
  hitSource = await session.requestHitTestSource({ space: await session.requestReferenceSpace("viewer") });
  $("#overlay").classList.add("on");
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
  renderer.setAnimationLoop(onFrame);
  session.addEventListener("end", () => {
    renderer.setAnimationLoop(null);
    hitSource = null; session = null;
    $("#overlay").classList.remove("on");
    if (current.length >= 3) live.rooms.push({ name: `Room ${fp.rooms.length + live.rooms.length + 1}`, pts: current });
    current = []; doorPts = [];
    if (live.rooms.length) { remember(); add(fp, live.rooms, live.doors); save(); }
    showPlan();
  });
}

// the overlay's buttons must not also count as taps in the AR scene
$("#overlay").addEventListener("beforexrselect", (e) => e.preventDefault());

$("#add").addEventListener("click", () => {
  if (!onFloor) return;
  if (floorY === null) floorY = at.y;
  const p = [at.x, at.z];
  if (doorMode) {
    doorPts.push(p);
    if (doorPts.length === 2) {
      live.doors.push({ a: doorPts[0], b: doorPts[1] });
      doorPts = []; doorMode = false;
      $("#door").textContent = "Doorway";
    }
  } else {
    current.push(p);
  }
  navigator.vibrate?.(15);
  redraw();
});
$("#undo").addEventListener("click", () => {
  if (doorMode && doorPts.length) doorPts.pop();
  else if (doorMode) { doorMode = false; $("#door").textContent = "Doorway"; }
  else if (current.length) current.pop();
  else if (live.doors.length) live.doors.pop();
  else if (live.rooms.length) current = live.rooms.pop().pts;
  redraw();
});
$("#close").addEventListener("click", () => {
  if (current.length < 3) { $("#hint").textContent = "A room needs at least 3 corners"; return; }
  $("#namebox").classList.add("on");
  $("#roomname").value = "";
  $("#roomname").placeholder = `Room ${fp.rooms.length + live.rooms.length + 1}`;
  $("#roomname").focus();
});
$("#savename").addEventListener("click", () => {
  live.rooms.push({ name: $("#roomname").value.trim() || $("#roomname").placeholder, pts: current });
  current = [];
  $("#namebox").classList.remove("on");
  $("#roomname").blur();
  redraw();
});
$("#door").addEventListener("click", () => {
  doorMode = !doorMode; doorPts = [];
  $("#door").textContent = doorMode ? "Cancel door" : "Doorway";
  redraw();
});
$("#finish").addEventListener("click", () => session?.end());

// ---------- geometry ----------
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const next = (r, i) => r.pts[(i + 1) % r.pts.length];
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const signed = (pts) => pts.reduce((s, a, i) => { const b = pts[(i + 1) % pts.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const area = (pts) => Math.abs(signed(pts));
const centre = (pts) => {  // the area-weighted centre (the vertices' mean when the shape is degenerate)
  let cx = 0, cy = 0, a2 = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length], k = p[0] * q[1] - q[0] * p[1]; a2 += k; cx += (p[0] + q[0]) * k; cy += (p[1] + q[1]) * k; });
  return Math.abs(a2) < 1e-6 ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : [cx / (3 * a2), cy / (3 * a2)];
};
const inward = (r, i) => {  // the unit normal of wall i pointing into the room
  const a = r.pts[i], b = next(r, i), l = len(a, b) || 1;
  const n = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  return signed(r.pts) > 0 ? [-n[0], -n[1]] : n;
};
const bounds = (rooms) => {
  const all = rooms.flatMap((r) => r.pts);
  return all.length ? { x0: Math.min(...all.map((p) => p[0])), y0: Math.min(...all.map((p) => p[1])), x1: Math.max(...all.map((p) => p[0])), y1: Math.max(...all.map((p) => p[1])) }
                    : { x0: 0, y0: 0, x1: 4, y1: 3 };
};

// ---------- a scan, cleaned up once and added to the plan ----------
function add(plan, rooms, doors) {
  // squared up: the walls' main direction made horizontal (averaged on 4 x angle, so walls at right angles agree)
  let c = 0, s = 0;
  for (const r of rooms) r.pts.forEach((a, i) => {
    const b = r.pts[(i + 1) % r.pts.length], l = len(a, b), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    c += l * Math.cos(4 * ang); s += l * Math.sin(4 * ang);
  });
  const turn = -Math.atan2(s, c) / 4;
  let made = rooms.map((r) => ({ name: r.name, pts: square(r.pts.map((p) => rot(p, turn))), open: [] }));
  snapShared(made);
  // placed to the right of what's already there (a later scan has its own frame: dragged into place by hand)
  const b = bounds(made), have = bounds(plan.rooms);
  const dx = plan.rooms.length ? have.x1 + 1 - b.x0 : -b.x0, dy = plan.rooms.length ? have.y0 - b.y0 : -b.y0;
  made.forEach((r) => r.pts.forEach((p) => { p[0] += dx; p[1] += dy; }));
  const first = plan.rooms.length;
  plan.rooms.push(...made);
  for (const d of doors) {
    const placed = [d.a, d.b].map((p) => { const q = rot(p, turn); return [q[0] + dx, q[1] + dy]; });
    const w = onWall(plan, placed[0], placed[1], first);
    if (w) plan.doors.push(w);
  }
}

function square(pts) {
  // walls within 10° of horizontal or vertical are made exactly so (their two ends share the coordinate)
  const out = pts.map((p) => [...p]);
  for (let pass = 0; pass < 2; pass++) out.forEach((a, i) => {
    const b = out[(i + 1) % out.length], ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI;
    if (ang < 10 || ang > 170) { const y = (a[1] + b[1]) / 2; a[1] = b[1] = y; }
    else if (Math.abs(ang - 90) < 10) { const x = (a[0] + b[0]) / 2; a[0] = b[0] = x; }
  });
  return out;
}

function snapShared(rooms) {
  // corners of different rooms within 8 cm of each other on one axis share it (the same wall, tapped twice)
  for (const k of [0, 1]) {
    const vals = rooms.flatMap((r) => r.pts.map((p) => p[k])).sort((x, y) => x - y);
    const groups = [];
    for (const v of vals) (groups.length && v - groups.at(-1).at(-1) < 0.08 ? groups.at(-1) : groups[groups.push([]) - 1]).push(v);
    const mean = new Map(groups.flatMap((g) => g.map((v) => [v, g.reduce((s, x) => s + x, 0) / g.length])));
    rooms.forEach((r) => r.pts.forEach((p) => { p[k] = mean.get(p[k]) ?? p[k]; }));
  }
}

function onWall(plan, pa, pb, from = 0) {
  // a doorway goes on the nearest wall: its two sides projected onto it, kept as a centre and a width
  let best = null;
  plan.rooms.forEach((r, ri) => {
    if (ri < from) return;
    r.pts.forEach((a, i) => {
      const b = next(r, i), vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1e-9;
      const t = (p) => Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2));
      const ta = t(pa), tb = t(pb), at = (u) => [a[0] + u * vx, a[1] + u * vy];
      const dist = len(at(ta), pa) + len(at(tb), pb);
      if (!best || dist < best.dist) best = { dist, room: ri, edge: i, t: (ta + tb) / 2, w: Math.abs(tb - ta) * Math.sqrt(l2) };
    });
  });
  return best && best.dist < 1.2 && best.w > 0.4 ? { room: best.room, edge: best.edge, t: +best.t.toFixed(3), w: +best.w.toFixed(2) } : null;
}

// ---------- editing the plan ----------
let history = [], sel = null;  // sel: {room} or {room, edge}

function remember() {
  history.push(JSON.stringify(fp));
  if (history.length > 60) history.shift();
}
function undoEdit() {
  if (!history.length) return;
  fp = JSON.parse(history.pop());
  sel = null; save(); showPlan();
}

function sameWall(r1, e1, r2, e2) {
  // two rooms' walls that are the same wall seen from both sides: both straight, on one line (within 6 cm), overlapping
  const a = fp.rooms[r1].pts[e1], b = next(fp.rooms[r1], e1), c = fp.rooms[r2].pts[e2], d = next(fp.rooms[r2], e2);
  if (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(c[1] - d[1]) < 1e-6 && Math.abs(a[1] - c[1]) < 0.06)
    return Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) - Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) > 0.2;
  if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(c[0] - d[0]) < 1e-6 && Math.abs(a[0] - c[0]) < 0.06)
    return Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) - Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) > 0.2;
  return false;
}
function twins(ri, ei) {
  const out = [[ri, ei]];
  fp.rooms.forEach((r, rj) => { if (rj !== ri) r.pts.forEach((_, ej) => { if (sameWall(ri, ei, rj, ej)) out.push([rj, ej]); }); });
  return out;
}

function setKind(ri, ei, kind, width) {
  // a wall, no wall (open, on both rooms' sides), or a doorway (one per wall, centred unless already placed)
  remember();
  for (const [rj, ej] of twins(ri, ei)) {
    const r = fp.rooms[rj];
    r.open = (r.open || []).filter((e) => e !== ej);
    if (kind === "open") r.open.push(ej);
    if (kind !== "door") fp.doors = fp.doors.filter((d) => !(d.room === rj && d.edge === ej));
  }
  if (kind === "door") {
    const wall = len(fp.rooms[ri].pts[ei], next(fp.rooms[ri], ei));
    const d = fp.doors.find((d) => twins(ri, ei).some(([rj, ej]) => d.room === rj && d.edge === ej));
    const w = Math.max(0.5, Math.min(width || d?.w || 0.83, wall - 0.1));
    if (d) d.w = +w.toFixed(2); else fp.doors.push({ room: ri, edge: ei, t: 0.5, w: +w.toFixed(2) });
  }
  save(); showPlan();
}
function kindOf(ri, ei) {
  const tw = twins(ri, ei);
  if (fp.doors.some((d) => tw.some(([rj, ej]) => d.room === rj && d.edge === ej))) return "door";
  return tw.some(([rj, ej]) => (fp.rooms[rj].open || []).includes(ej)) ? "open" : "wall";
}

function setLength(ri, ei, L) {
  // the wall becomes L metres long: its far end moves along it, and so does the next corner, so right angles stay right
  const r = fp.rooms[ri], n = r.pts.length, a = r.pts[ei], b = next(r, ei), l = len(a, b);
  if (!(L > 0.1) || l < 1e-6) return;
  remember();
  const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l, d = L - l;
  const moving = [(ei + 1) % n];
  const c = r.pts[(ei + 2) % n], bc = [c[0] - b[0], c[1] - b[1]];
  if (n > 3 && Math.abs(bc[0] * ux + bc[1] * uy) < 0.05 * len(b, c)) moving.push((ei + 2) % n);  // the next wall is square to it
  for (const k of moving) { r.pts[k][0] += ux * d; r.pts[k][1] += uy * d; }
  save(); showPlan();
}

function turnRoom(ri) {
  remember();
  const r = fp.rooms[ri], c = centre(r.pts);
  r.pts = r.pts.map(([x, y]) => [c[0] - (y - c[1]), c[1] + (x - c[0])]);
  save(); showPlan();
}
function deleteRoom(ri) {
  remember();
  fp.rooms.splice(ri, 1);
  fp.doors = fp.doors.filter((d) => d.room !== ri).map((d) => ({ ...d, room: d.room > ri ? d.room - 1 : d.room }));
  sel = null; save(); showPlan();
}

function snapMove(ri, dx, dy) {
  // a room being dragged clicks onto other rooms: a corner within 15 cm of another room's line on either axis lines up
  const mine = fp.rooms[ri].pts, others = fp.rooms.flatMap((r, j) => (j === ri ? [] : r.pts));
  const fix = (k, d) => {
    let best = null;
    for (const p of mine) for (const q of others) { const gap = q[k] - (p[k] + d); if (Math.abs(gap) < 0.15 && (best === null || Math.abs(gap) < Math.abs(best))) best = gap; }
    return best === null ? Math.round(d / 0.05) * 0.05 : d + best;
  };
  return [fix(0, dx), fix(1, dy)];
}
function snapPoint(ri, p) {
  // a dragged corner: onto another corner's line within 10 cm, else onto a 5 cm grid
  const others = fp.rooms.flatMap((r, j) => r.pts.filter((_, k) => !(j === ri && sel && sel.corner === k)));
  return [0, 1].map((k) => {
    let best = null;
    for (const q of others) { const gap = q[k] - p[k]; if (Math.abs(gap) < 0.1 && (best === null || Math.abs(gap) < Math.abs(best))) best = gap; }
    return best === null ? Math.round(p[k] / 0.05) * 0.05 : p[k] + best;
  });
}

// ---------- the drawing, once, for the screen (SVG) and the PDF: primitives in metres ----------
function drawing() {
  const out = [];
  fp.rooms.forEach((r, ri) => out.push({ kind: "fill", pts: r.pts, room: ri }));
  fp.rooms.forEach((r, ri) => r.pts.forEach((a, ei) => out.push({ kind: "wall", a, b: next(r, ei), room: ri, edge: ei, open: kindOf(ri, ei) === "open" })));
  for (const d of fp.doors) {
    const r = fp.rooms[d.room];
    if (!r || !r.pts[d.edge]) continue;
    const a = r.pts[d.edge], b = next(r, d.edge), l = len(a, b) || 1, ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
    const mid = [a[0] + (b[0] - a[0]) * d.t, a[1] + (b[1] - a[1]) * d.t], h = Math.min(d.w, l) / 2;
    const p = [mid[0] - ux * h, mid[1] - uy * h], q = [mid[0] + ux * h, mid[1] + uy * h], n = inward(r, d.edge), w = 2 * h;
    const arc = [];  // the door's swing, a quarter circle into the room from its hinge
    for (let k = 0; k <= 12; k++) { const t = (k / 12) * Math.PI / 2; arc.push([p[0] + w * (ux * Math.cos(t) + n[0] * Math.sin(t)), p[1] + w * (uy * Math.cos(t) + n[1] * Math.sin(t))]); }
    out.push({ kind: "door", a: p, b: q, arc });
  }
  fp.rooms.forEach((r) => {
    const c = centre(r.pts);
    r.pts.forEach((a, i) => {
      const b = next(r, i), l = len(a, b);
      if (l < 0.4) return;
      const n = inward(r, i), at = [(a[0] + b[0]) / 2 + n[0] * 0.28, (a[1] + b[1]) / 2 + n[1] * 0.28];
      if (Math.abs(at[0] - c[0]) < 1.1 && Math.abs(at[1] - c[1]) < 0.45) return;  // would sit on the room's name: left out
      out.push({ kind: "length", at, text: `${l.toFixed(2)} m`, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) });
    });
    out.push({ kind: "name", at: c, name: r.name, area: area(r.pts) });
  });
  return out;
}

// ---------- the plan on screen ----------
const svg = $("#plan");
let view = null, drag = null;

function frameView() {
  const b = bounds(fp.rooms), pad = 0.8;
  view = { x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + 2 * pad, h: b.y1 - b.y0 + 2 * pad + 0.6 };
}

function showPlan() {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "planview"));
  if (!fp.rooms.length) {
    svg.setAttribute("viewBox", "0 0 400 120");
    svg.innerHTML = '<text x="200" y="66" text-anchor="middle" font-size="16" fill="#6b6455" font-family="Archivo, sans-serif">No rooms yet: scan one to see it here.</text>';
    $("#totals").textContent = ""; panel(); return;
  }
  if (!drag) frameView();
  render();
  const total = fp.rooms.reduce((s, r) => s + area(r.pts), 0);
  $("#totals").textContent = `${fp.rooms.length} room${fp.rooms.length === 1 ? "" : "s"} · ${total.toFixed(1)} m² in all · ${fp.doors.length} doorway${fp.doors.length === 1 ? "" : "s"}`;
  $("#undo-edit").disabled = !history.length;
  panel();
}

function render() {
  const S = 100;  // drawn in centimetres
  svg.setAttribute("viewBox", `${view.x * S} ${view.y * S} ${view.w * S} ${view.h * S}`);
  const px = (svg.getBoundingClientRect().width || 360) / (view.w * S);  // screen pixels per unit, for handle sizes
  const P = (pt) => `${(pt[0] * S).toFixed(1)},${(pt[1] * S).toFixed(1)}`;
  const parts = [];
  for (const s of drawing()) {
    const isSel = sel && sel.room === s.room;
    if (s.kind === "fill") parts.push(`<polygon points="${s.pts.map(P).join(" ")}" fill="${isSel && sel.edge === undefined ? "#e6f0ff" : "#ffffff"}" data-room="${s.room}"/>`);
    else if (s.kind === "wall") {
      const chosen = sel && sel.room === s.room && sel.edge === s.edge;
      parts.push(s.open
        ? `<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.b[0] * S}" y2="${s.b[1] * S}" stroke="${chosen ? "#ff9d2e" : "#b9b0a0"}" stroke-width="${chosen ? 6 : 3}" stroke-dasharray="10 8"/>`
        : `<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.b[0] * S}" y2="${s.b[1] * S}" stroke="${chosen ? "#ff9d2e" : "#1d2533"}" stroke-width="9" stroke-linecap="square"/>`);
      // the wall's touch zone: about a fingertip on screen, never more than a third of the room's narrowest side
      const r = fp.rooms[s.room], bb = bounds([r]), most = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * S / 3;
      parts.push(`<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.b[0] * S}" y2="${s.b[1] * S}" stroke="transparent" stroke-width="${Math.min(18 / px, most)}" data-room="${s.room}" data-edge="${s.edge}" style="cursor:pointer"/>`);
    } else if (s.kind === "door") {
      parts.push(`<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.b[0] * S}" y2="${s.b[1] * S}" stroke="#ffffff" stroke-width="12" pointer-events="none"/>`);
      parts.push(`<polyline points="${s.arc.map(P).join(" ")}" fill="none" stroke="#9aa3b1" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>`);
      parts.push(`<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.arc.at(-1)[0] * S}" y2="${s.arc.at(-1)[1] * S}" stroke="#9aa3b1" stroke-width="3" pointer-events="none"/>`);
    } else if (s.kind === "length") {
      const deg = (s.angle * 180 / Math.PI + 360) % 180, up = deg > 90 ? deg - 180 : deg;
      parts.push(`<text transform="translate(${s.at[0] * S} ${s.at[1] * S}) rotate(${up})" text-anchor="middle" dominant-baseline="middle" font-size="14" fill="#7a6f5a" font-family="IBM Plex Mono, monospace" pointer-events="none">${s.text}</text>`);
    } else if (s.kind === "name") {
      parts.push(`<text x="${s.at[0] * S}" y="${s.at[1] * S - 6}" text-anchor="middle" font-size="22" font-weight="700" fill="#1d2533" font-family="Archivo, sans-serif" pointer-events="none">${esc(s.name)}</text>`);
      parts.push(`<text x="${s.at[0] * S}" y="${s.at[1] * S + 20}" text-anchor="middle" font-size="17" fill="#5d6675" font-family="IBM Plex Mono, monospace" pointer-events="none">${s.area.toFixed(1)} m²</text>`);
    }
  }
  if (sel && sel.edge === undefined && fp.rooms[sel.room]) {  // the selected room's corners, to drag
    const r = Math.max(9, 11 / px);
    fp.rooms[sel.room].pts.forEach((p, k) => parts.push(`<circle cx="${p[0] * S}" cy="${p[1] * S}" r="${r}" fill="#ff9d2e" stroke="#ffffff" stroke-width="${3 / px}" data-room="${sel.room}" data-corner="${k}" style="cursor:grab"/>`));
  }
  const bx = view.x * S + 40, by = (view.y + view.h) * S - 30;  // a 1 m scale bar under the plan
  parts.push(`<g font-family="IBM Plex Mono, monospace" font-size="15" fill="#5d6675" pointer-events="none"><rect x="${bx}" y="${by}" width="100" height="8" fill="#1d2533"/><text x="${bx + 112}" y="${by + 9}">1 m</text></g>`);
  svg.innerHTML = parts.join("");
}

function panel() {
  const box = $("#edit");
  box.replaceChildren();
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  if (!sel || !fp.rooms[sel.room]) {
    box.append(h("h2", "", "Edit the plan"), h("p", "", "Tap a room to move it (it snaps to the rooms around it), turn or rename it, and drag its corners. Tap a wall to set its exact length, or make it open or a doorway."));
    return;
  }
  const r = fp.rooms[sel.room];
  if (sel.edge === undefined) {
    box.append(h("h2", "", "Room"));
    const name = h("input", "field"); name.id = "room-name"; name.value = r.name; name.setAttribute("aria-label", "Room name");
    name.addEventListener("change", () => { remember(); r.name = name.value.trim() || r.name; save(); showPlan(); });
    const row = h("div", "row");
    const turn = h("button", "btn secondary", "Turn 90°"); turn.type = "button"; turn.onclick = () => turnRoom(sel.room);
    const del = h("button", "btn ghost", "Delete room"); del.type = "button"; del.onclick = () => deleteRoom(sel.room);
    const done = h("button", "btn secondary", "Done"); done.type = "button"; done.onclick = () => { sel = null; showPlan(); };
    row.append(turn, del, done);
    box.append(name, h("p", "note", `${area(r.pts).toFixed(1)} m². Drag the room to move it; drag an orange corner to reshape it.`), row);
    return;
  }
  const a = r.pts[sel.edge], b = next(r, sel.edge), kind = kindOf(sel.room, sel.edge);
  box.append(h("h2", "", `Wall of ${r.name}`));
  const lrow = h("div", "row inline");
  const L = h("input", "field"); L.id = "wall-length"; L.type = "number"; L.step = "0.01"; L.min = "0.2"; L.inputMode = "decimal"; L.value = len(a, b).toFixed(2); L.setAttribute("aria-label", "Wall length in metres");
  const setL = h("button", "btn secondary", "Set length"); setL.type = "button"; setL.onclick = () => setLength(sel.room, sel.edge, parseFloat(L.value));
  L.addEventListener("keydown", (e) => { if (e.key === "Enter") setL.click(); });
  lrow.append(L, h("span", "unit", "m"), setL);
  const kinds = h("div", "seg"); kinds.setAttribute("role", "group"); kinds.setAttribute("aria-label", "What this wall is");
  for (const [k, label] of [["wall", "Wall"], ["open", "No wall"], ["door", "Doorway"]]) {
    const btn = h("button", "", label); btn.type = "button"; btn.setAttribute("aria-pressed", kind === k);
    btn.onclick = () => setKind(sel.room, sel.edge, k);
    kinds.append(btn);
  }
  box.append(lrow, kinds);
  if (kind === "door") {
    const d = fp.doors.find((d) => twins(sel.room, sel.edge).some(([rj, ej]) => d.room === rj && d.edge === ej));
    const drow = h("div", "row inline");
    const W = h("input", "field"); W.id = "door-width"; W.type = "number"; W.step = "0.01"; W.min = "0.5"; W.inputMode = "decimal"; W.value = d ? d.w.toFixed(2) : "0.83"; W.setAttribute("aria-label", "Doorway width in metres");
    const setW = h("button", "btn secondary", "Set width"); setW.type = "button"; setW.onclick = () => setKind(sel.room, sel.edge, "door", parseFloat(W.value));
    drow.append(h("span", "unit", "Doorway"), W, h("span", "unit", "m"), setW);
    box.append(drow);
  }
  const done = h("button", "btn secondary", "Done"); done.type = "button"; done.onclick = () => { sel = null; showPlan(); };
  box.append(h("p", "note", "Setting a length moves the wall's far end (and the next corner, so right angles stay right). \"No wall\" applies to both rooms."), done);
}

const toPlan = (e) => {
  const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
  const q = p.matrixTransform(svg.getScreenCTM().inverse());
  return [q.x / 100, q.y / 100];
};

svg.addEventListener("pointerdown", (e) => {
  if (!fp.rooms.length) return;
  const d = e.target.dataset || {}, p = toPlan(e);
  if (d.corner !== undefined) {
    remember();
    sel = { room: +d.room, corner: +d.corner };
    drag = { kind: "corner", room: +d.room, k: +d.corner };
  } else if (d.edge !== undefined) {
    sel = { room: +d.room, edge: +d.edge };
    drag = null;
  } else if (d.room !== undefined) {
    sel = { room: +d.room };
    drag = { kind: "room-maybe", room: +d.room, start: p, orig: fp.rooms[+d.room].pts.map((q) => [...q]) };
  } else {
    sel = null; drag = null;
  }
  svg.setPointerCapture(e.pointerId);
  showPlan();
});
svg.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = toPlan(e);
  if (drag.kind === "corner") {
    fp.rooms[drag.room].pts[drag.k] = snapPoint(drag.room, p);
    render();
  } else if (drag.kind.startsWith("room")) {
    let dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    if (drag.kind === "room-maybe") { if (Math.hypot(dx, dy) < 0.08) return; remember(); drag.kind = "room"; }
    fp.rooms[drag.room].pts = drag.orig.map((q) => [q[0], q[1]]);
    [dx, dy] = snapMove(drag.room, dx, dy);
    fp.rooms[drag.room].pts = drag.orig.map((q) => [q[0] + dx, q[1] + dy]);
    render();
  }
});
const endDrag = () => {
  if (!drag) return;
  const moved = drag.kind === "corner" || drag.kind === "room";
  if (drag.kind === "corner") sel = { room: drag.room };
  drag = null;
  if (moved) save();
  showPlan();
};
svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- the PDF, made here ----------
function savePDF() {
  if (!fp.rooms.length) { $("#plan-status").textContent = "Scan a room first."; return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = 297, H = 210, M = 14, top = 30, bottom = 22;
  const b = bounds(fp.rooms), w = b.x1 - b.x0 + 1.2, h = b.y1 - b.y0 + 1.2;
  // the largest standard architect's scale that fits the page (1:50 means 1 m = 20 mm)
  const scale = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500].find((s) => (w * 1000) / s <= W - 2 * M && (h * 1000) / s <= H - top - bottom) || 500;
  const k = 1000 / scale, ox = M + (W - 2 * M - (b.x1 - b.x0) * k) / 2 - b.x0 * k, oy = top + (H - top - bottom - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
  const X = (pt) => [ox + pt[0] * k, oy + pt[1] * k];
  const total = fp.rooms.reduce((s, r) => s + area(r.pts), 0);
  const shapes = drawing();

  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(29, 37, 51);
  doc.text("Floor plan", M, 17);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(93, 102, 117);
  doc.text(`${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}  ·  ${fp.rooms.length} room${fp.rooms.length === 1 ? "" : "s"}  ·  ${total.toFixed(1)} m² in all  ·  scale 1:${scale} on A4`, M, 23.5);

  for (const s of shapes.filter((s) => s.kind === "fill")) {
    const pts = s.pts.map(X), segs = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
    doc.setFillColor(255, 255, 255); doc.lines(segs, pts[0][0], pts[0][1], [1, 1], "F", true);
  }
  for (const s of shapes.filter((s) => s.kind === "wall")) {
    const a = X(s.a), bb = X(s.b);
    if (s.open) { doc.setDrawColor(185, 176, 160); doc.setLineWidth(0.3); doc.setLineDashPattern([1.6, 1.2], 0); }
    else { doc.setDrawColor(29, 37, 51); doc.setLineWidth(Math.max(0.6, 0.09 * k)); doc.setLineDashPattern([], 0); doc.setLineCap("square"); }
    doc.line(a[0], a[1], bb[0], bb[1]);
  }
  doc.setLineDashPattern([], 0); doc.setLineCap("butt");
  for (const s of shapes.filter((s) => s.kind === "door")) {
    const a = X(s.a), bb = X(s.b);
    doc.setDrawColor(255, 255, 255); doc.setLineWidth(Math.max(0.9, 0.12 * k)); doc.line(a[0], a[1], bb[0], bb[1]);
    doc.setDrawColor(154, 163, 177); doc.setLineWidth(0.25); doc.setLineDashPattern([1.2, 0.9], 0);
    const arc = s.arc.map(X); for (let i = 1; i < arc.length; i++) doc.line(arc[i - 1][0], arc[i - 1][1], arc[i][0], arc[i][1]);
    doc.setLineDashPattern([], 0); doc.setLineWidth(0.4); doc.line(a[0], a[1], arc.at(-1)[0], arc.at(-1)[1]);
  }
  for (const s of shapes.filter((s) => s.kind === "length")) {
    const at = X(s.at), deg = (s.angle * 180 / Math.PI + 360) % 180, up = deg > 90 ? deg - 180 : deg;
    doc.setFontSize(7); doc.setTextColor(122, 111, 90);
    doc.text(s.text, at[0], at[1], { align: "center", baseline: "middle", angle: -up });
  }
  for (const s of shapes.filter((s) => s.kind === "name")) {
    const c = X(s.at);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(29, 37, 51); doc.text(s.name, c[0], c[1] - 1, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(93, 102, 117); doc.text(`${s.area.toFixed(1)} m²`, c[0], c[1] + 3.6, { align: "center" });
  }
  const bx = M, by = H - 13;  // a 1 m scale bar, and the small print
  doc.setFillColor(29, 37, 51); doc.rect(bx, by, k, 1.6, "F");
  doc.setFontSize(8); doc.setTextColor(93, 102, 117); doc.text("1 m", bx + k + 2, by + 1.5);
  doc.text("Scanned in AR on a phone: walls accurate to a few centimetres. Not a surveyor's plan.", W - M, by + 1.5, { align: "right" });
  doc.save(`floor-plan-${new Date().toISOString().slice(0, 10)}.pdf`);
  $("#plan-status").textContent = "Saved to your Downloads.";
}

function saveJSON() {
  const blob = new Blob([JSON.stringify({ made: new Date().toISOString(), units: "metres",
    rooms: fp.rooms.map((r) => ({ name: r.name, corners: r.pts.map((q) => q.map((v) => +v.toFixed(3))), open_walls: r.open || [], area_m2: +area(r.pts).toFixed(2) })),
    doors: fp.doors }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `floor-plan-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $("#plan-status").textContent = "Plan file saved to your Downloads.";
}

// ---------- a sample, to see what you get (taps a little off, as a hand would make them) ----------
function sample() {
  const jitter = (pts) => pts.map(([x, z]) => [x + (Math.random() - 0.5) * 0.08, z + (Math.random() - 0.5) * 0.08]);
  const turn = (pts) => pts.map((q) => rot(q, 0.21));
  fp = { rooms: [], doors: [] }; history = []; sel = null;
  add(fp, [
    { name: "Living room", pts: turn(jitter([[0, 0], [4.0, 0], [4.0, 4.6], [0, 4.6]])) },
    { name: "Kitchen", pts: turn(jitter([[4.0, 0], [6.2, 0], [6.2, 4.6], [4.0, 4.6]])) },
    { name: "Bedroom", pts: turn(jitter([[6.32, 0], [9.6, 0], [9.6, 3.4], [6.32, 3.4]])) },
    { name: "Bathroom", pts: turn(jitter([[6.32, 3.52], [9.6, 3.52], [9.6, 4.6], [6.32, 4.6]])) },
    { name: "Hallway", pts: turn(jitter([[0, 4.72], [9.6, 4.72], [9.6, 5.9], [0, 5.9]])) },
  ], [
    { a: turn([[6.25, 1.2]])[0], b: turn([[6.25, 2.05]])[0] },
    { a: turn([[2.6, 4.66]])[0], b: turn([[3.45, 4.66]])[0] },
    { a: turn([[7.0, 4.66]])[0], b: turn([[7.75, 4.66]])[0] },
  ]);
  const kitchen = fp.rooms.findIndex((r) => r.name === "Kitchen"), living = fp.rooms.findIndex((r) => r.name === "Living room");
  const shared = fp.rooms[living].pts.findIndex((_, e) => fp.rooms[kitchen].pts.some((_, f) => sameWall(living, e, kitchen, f)));
  if (shared >= 0) { fp.rooms[living].open.push(shared); history = []; }  // open-plan: no wall between kitchen and living room
  showPlan();
  $("#plan-title").textContent = "Sample plan";
  $("#plan-status").textContent = "A made-up flat (the kitchen is open to the living room), to show what a scan gives. Start over to scan your own.";
}

// ---------- start ----------
$("#sample").addEventListener("click", sample);
$("#go").addEventListener("click", startAR);
$("#more").addEventListener("click", () => { if (navigator.xr) startAR(); });
$("#restart").addEventListener("click", () => {
  remember(); fp = { rooms: [], doors: [] }; sel = null; save();
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "start"));
});
$("#undo-edit").addEventListener("click", undoEdit);
$("#pdf").addEventListener("click", savePDF);
$("#json").addEventListener("click", saveJSON);
window.addEventListener("resize", () => { if (!$("#planview").hidden && fp.rooms.length) render(); });

if (location.hash === "#sample") sample();  // a link straight to the sample plan

(async () => {
  const go = $("#go"), note = $("#support");
  if (fp.rooms.length) {
    const r = $("#resume"); r.hidden = false; r.innerHTML = "";
    const b = document.createElement("button"); b.className = "btn secondary"; b.type = "button";
    b.textContent = `Open your plan (${fp.rooms.length} room${fp.rooms.length === 1 ? "" : "s"})`;
    b.addEventListener("click", showPlan); r.append(b);
  }
  const ok = navigator.xr && await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  if (ok) { go.disabled = false; go.textContent = "Start scanning"; note.textContent = "This phone can scan in AR."; }
  else { go.textContent = "AR not available"; note.textContent = "This browser can't scan in AR. Open this page in Chrome on an Android phone with Google Play Services for AR. You can still look at the sample plan."; note.classList.add("bad"); }
})();
