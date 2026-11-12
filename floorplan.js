// Floor Plan: scan rooms in AR (WebXR hit tests on the floor), turn the taps into a clean 2D plan, save it as a PDF.
// Everything happens on the phone; the only things fetched are this page and its two libraries.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);
const KEY = "floorplan-scan-v1";

// ---------- the scan, kept on this phone ----------
// rooms: [{name, part, pts: [[x, z], ...]}] in metres on the floor (x right, z towards you when you started);
// doors: [{part, a: [x, z], b: [x, z]}]; part: which AR session (each has its own frame, placed by hand later);
// place: per part, how to put it on the plan: {dx, dy, turn} (turn in quarter turns).
let scan = load() || { rooms: [], doors: [], place: {}, parts: 0 };

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(scan)); } catch { /* private window: the scan lives until the page closes */ }
}

// ---------- AR ----------
let renderer, scene, camera, reticle, group, hitSource = null, session = null;
let floorY = null, onFloor = false, part = 0, doorMode = false, doorPts = [], current = [];
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
  for (const r of scan.rooms.filter((r) => r.part === part)) {
    group.add(line(r.pts, 0x7fb6ff, true));
    r.pts.forEach((p) => group.add(dot(p, 0x7fb6ff, 0.025)));
  }
  for (const d of scan.doors.filter((d) => d.part === part)) group.add(line([d.a, d.b], 0x7dd38a));
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
  const hits = frame.getHitTestResults(hitSource);
  onFloor = false;
  for (const hit of hits) {
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
  const n = scan.rooms.filter((r) => r.part === part).length;
  let h, s = `${n} room${n === 1 ? "" : "s"} scanned`;
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
  part = scan.parts;  // a new session has its own frame: its rooms are placed on the plan by hand
  scan.parts += 1;
  floorY = null; current = []; doorPts = []; doorMode = false;
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
    if (current.length >= 3) closeRoom(`Room ${scan.rooms.length + 1}`);
    current = []; doorPts = [];
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
      scan.doors.push({ part, a: doorPts[0], b: doorPts[1] });
      doorPts = []; doorMode = false; save();
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
  else {
    const lastDoor = scan.doors.findLastIndex((d) => d.part === part), lastRoom = scan.rooms.findLastIndex((r) => r.part === part);
    if (lastDoor >= 0) scan.doors.splice(lastDoor, 1);
    else if (lastRoom >= 0) current = scan.rooms.splice(lastRoom, 1)[0].pts;
    save();
  }
  redraw();
});
$("#close").addEventListener("click", () => {
  if (current.length < 3) { $("#hint").textContent = "A room needs at least 3 corners"; return; }
  $("#namebox").classList.add("on");
  $("#roomname").value = "";
  $("#roomname").placeholder = `Room ${scan.rooms.length + 1}`;
  $("#roomname").focus();
});
$("#savename").addEventListener("click", () => {
  closeRoom($("#roomname").value.trim() || $("#roomname").placeholder);
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

function closeRoom(name) {
  scan.rooms.push({ name, part, pts: current });
  current = [];
  save();
}

// ---------- from taps to a clean plan ----------
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

function plan() {
  // each part squared up on its own (its walls' main direction made horizontal), then placed by hand
  const rooms = [], doors = [];
  for (let p = 0; p < scan.parts; p++) {
    const mine = scan.rooms.filter((r) => r.part === p);
    if (!mine.length) continue;
    let c = 0, s = 0;  // the walls' main direction, averaged on 4 x angle so that walls at right angles agree
    for (const r of mine) r.pts.forEach((a, i) => {
      const b = r.pts[(i + 1) % r.pts.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      c += len * Math.cos(4 * ang); s += len * Math.sin(4 * ang);
    });
    const place = scan.place[p] || { dx: 0, dy: 0, turn: 0 };
    const a = -Math.atan2(s, c) / 4 + place.turn * Math.PI / 2;
    const move = (pt) => { const q = rot(pt, a); return [q[0] + place.dx, q[1] + place.dy]; };
    for (const r of mine) rooms.push({ ...r, pts: square(r.pts.map(move)) });
    for (const d of scan.doors.filter((d) => d.part === p)) doors.push({ ...d, a: move(d.a), b: move(d.b) });
  }
  snapShared(rooms);
  return { rooms, doors: doors.map((d) => onWall(d, rooms)).filter(Boolean) };
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

function onWall(d, rooms) {
  // a doorway goes on the nearest wall: both ends projected onto it
  let best = null;
  for (const r of rooms) r.pts.forEach((a, i) => {
    const b = r.pts[(i + 1) % r.pts.length], vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy || 1e-9;
    const proj = (p) => { const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)); return [a[0] + t * vx, a[1] + t * vy]; };
    const pa = proj(d.a), pb = proj(d.b), dist = Math.hypot(pa[0] - d.a[0], pa[1] - d.a[1]) + Math.hypot(pb[0] - d.b[0], pb[1] - d.b[1]);
    if (!best || dist < best.dist) best = { dist, a: pa, b: pb };
  });
  return best && best.dist < 1.2 && Math.hypot(best.b[0] - best.a[0], best.b[1] - best.a[1]) > 0.4 ? best : null;
}

const area = (pts) => Math.abs(pts.reduce((s, a, i) => { const b = pts[(i + 1) % pts.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const centre = (pts) => {  // the area-weighted centre (the vertices' mean when the shape is degenerate)
  let cx = 0, cy = 0, a2 = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length], k = p[0] * q[1] - q[0] * p[1]; a2 += k; cx += (p[0] + q[0]) * k; cy += (p[1] + q[1]) * k; });
  return Math.abs(a2) < 1e-6 ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : [cx / (3 * a2), cy / (3 * a2)];
};
const bounds = (rooms) => {
  const all = rooms.flatMap((r) => r.pts);
  return all.length ? { x0: Math.min(...all.map((p) => p[0])), y0: Math.min(...all.map((p) => p[1])), x1: Math.max(...all.map((p) => p[0])), y1: Math.max(...all.map((p) => p[1])) } : { x0: 0, y0: 0, x1: 4, y1: 3 };
};

// The drawing, once, for the screen (SVG) and the PDF: primitives in metres.
function drawing(p) {
  const shapes = [];
  for (const r of p.rooms) shapes.push({ kind: "room", pts: r.pts, name: r.name, part: r.part });
  for (const r of p.rooms) {
    const c = centre(r.pts);
    const ccw = r.pts.reduce((s, a, i) => { const b = r.pts[(i + 1) % r.pts.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) > 0;
    r.pts.forEach((a, i) => {
      const b = r.pts[(i + 1) % r.pts.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.4) return;
      let nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;  // the normal pointing into the room: labels sit inside
      if (ccw) { nx = -nx; ny = -ny; }
      const at = [(a[0] + b[0]) / 2 + nx * 0.28, (a[1] + b[1]) / 2 + ny * 0.28];
      if (Math.abs(at[0] - c[0]) < 1.1 && Math.abs(at[1] - c[1]) < 0.45) return;  // would sit on the room's name: left out
      shapes.push({ kind: "length", at, text: `${len.toFixed(2)} m`, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) });
    });
  }
  for (const d of p.doors) {
    const w = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), ux = (d.b[0] - d.a[0]) / w, uy = (d.b[1] - d.a[1]) / w;
    const arc = [];
    for (let k = 0; k <= 12; k++) { const t = (k / 12) * Math.PI / 2; arc.push([d.a[0] + w * (ux * Math.cos(t) - uy * Math.sin(t)), d.a[1] + w * (uy * Math.cos(t) + ux * Math.sin(t))]); }
    shapes.push({ kind: "door", a: d.a, b: d.b, arc });
  }
  return shapes;
}

// ---------- the plan on screen ----------
let dragging = null;

function showPlan() {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "planview"));
  const p = plan(), svg = $("#plan");
  if (!p.rooms.length) {
    svg.setAttribute("viewBox", "0 0 400 120");
    svg.innerHTML = '<text x="200" y="66" text-anchor="middle" font-size="16" fill="#6b6455" font-family="Archivo, sans-serif">No rooms yet: scan one to see it here.</text>';
    $("#rooms").innerHTML = ""; $("#totals").textContent = ""; return;
  }
  const b = bounds(p.rooms), pad = 0.8, S = 100;  // 1 m = 100 units
  const vx = (b.x0 - pad) * S, vy = (b.y0 - pad) * S, vw = (b.x1 - b.x0 + 2 * pad) * S, vh = (b.y1 - b.y0 + 2 * pad) * S;
  svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh + 60}`);
  const P = (pt) => `${(pt[0] * S).toFixed(1)},${(pt[1] * S).toFixed(1)}`;
  const parts = [];
  for (const s of drawing(p)) {
    if (s.kind === "room") {
      const c = centre(s.pts);
      parts.push(`<polygon points="${s.pts.map(P).join(" ")}" fill="#ffffff" stroke="#1d2533" stroke-width="9" stroke-linejoin="miter" data-part="${s.part}" style="cursor:${scan.parts > 1 ? "move" : "default"}"/>`);
      parts.push(`<text x="${c[0] * S}" y="${c[1] * S - 6}" text-anchor="middle" font-size="22" font-weight="700" fill="#1d2533" font-family="Archivo, sans-serif" pointer-events="none">${esc(s.name)}</text>`);
      parts.push(`<text x="${c[0] * S}" y="${c[1] * S + 20}" text-anchor="middle" font-size="17" fill="#5d6675" font-family="IBM Plex Mono, monospace" pointer-events="none">${area(s.pts).toFixed(1)} m²</text>`);
    } else if (s.kind === "length") {
      const deg = (s.angle * 180 / Math.PI + 360) % 180;
      const up = deg > 90 ? deg - 180 : deg;
      parts.push(`<text transform="translate(${s.at[0] * S} ${s.at[1] * S}) rotate(${up})" text-anchor="middle" dominant-baseline="middle" font-size="14" fill="#7a6f5a" font-family="IBM Plex Mono, monospace" pointer-events="none">${s.text}</text>`);
    } else if (s.kind === "door") {
      parts.push(`<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.b[0] * S}" y2="${s.b[1] * S}" stroke="#f7f4ec" stroke-width="12"/>`);
      parts.push(`<polyline points="${s.arc.map(P).join(" ")}" fill="none" stroke="#9aa3b1" stroke-width="2" stroke-dasharray="6 4"/>`);
      parts.push(`<line x1="${s.a[0] * S}" y1="${s.a[1] * S}" x2="${s.arc.at(-1)[0] * S}" y2="${s.arc.at(-1)[1] * S}" stroke="#9aa3b1" stroke-width="3"/>`);
    }
  }
  const bx = vx + 40, by = vy + vh + 30;  // a 1 m scale bar under the plan
  parts.push(`<g font-family="IBM Plex Mono, monospace" font-size="15" fill="#5d6675"><rect x="${bx}" y="${by}" width="100" height="8" fill="#1d2533"/><text x="${bx + 112}" y="${by + 9}">1 m</text></g>`);
  svg.innerHTML = parts.join("");
  const total = p.rooms.reduce((s, r) => s + area(r.pts), 0);
  $("#totals").textContent = `${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"} · ${total.toFixed(1)} m² in all · ${p.doors.length} doorway${p.doors.length === 1 ? "" : "s"}`;
  roomList();
  $("#plan-status").textContent = scan.parts > 1 ? "Rooms from different scans are placed by hand: drag them on the plan, and use ⟳ to turn a scan by a quarter." : "";
}

function roomList() {
  const box = $("#rooms");
  box.replaceChildren(...scan.rooms.map((r, i) => {
    const row = document.createElement("div"); row.className = "room-row";
    const name = document.createElement("input"); name.value = r.name; name.id = `room-${i}`; name.setAttribute("aria-label", "Room name");
    name.addEventListener("change", () => { r.name = name.value.trim() || r.name; save(); showPlan(); });
    const info = document.createElement("span");
    const sq = plan().rooms.find((x) => x.pts.length && x.name === r.name);
    info.textContent = sq ? `${area(sq.pts).toFixed(1)} m²` : "";
    const actions = document.createElement("div");
    if (scan.parts > 1) {
      const turn = document.createElement("button"); turn.textContent = "⟳"; turn.title = "Turn this scan by a quarter";
      turn.addEventListener("click", () => { const pl = scan.place[r.part] ||= { dx: 0, dy: 0, turn: 0 }; pl.turn = (pl.turn + 1) % 4; save(); showPlan(); });
      actions.append(turn);
    }
    const del = document.createElement("button"); del.textContent = "×"; del.title = "Delete this room";
    del.addEventListener("click", () => { scan.rooms.splice(i, 1); save(); showPlan(); });
    actions.append(del);
    row.append(name, info, actions);
    return row;
  }));
}

// dragging a scan's rooms into place (only needed when there's more than one scan)
$("#plan").addEventListener("pointerdown", (e) => {
  const part = e.target.dataset?.part;
  if (part === undefined || scan.parts < 2) return;
  const svg = $("#plan"), pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const start = pt.matrixTransform(svg.getScreenCTM().inverse());
  const pl = scan.place[part] ||= { dx: 0, dy: 0, turn: 0 };
  dragging = { part, start, dx: pl.dx, dy: pl.dy };
  svg.setPointerCapture(e.pointerId);
});
$("#plan").addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const svg = $("#plan"), pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const now = pt.matrixTransform(svg.getScreenCTM().inverse()), pl = scan.place[dragging.part];
  pl.dx = dragging.dx + (now.x - dragging.start.x) / 100; pl.dy = dragging.dy + (now.y - dragging.start.y) / 100;
  showPlan();
});
$("#plan").addEventListener("pointerup", () => { if (dragging) { dragging = null; save(); } });

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- the PDF, made here ----------
function savePDF() {
  const p = plan();
  if (!p.rooms.length) { $("#plan-status").textContent = "Scan a room first."; return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = 297, H = 210, M = 14, top = 30, bottom = 22;
  const b = bounds(p.rooms), w = b.x1 - b.x0 + 1.2, h = b.y1 - b.y0 + 1.2;
  // the largest standard architect's scale that fits the page (1:50 means 1 m = 20 mm)
  const scale = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500].find((s) => (w * 1000) / s <= W - 2 * M && (h * 1000) / s <= H - top - bottom) || 500;
  const k = 1000 / scale, ox = M + (W - 2 * M - (b.x1 - b.x0) * k) / 2 - b.x0 * k, oy = top + (H - top - bottom - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
  const X = (pt) => [ox + pt[0] * k, oy + pt[1] * k];
  const total = p.rooms.reduce((s, r) => s + area(r.pts), 0);

  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(29, 37, 51);
  doc.text("Floor plan", M, 17);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(93, 102, 117);
  doc.text(`${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}  ·  ${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"}  ·  ${total.toFixed(1)} m² in all  ·  scale 1:${scale} on A4`, M, 23.5);

  for (const s of drawing(p)) {
    if (s.kind === "room") {
      const pts = s.pts.map(X), segs = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
      doc.setDrawColor(29, 37, 51); doc.setFillColor(255, 255, 255); doc.setLineWidth(Math.max(0.6, 0.09 * k)); doc.setLineJoin("miter");
      doc.lines(segs, pts[0][0], pts[0][1], [1, 1], "FD", true);
    }
  }
  for (const s of drawing(p)) {
    if (s.kind === "door") {
      const a = X(s.a), bb = X(s.b);
      doc.setDrawColor(255, 255, 255); doc.setLineWidth(Math.max(0.9, 0.12 * k)); doc.line(a[0], a[1], bb[0], bb[1]);
      doc.setDrawColor(154, 163, 177); doc.setLineWidth(0.25); doc.setLineDashPattern([1.2, 0.9], 0);
      const arc = s.arc.map(X); for (let i = 1; i < arc.length; i++) doc.line(arc[i - 1][0], arc[i - 1][1], arc[i][0], arc[i][1]);
      doc.setLineDashPattern([], 0); doc.setLineWidth(0.4); doc.line(a[0], a[1], arc.at(-1)[0], arc.at(-1)[1]);
    } else if (s.kind === "length") {
      const at = X(s.at), deg = (s.angle * 180 / Math.PI + 360) % 180, up = deg > 90 ? deg - 180 : deg;
      doc.setFontSize(7); doc.setTextColor(122, 111, 90);
      doc.text(s.text, at[0], at[1], { align: "center", baseline: "middle", angle: -up });
    }
  }
  for (const r of p.rooms) {
    const c = X(centre(r.pts));
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(29, 37, 51); doc.text(r.name, c[0], c[1] - 1, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(93, 102, 117); doc.text(`${area(r.pts).toFixed(1)} m²`, c[0], c[1] + 3.6, { align: "center" });
  }
  const bar = k, bx = M, by = H - 13;  // a 1 m scale bar, and the small print
  doc.setFillColor(29, 37, 51); doc.rect(bx, by, bar, 1.6, "F");
  doc.setFontSize(8); doc.setTextColor(93, 102, 117); doc.text("1 m", bx + bar + 2, by + 1.5);
  doc.text("Scanned in AR on a phone: walls accurate to a few centimetres. Not a surveyor's plan.", W - M, by + 1.5, { align: "right" });
  doc.save(`floor-plan-${new Date().toISOString().slice(0, 10)}.pdf`);
  $("#plan-status").textContent = "Saved to your Downloads.";
}

function saveJSON() {
  const p = plan();
  const blob = new Blob([JSON.stringify({ made: new Date().toISOString(), units: "metres", rooms: p.rooms.map((r) => ({ name: r.name, corners: r.pts.map((q) => q.map((v) => +v.toFixed(3))), area_m2: +area(r.pts).toFixed(2) })),
    doors: p.doors.map((d) => ({ a: d.a.map((v) => +v.toFixed(3)), b: d.b.map((v) => +v.toFixed(3)) })) }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `floor-plan-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $("#plan-status").textContent = "Plan file saved to your Downloads.";
}

// ---------- a sample, to see what you get (taps a little off, as a hand would make them) ----------
function sample() {
  const jitter = (pts) => pts.map(([x, z]) => [x + (Math.random() - 0.5) * 0.08, z + (Math.random() - 0.5) * 0.08]);
  const a = 0.21, turn = (pts) => pts.map((q) => rot(q, a));
  scan = { parts: 1, place: {}, rooms: [
    { name: "Living room + kitchen", part: 0, pts: turn(jitter([[0, 0], [6.2, 0], [6.2, 4.6], [0, 4.6]])) },
    { name: "Bedroom", part: 0, pts: turn(jitter([[6.32, 0], [9.6, 0], [9.6, 3.4], [6.32, 3.4]])) },
    { name: "Bathroom", part: 0, pts: turn(jitter([[6.32, 3.52], [9.6, 3.52], [9.6, 4.6], [6.32, 4.6]])) },
    { name: "Hallway", part: 0, pts: turn(jitter([[0, 4.72], [9.6, 4.72], [9.6, 5.9], [0, 5.9]])) },
  ], doors: [
    { part: 0, a: turn([[6.25, 1.2]])[0], b: turn([[6.25, 2.05]])[0] },
    { part: 0, a: turn([[3.6, 4.66]])[0], b: turn([[4.45, 4.66]])[0] },
    { part: 0, a: turn([[7.0, 4.66]])[0], b: turn([[7.75, 4.66]])[0] },
  ] };
  showPlan();
  $("#plan-title").textContent = "Sample plan";
  $("#plan-status").textContent = "A made-up flat, to show what a scan gives. Start over to scan your own.";
}

// ---------- start ----------
$("#sample").addEventListener("click", sample);
$("#go").addEventListener("click", startAR);
$("#more").addEventListener("click", () => { if (navigator.xr) startAR(); });
$("#restart").addEventListener("click", () => {
  scan = { rooms: [], doors: [], place: {}, parts: 0 }; save();
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "start"));
});
$("#pdf").addEventListener("click", savePDF);
$("#json").addEventListener("click", saveJSON);

if (location.hash === "#sample") sample();  // a link straight to the sample plan

(async () => {
  const go = $("#go"), note = $("#support");
  if (scan.rooms.length) {
    const r = $("#resume"); r.hidden = false;
    r.innerHTML = "";
    const b = document.createElement("button"); b.className = "btn secondary"; b.type = "button"; b.textContent = `Open your plan (${scan.rooms.length} room${scan.rooms.length === 1 ? "" : "s"})`;
    b.addEventListener("click", showPlan); r.append(b);
  }
  const ok = navigator.xr && await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  if (ok) { go.disabled = false; go.textContent = "Start scanning"; note.textContent = "This phone can scan in AR."; }
  else { go.textContent = "AR not available"; note.textContent = "This browser can't scan in AR. Open this page in Chrome on an Android phone with Google Play Services for AR. You can still look at the sample plan."; note.classList.add("bad"); }
})();
