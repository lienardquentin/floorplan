// Floor Plan: scan rooms in AR (WebXR hit tests on the floor), turn the taps into a clean 2D plan, edit it, save it as a
// PDF. Everything happens on the phone; the only things fetched are this page and its two libraries.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);
const KEY = "floorplan-v2";

// ---------- the plan, kept on this phone ----------
// rooms: [{name, pts: [[x, y], ...], open: [edge indices with no wall]}] in metres, squared up; doors: [{room, edge, t,
// w}]: on that room's wall, centred at t (0 to 1 along it), w metres wide. A scan is cleaned up once, when it ends, and
// added to the plan; from then on the plan is what's edited.
let fp = { rooms: [], doors: [] };  // loaded at the end of this file, once everything it needs is defined

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
// The floor's height is found first (ARCore's feature points within a second, its detected planes refining it); from
// then on the ring is where the screen's centre meets the floor, worked out each frame, so it follows smoothly anywhere.
// Each corner is an AR anchor: when ARCore corrects its tracking, the corners move with the world instead of drifting.
let renderer, scene, camera, reticle, guide, group, hitSource = null, session = null, xrRef = null;
let floorY = null, floorFromPlane = false, floorSamples = [], tracking = false, onFloor = false;
let doorMode = false, doorPts = [], current = [], pending = null, snap = null, dirty = false;
let lostAt = null, realign = null, anchorsOn = false, reanchor = false;  // realign: after tracking was lost, {targets, taps}
let live = { rooms: [], doors: [] };  // this scan's rooms (corners) and doorways, in the AR session's own frame
const at = new THREE.Vector3(), aim = new THREE.Vector3(), seen = new THREE.Vector3(), q = new THREE.Quaternion(), fwd = new THREE.Vector3();
const corner = (p) => ({ p, anchor: null });  // p: [x, z] on the floor; anchor: kept by ARCore, moves p when tracking corrects

function setupThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.style.display = "none";
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 60);
  reticle = new THREE.Group();
  reticle.add(new THREE.Mesh(new THREE.RingGeometry(0.075, 0.1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb454 })));
  reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff })));
  reticle.visible = false;
  guide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.06, gapSize: 0.04 }));
  guide.visible = false;
  group = new THREE.Group();
  scene.add(reticle, guide, group);
}

function line(points, color, closed = false) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, floorY + 0.006, z)));
  return new (closed ? THREE.LineLoop : THREE.Line)(geo, new THREE.LineBasicMaterial({ color }));
}
function dot([x, z], color, size = 0.035) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, floorY + size, z);
  return m;
}

function redraw() {
  dirty = false;
  group.clear();
  if (floorY === null) return;
  for (const r of live.rooms) {
    group.add(line(r.corners.map((c) => c.p), 0x7fb6ff, true));
    r.corners.forEach((c) => group.add(dot(c.p, 0x7fb6ff, 0.025)));
  }
  for (const d of live.doors) group.add(line([d.a.p, d.b.p], 0x7dd38a));
  if (current.length) {
    group.add(line(current.map((c) => c.p), 0xffb454));
    current.forEach((c, i) => group.add(dot(c.p, i === 0 && current.length >= 3 ? 0xffffff : 0xffb454, i === 0 ? 0.045 : 0.035)));
  }
  doorPts.forEach((c) => group.add(dot(c.p, 0x7dd38a)));
  if (realign) realign.targets.forEach((c, i) => { if (i >= realign.taps.length) group.add(dot(c.p, 0xff5fd2, 0.06)); });
}

const allCorners = () => [...live.rooms.flatMap((r) => r.corners), ...live.doors.flatMap((d) => [d.a, d.b]), ...current, ...doorPts];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function findFloor(frame, camY) {
  // the floor's height: horizontal planes when ARCore has found one, feature points well below the phone until then;
  // refined until the first corner is placed, then kept (the anchors take care of the rest)
  if (!hitSource || (allCorners().length && !realign && floorY !== null)) return;
  for (const hit of frame.getHitTestResults(hitSource)) {
    const m = hit.getPose(xrRef)?.transform.matrix;
    if (!m) continue;
    const plane = m[5] > 0.95 && (hit.entityType === undefined || hit.entityType === "plane");
    if (plane) {
      if (!floorFromPlane) { floorSamples = []; floorFromPlane = true; }
      floorSamples.push(m[13]);
    } else if (!floorFromPlane && m[13] < camY - 0.7) {
      floorSamples.push(m[13]);
    }
  }
  floorSamples = floorSamples.slice(-30);
  if (floorSamples.length >= (floorFromPlane ? 2 : 8)) floorY = median(floorSamples);
}

function aimAtFloor(pose) {
  // where the screen's centre meets the floor (nothing when the phone points too high, or further than 8 m)
  const { position: p, orientation: o } = pose.transform;
  q.set(o.x, o.y, o.z, o.w);
  fwd.set(0, 0, -1).applyQuaternion(q);
  if (fwd.y > -0.08) return false;
  const t = (floorY - p.y) / fwd.y;
  if (t <= 0 || t > 8) return false;
  aim.set(p.x + fwd.x * t, floorY, p.z + fwd.z * t);
  return true;
}

function snapAim() {
  // close to the room's first corner: onto it (and the button closes the room); otherwise, within 10° of square to the
  // last wall: onto the exact right angle or straight line, with a guide
  snap = null;
  if (realign) return;
  if (!doorMode && current.length >= 3 && Math.hypot(aim.x - current[0].p[0], aim.z - current[0].p[1]) < 0.25) {
    aim.x = current[0].p[0]; aim.z = current[0].p[1]; snap = "close"; return;
  }
  if (doorMode || current.length < 2) return;
  const a = current[current.length - 2].p, b = current[current.length - 1].p;
  const ux = b[0] - a[0], uz = b[1] - a[1], ul = Math.hypot(ux, uz) || 1;
  const vx = aim.x - b[0], vz = aim.z - b[1], vl = Math.hypot(vx, vz);
  if (vl < 0.2) return;
  const ang = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (ul * vl)))) * 180 / Math.PI;
  for (const target of [90, 0, 180]) {
    if (Math.abs(ang - target) < 10) {
      let dx = ux / ul, dz = uz / ul;
      if (target === 90) { const s = Math.sign(dx * vz - dz * vx) || 1; [dx, dz] = [-dz * s, dx * s]; }
      else if (target === 180) { dx = -dx; dz = -dz; }
      const along = vx * dx + vz * dz;
      aim.x = b[0] + dx * along; aim.z = b[1] + dz * along; snap = "square"; return;
    }
  }
}

function startRealign() {
  // tracking was lost (or ARCore restarted its map): the scan no longer sits on the room. The two corners placed last
  // are tapped again; their move gives the turn and shift that put every point back
  const placed = [...current, ...(live.rooms.length ? live.rooms.at(-1).corners : [])];
  const targets = current.length >= 2 ? [current.at(-1), current.at(-2)] : placed.slice(-2).reverse();
  if (!targets.length) return;
  realign = { targets, taps: [] };
  floorY = null; floorFromPlane = false; floorSamples = [];  // the floor's height may have changed with the new map
  $("#skipalign").hidden = false;
  navigator.vibrate?.([30, 50, 30]);
  dirty = true;
}

function finishRealign() {
  const { targets, taps } = realign;
  let turn = 0;
  if (targets.length >= 2 && taps.length >= 2) {
    turn = Math.atan2(taps[1][1] - taps[0][1], taps[1][0] - taps[0][0]) - Math.atan2(targets[1].p[1] - targets[0].p[1], targets[1].p[0] - targets[0].p[0]);
  }
  const o = targets[0].p, n = taps[0], c = Math.cos(turn), sn = Math.sin(turn);
  const fresh = new Set();
  for (const k of allCorners()) {
    if (fresh.has(k)) continue;  // a corner shared by two lists is moved once
    fresh.add(k);
    const dx = k.p[0] - o[0], dz = k.p[1] - o[1];
    k.p = [n[0] + dx * c - dz * sn, n[1] + dx * sn + dz * c];
    try { k.anchor?.delete(); } catch { /* gone with the old map */ }
    k.anchor = null;
  }
  realign = null; reanchor = true;  // anchored again in the next frame, in the new map
  $("#skipalign").hidden = true;
  navigator.vibrate?.([15, 40, 15]);
  dirty = true;
}

function onFrame(_, frame) {
  if (!frame) return renderer.render(scene, camera);
  const pose = frame.getViewerPose(xrRef);
  tracking = !!pose && !pose.emulatedPosition;
  if (!tracking) lostAt ??= performance.now();
  else if (lostAt !== null) {  // back: a real loss (not a flicker) means the scan may have moved
    if (performance.now() - lostAt > 700 && allCorners().length && !realign) startRealign();
    lostAt = null;
  }
  if (reanchor && frame.createAnchor) {
    reanchor = false;
    for (const k of new Set(allCorners())) frame.createAnchor(new XRRigidTransform({ x: k.p[0], y: floorY ?? 0, z: k.p[1] }), xrRef).then((a) => { k.anchor = a; }).catch(() => {});
  }
  // the anchors: where ARCore now puts each corner
  if (frame.trackedAnchors && !realign) for (const c of allCorners()) {
    if (!c.anchor || !frame.trackedAnchors.has(c.anchor)) continue;
    const ap = frame.getPose(c.anchor.anchorSpace, xrRef);
    if (!ap) continue;
    const { x, z } = ap.transform.position;
    if (Math.hypot(x - c.p[0], z - c.p[1]) > 0.01) { c.p = [x, z]; dirty = true; }
  }
  onFloor = false;
  if (tracking) {
    findFloor(frame, pose.transform.position.y);
    if (floorY !== null && aimAtFloor(pose)) {
      snapAim();
      if (!reticle.visible || snap) seen.copy(aim); else seen.lerp(aim, 0.45);  // glides, but snaps exactly
      reticle.position.copy(seen).setY(floorY + 0.004);
      reticle.children[0].material.color.set(snap === "close" ? 0xffffff : snap === "square" ? 0x7dd38a : 0xffb454);
      at.copy(seen);
      onFloor = true;
    }
  }
  reticle.visible = onFloor;
  $("#add").classList.toggle("waiting", !onFloor);
  $("#add").textContent = realign ? "Here's that corner" : snap === "close" ? "Close room" : doorMode ? "Add doorway side" : "Add corner";
  if (pending && onFloor) addHere(frame);
  pending = null;
  const list = doorMode ? doorPts : current, last = list[list.length - 1];
  guide.visible = !!(onFloor && last);
  if (guide.visible) {
    guide.geometry.setFromPoints([new THREE.Vector3(last.p[0], floorY + 0.006, last.p[1]), new THREE.Vector3(at.x, floorY + 0.006, at.z)]);
    guide.computeLineDistances();
    guide.material.color.set(snap === "square" ? 0x7dd38a : 0xffffff);
  }
  if (dirty) redraw();
  hint(last);
  renderer.render(scene, camera);
}

function hint(last) {
  const n = live.rooms.length;
  let h, s = `${n} room${n === 1 ? "" : "s"} in this scan`;
  if (!tracking) { h = "Hold still: point at something with texture so tracking can recover"; s = "Tracking lost: adding is paused"; }
  else if (realign && floorY === null) { h = "Tracking is back. Sweep the floor so it can be found again"; s = "Lining the scan back up"; }
  else if (realign) {
    const two = realign.targets.length >= 2;
    h = realign.taps.length === 0 ? `Tap the pink corner again${two ? " (the last one you placed)" : ""}, on the real corner` : "Now the second pink corner, on the real corner";
    s = "Lining the scan back up · or Looks right if the lines already sit on the room";
  }
  else if (floorY === null) { h = "Sweep the phone slowly over the floor"; s = "Looking for the floor…"; }
  else if (!onFloor) h = "Aim lower: the ring sits where the centre of the screen meets the floor";
  else if (doorMode) h = doorPts.length ? "Now the other side of the doorway" : "Tap one side of the doorway";
  else if (snap === "close") h = "On the first corner: tap to close the room";
  else if (!current.length) h = "Put the ring on a corner, where the wall meets the floor, and tap";
  else h = current.length < 3 ? "Next corner, going round the room" : "Next corner, or back to the first to close";
  if (onFloor && last) s = `${Math.hypot(at.x - last.p[0], at.z - last.p[1]).toFixed(2)} m${snap === "square" ? " · square" : ""} · ${s}`;
  else if (tracking && floorY !== null) s = `Floor found${floorFromPlane ? "" : " (refining)"} · ${s}`;
  if (!realign && allCorners().length) s += anchorsOn ? " · anchored" : " · no anchors on this phone";
  $("#hint").textContent = h;
  $("#sub").textContent = s;
}

function addHere(frame) {
  if (realign) {  // a realigning tap, not a new corner
    realign.taps.push([at.x, at.z]);
    navigator.vibrate?.(15);
    if (realign.taps.length >= Math.min(2, realign.targets.length)) finishRealign();
    return;
  }
  // a corner where the ring is, anchored in the world when the phone supports anchors
  const c = corner([at.x, at.z]);
  frame.createAnchor?.(new XRRigidTransform({ x: at.x, y: floorY, z: at.z }), xrRef)?.then((a) => { c.anchor = a; anchorsOn = true; }).catch(() => {});
  navigator.vibrate?.(snap === "close" ? [15, 40, 15] : 15);
  if (doorMode) {
    doorPts.push(c);
    if (doorPts.length === 2) {
      live.doors.push({ a: doorPts[0], b: doorPts[1] });
      doorPts = []; doorMode = false;
      $("#door").textContent = "Doorway";
    }
  } else if (snap === "close") {
    c.anchor = null;  // the room closes on its first corner: nothing new to keep
    askName();
  } else {
    current.push(c);
  }
  dirty = true;
}

function requestAdd() {
  if (!onFloor) {  // never silent: say why nothing was added
    $("#hint").textContent = !tracking ? "Tracking is lost: hold still a moment" : floorY === null ? "The floor isn't found yet: sweep the phone slowly over it" : "Aim lower, at the floor";
    navigator.vibrate?.([10, 60, 10]);
    return;
  }
  pending = true;  // added in the next frame, where an anchor can be made
}

function askName() {
  if (current.length < 3) { $("#hint").textContent = "A room needs at least 3 corners"; return; }
  $("#namebox").classList.add("on");
  $("#roomname").value = "";
  $("#roomname").placeholder = `Room ${fp.rooms.length + live.rooms.length + 1}`;
  $("#roomname").focus();
}

async function startAR() {
  if (!renderer) setupThree();
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay", "anchors"], domOverlay: { root: $("#overlay") },
    });
  } catch (e) {
    $("#support").textContent = `Couldn't start AR: ${e.message || e}`;
    $("#support").classList.add("bad");
    return;
  }
  floorY = null; floorFromPlane = false; floorSamples = []; current = []; doorPts = []; doorMode = false; pending = null;
  live = { rooms: [], doors: [] }; reticle.visible = false; seen.set(0, 0, 0);
  lostAt = null; realign = null; anchorsOn = false; reanchor = false; $("#skipalign").hidden = true;
  renderer.xr.setReferenceSpaceType("local");
  await renderer.xr.setSession(session);
  xrRef = renderer.xr.getReferenceSpace();
  xrRef.addEventListener?.("reset", () => { if (allCorners().length && !realign) startRealign(); });  // ARCore moved the origin
  const viewer = await session.requestReferenceSpace("viewer");
  try { hitSource = await session.requestHitTestSource({ space: viewer, entityTypes: ["plane", "point"] }); }
  catch { hitSource = await session.requestHitTestSource({ space: viewer }); }
  session.addEventListener("select", requestAdd);  // a tap anywhere on the camera view adds a corner too
  $("#overlay").classList.add("on");
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
  redraw();
  renderer.setAnimationLoop(onFrame);
  session.addEventListener("end", () => {
    renderer.setAnimationLoop(null);
    hitSource = null; session = null;
    $("#overlay").classList.remove("on");
    $("#namebox").classList.remove("on");
    if (current.length >= 3) live.rooms.push({ name: `Room ${fp.rooms.length + live.rooms.length + 1}`, corners: current });
    current = []; doorPts = [];
    const rooms = live.rooms.map((r) => ({ name: r.name, pts: r.corners.map((c) => c.p) }));
    const doors = live.doors.map((d) => ({ a: d.a.p, b: d.b.p }));
    if (rooms.length) { remember(); add(fp, rooms, doors); save(); view = null; }
    showPlan();
  });
}

// anything that goes wrong is shown, in the AR view and on the page, rather than failing silently
const showError = (msg) => {
  const text = `Something went wrong: ${msg}`;
  if ($("#overlay").classList.contains("on")) $("#sub").textContent = text;
  const st = $("#support"); if (st) { st.textContent = text; st.classList.add("bad"); }
  const ps = $("#plan-status"); if (ps) ps.textContent = text;
};
window.addEventListener("error", (e) => showError(e.message || e.error));
window.addEventListener("unhandledrejection", (e) => showError(e.reason?.message || e.reason));

// the overlay's buttons must not also count as taps on the camera view
$("#overlay").addEventListener("beforexrselect", (e) => e.preventDefault());

$("#add").addEventListener("click", requestAdd);
const forget = (c) => { try { c.anchor?.delete(); } catch { /* already gone */ } };
$("#undo").addEventListener("click", () => {
  if (doorMode && doorPts.length) forget(doorPts.pop());
  else if (doorMode) { doorMode = false; $("#door").textContent = "Doorway"; }
  else if (current.length) forget(current.pop());
  else if (live.doors.length) { const d = live.doors.pop(); forget(d.a); forget(d.b); }
  else if (live.rooms.length) current = live.rooms.pop().corners;
  dirty = true;
});
$("#close").addEventListener("click", askName);
$("#skipalign").addEventListener("click", () => {  // the lines already sit on the room: carry on as they are
  realign = null; $("#skipalign").hidden = true;
  if (floorY === null && floorSamples.length) floorY = median(floorSamples);
  dirty = true;
});
$("#savename").addEventListener("click", () => {
  live.rooms.push({ name: $("#roomname").value.trim() || $("#roomname").placeholder, corners: current });
  current = [];
  $("#namebox").classList.remove("on");
  $("#roomname").blur();
  dirty = true;
});
$("#roomname").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#savename").click(); });
$("#door").addEventListener("click", () => {
  doorMode = !doorMode; doorPts.forEach(forget); doorPts = [];
  $("#door").textContent = doorMode ? "Cancel door" : "Doorway";
  dirty = true;
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
  return best && best.dist < 1.2 && best.w > 0.4 ? { room: best.room, edge: best.edge, t: +best.t.toFixed(3), w: +best.w.toFixed(2), type: "door", hinge: 0, swing: 1 } : null;
}

// ---------- editing the plan ----------
// What's selected: {room}, {room, edge}, {room, corner} or {door}. Tools: "select", "door", "window", "room".
let history = [], sel = null, tool = "select";
const DOOR_W = { door: 0.83, opening: 0.9, window: 1.2 };

function remember() {
  history.push(JSON.stringify(fp));
  if (history.length > 80) history.shift();
}
function undoEdit() {
  if (!history.length) return;
  fp = JSON.parse(history.pop());
  sel = null; save(); showPlan();
}
const elements = () => fp.doors;  // doors, openings and windows: {room, edge, t, w, type, hinge (0 start, 1 end), swing (1 in, -1 out)}
const fixElement = (d) => ({ type: "door", hinge: 0, swing: 1, ...d });

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
const isOpen = (ri, ei) => twins(ri, ei).some(([rj, ej]) => (fp.rooms[rj].open || []).includes(ej));

function setOpen(ri, ei, open) {
  // no wall here (open-plan), on both rooms' sides of a shared wall
  remember();
  for (const [rj, ej] of twins(ri, ei)) {
    const r = fp.rooms[rj];
    r.open = (r.open || []).filter((e) => e !== ej);
    if (open) r.open.push(ej);
  }
  save(); showPlan();
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
  // what's on the wall keeps its distance from the wall's start
  for (const e of elements()) if (e.room === ri && e.edge === ei) e.t = Math.min(1 - e.w / 2 / L, Math.max(e.w / 2 / L, e.t * l / L));
  save(); showPlan();
}

function splitWall(ri, ei) {
  // a corner in the middle of the wall, to make an L-shape or an alcove (drag it afterwards)
  remember();
  const r = fp.rooms[ri], a = r.pts[ei], b = next(r, ei);
  r.pts.splice(ei + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  r.open = (r.open || []).flatMap((e) => (e < ei ? [e] : e === ei ? [ei, ei + 1] : [e + 1]));
  for (const d of elements()) if (d.room === ri) {
    if (d.edge > ei) d.edge += 1;
    else if (d.edge === ei) { if (d.t < 0.5) d.t *= 2; else { d.edge = ei + 1; d.t = (d.t - 0.5) * 2; } }
  }
  sel = { room: ri, corner: ei + 1 };
  save(); showPlan();
}

function deleteCorner(ri, k) {
  // the corner goes; its two walls become one, and what was on them moves onto it
  const r = fp.rooms[ri], n = r.pts.length;
  if (n <= 3) { $("#plan-status").textContent = "A room needs at least 3 corners."; return; }
  remember();
  const prev = (k - 1 + n) % n, gone = r.pts[k], merged = (pt) => {  // where a point on the old walls lands on the new one
    const a = r.pts[prev], b = r.pts[(k + 1) % n], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1e-9;
    return Math.max(0, Math.min(1, ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / l2));
  };
  const at = (e, t) => { const a = r.pts[e], b = next(r, e); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
  for (const d of elements()) if (d.room === ri && (d.edge === prev || d.edge === k)) { d.t = merged(at(d.edge, d.t)); d.edge = prev; }
  r.pts.splice(k, 1);
  const fixEdge = (e) => (e > k ? e - 1 : e === k ? (prev > k ? prev - 1 : prev) : e);
  for (const d of elements()) if (d.room === ri) d.edge = fixEdge(d.edge);
  r.open = [...new Set((r.open || []).filter((e) => e !== k).map(fixEdge))];
  void gone;
  sel = { room: ri };
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
  fp.doors = elements().filter((d) => d.room !== ri).map((d) => ({ ...d, room: d.room > ri ? d.room - 1 : d.room }));
  sel = null; save(); showPlan();
}
function addRoom(a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return false;
  remember();
  fp.rooms.push({ name: `Room ${fp.rooms.length + 1}`, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], open: [] });
  sel = { room: fp.rooms.length - 1 };
  save(); return true;
}

function addElement(ri, ei, t, type) {
  const r = fp.rooms[ri], l = len(r.pts[ei], next(r, ei)), w = Math.min(DOOR_W[type], l - 0.1);
  if (w < 0.3) { $("#plan-status").textContent = "That wall is too short for it."; return; }
  remember();
  fp.doors.push({ room: ri, edge: ei, t: Math.min(1 - w / 2 / l, Math.max(w / 2 / l, t)), w: +w.toFixed(2), type, hinge: 0, swing: 1 });
  sel = { door: fp.doors.length - 1 };
  save(); showPlan();
}
function editElement(i, change) {
  remember();
  const d = fp.doors[i], r = fp.rooms[d.room], l = len(r.pts[d.edge], next(r, d.edge));
  Object.assign(d, change);
  d.w = +Math.max(0.3, Math.min(d.w, l - 0.05)).toFixed(2);
  d.t = Math.min(1 - d.w / 2 / l, Math.max(d.w / 2 / l, d.t));
  save(); showPlan();
}
function deleteElement(i) { remember(); fp.doors.splice(i, 1); sel = null; save(); showPlan(); }

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
function snapPoint(ri, k, p) {
  // a dragged corner: onto another corner's line within 10 cm, else onto a 5 cm grid
  const others = fp.rooms.flatMap((r, j) => r.pts.filter((_, m) => !(j === ri && m === k)));
  return [0, 1].map((ax) => {
    let best = null;
    for (const q of others) { const gap = q[ax] - p[ax]; if (Math.abs(gap) < 0.1 && (best === null || Math.abs(gap) < Math.abs(best))) best = gap; }
    return best === null ? Math.round(p[ax] / 0.05) * 0.05 : p[ax] + best;
  });
}
const tOn = (r, e, p) => {  // how far along wall e a point falls, 0 to 1
  const a = r.pts[e], b = next(r, e), vx = b[0] - a[0], vy = b[1] - a[1];
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1e-9)));
};

// ---------- the drawing, once, for the screen (SVG) and the PDF: primitives in metres ----------
function elementShape(d, i) {
  // a door: the gap, its leaf from the hinge (into or out of the room) and the swing's arc; an opening: the gap with two
  // jambs; a window: the gap with the glass's three thin lines
  const r = fp.rooms[d.room];
  if (!r || !r.pts[d.edge]) return null;
  const a = r.pts[d.edge], b = next(r, d.edge), l = len(a, b) || 1, ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
  const mid = [a[0] + (b[0] - a[0]) * d.t, a[1] + (b[1] - a[1]) * d.t], h = Math.min(d.w, l) / 2;
  const p = [mid[0] - ux * h, mid[1] - uy * h], q = [mid[0] + ux * h, mid[1] + uy * h], n0 = inward(r, d.edge);
  const shape = { kind: d.type || "door", i, a: p, b: q, mid, u: [ux, uy], n: n0 };
  if (shape.kind === "door") {
    const n = [n0[0] * (d.swing || 1), n0[1] * (d.swing || 1)], w = 2 * h;
    const hinge = d.hinge ? q : p, towards = d.hinge ? [-ux, -uy] : [ux, uy];
    const arc = [];
    for (let k = 0; k <= 14; k++) { const t = (k / 14) * Math.PI / 2; arc.push([hinge[0] + w * (towards[0] * Math.cos(t) + n[0] * Math.sin(t)), hinge[1] + w * (towards[1] * Math.cos(t) + n[1] * Math.sin(t))]); }
    shape.hinge = hinge; shape.arc = arc; shape.leaf = [hinge, arc.at(-1)];
  }
  return shape;
}

function drawing() {
  const out = [];
  fp.rooms.forEach((r, ri) => out.push({ kind: "fill", pts: r.pts, room: ri }));
  fp.rooms.forEach((r, ri) => r.pts.forEach((a, ei) => out.push({ kind: "wall", a, b: next(r, ei), room: ri, edge: ei, open: isOpen(ri, ei) })));
  elements().forEach((d, i) => { const s = elementShape(fixElement(d), i); if (s) out.push(s); });
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
const pointers = new Map();

function frameView() {
  const b = bounds(fp.rooms), pad = 0.8;
  view = { x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + 2 * pad, h: b.y1 - b.y0 + 2 * pad + 0.6 };
}
function zoom(f, about) {
  const c = about || [view.x + view.w / 2, view.y + view.h / 2];
  const w = Math.min(60, Math.max(1.5, view.w * f)), k = w / view.w;
  view = { x: c[0] - (c[0] - view.x) * k, y: c[1] - (c[1] - view.y) * k, w, h: view.h * k };
  render();
}

function showPlan() {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "planview"));
  fp.doors = elements().map(fixElement);
  if (!fp.rooms.length && tool !== "room") {
    if (!view) view = { x: 0, y: 0, w: 6, h: 4 };
  } else if (!view) frameView();
  render();
  const total = fp.rooms.reduce((s, r) => s + area(r.pts), 0), nd = fp.doors.filter((d) => d.type !== "window").length, nw = fp.doors.length - nd;
  $("#totals").textContent = fp.rooms.length ? `${fp.rooms.length} room${fp.rooms.length === 1 ? "" : "s"} · ${total.toFixed(1)} m² · ${nd} door${nd === 1 ? "" : "s"}${nw ? ` · ${nw} window${nw === 1 ? "" : "s"}` : ""}` : "No rooms yet";
  $("#undo-edit").disabled = !history.length;
  document.querySelectorAll("#tools [data-tool]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tool === tool));
  panel();
}

function render() {
  const S = 100;  // drawn in centimetres
  svg.setAttribute("viewBox", `${view.x * S} ${view.y * S} ${view.w * S} ${view.h * S}`);
  const px = (svg.getBoundingClientRect().width || 360) / (view.w * S);  // screen pixels per unit, for touch sizes
  const P = (pt) => `${(pt[0] * S).toFixed(1)},${(pt[1] * S).toFixed(1)}`;
  const L = (a, b, extra) => `<line x1="${a[0] * S}" y1="${a[1] * S}" x2="${b[0] * S}" y2="${b[1] * S}" ${extra}/>`;
  const out = [], hits = [];
  const placing = tool === "door" || tool === "window";
  for (const s of drawing()) {
    const roomSel = sel && sel.room === s.room && sel.edge === undefined && sel.corner === undefined;
    if (s.kind === "fill") out.push(`<polygon points="${s.pts.map(P).join(" ")}" fill="${roomSel ? "#e6f0ff" : "#ffffff"}" data-room="${s.room}"/>`);
    else if (s.kind === "wall") {
      const chosen = sel && sel.room === s.room && sel.edge === s.edge;
      out.push(s.open ? L(s.a, s.b, `stroke="${chosen ? "#ff9d2e" : "#b9b0a0"}" stroke-width="${chosen ? 6 : 3}" stroke-dasharray="10 8"`)
                      : L(s.a, s.b, `stroke="${chosen ? "#ff9d2e" : "#1d2533"}" stroke-width="9" stroke-linecap="square"`));
      const r = fp.rooms[s.room], bb = bounds([r]), most = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * S / 3;
      hits.push(L(s.a, s.b, `stroke="transparent" stroke-width="${Math.min((placing ? 30 : 18) / px, most)}" data-room="${s.room}" data-edge="${s.edge}" style="cursor:${placing ? "copy" : "pointer"}"`));
    } else if (["door", "opening", "window"].includes(s.kind)) {
      const chosen = sel && sel.door === s.i, ink = chosen ? "#ff9d2e" : "#8b94a3";
      out.push(L(s.a, s.b, `stroke="#ffffff" stroke-width="12"`));
      if (s.kind === "door") {
        out.push(`<polyline points="${s.arc.map(P).join(" ")}" fill="none" stroke="${ink}" stroke-width="2" stroke-dasharray="6 4"/>`);
        out.push(L(s.leaf[0], s.leaf[1], `stroke="${ink}" stroke-width="3.5"`));
      } else if (s.kind === "opening") {
        for (const e of [s.a, s.b]) out.push(L([e[0] - s.n[0] * 0.07, e[1] - s.n[1] * 0.07], [e[0] + s.n[0] * 0.07, e[1] + s.n[1] * 0.07], `stroke="${chosen ? ink : "#1d2533"}" stroke-width="3"`));
      } else {
        for (const o of [-0.045, 0, 0.045]) out.push(L([s.a[0] + s.n[0] * o, s.a[1] + s.n[1] * o], [s.b[0] + s.n[0] * o, s.b[1] + s.n[1] * o], `stroke="${chosen ? ink : "#4b84c4"}" stroke-width="${o ? 2 : 1.5}"`));
      }
      hits.push(L(s.a, s.b, `stroke="transparent" stroke-width="${Math.max(24 / px, 20)}" stroke-linecap="round" data-door="${s.i}" style="cursor:grab"`));
      if (chosen) hits.push(`<circle cx="${s.mid[0] * S}" cy="${s.mid[1] * S}" r="${Math.max(9, 10 / px)}" fill="#ff9d2e" stroke="#fff" stroke-width="${3 / px}" data-door="${s.i}" style="cursor:grab"/>`);
    } else if (s.kind === "length") {
      const deg = (s.angle * 180 / Math.PI + 360) % 180, up = deg > 90 ? deg - 180 : deg;
      out.push(`<text transform="translate(${s.at[0] * S} ${s.at[1] * S}) rotate(${up})" text-anchor="middle" dominant-baseline="middle" font-size="14" fill="#7a6f5a" font-family="IBM Plex Mono, monospace" pointer-events="none">${s.text}</text>`);
    } else if (s.kind === "name") {
      out.push(`<text x="${s.at[0] * S}" y="${s.at[1] * S - 6}" text-anchor="middle" font-size="22" font-weight="700" fill="#1d2533" font-family="Archivo, sans-serif" pointer-events="none">${esc(s.name)}</text>`);
      out.push(`<text x="${s.at[0] * S}" y="${s.at[1] * S + 20}" text-anchor="middle" font-size="17" fill="#5d6675" font-family="IBM Plex Mono, monospace" pointer-events="none">${s.area.toFixed(1)} m²</text>`);
    }
  }
  if (sel && sel.room !== undefined && sel.edge === undefined && fp.rooms[sel.room]) {  // the room's corners, to drag or tap
    fp.rooms[sel.room].pts.forEach((p, k) => {
      const on = sel.corner === k;
      hits.push(`<circle cx="${p[0] * S}" cy="${p[1] * S}" r="${Math.max(9, (on ? 13 : 11) / px)}" fill="${on ? "#ffffff" : "#ff9d2e"}" stroke="${on ? "#ff9d2e" : "#ffffff"}" stroke-width="${3 / px}" data-room="${sel.room}" data-corner="${k}" style="cursor:grab"/>`);
    });
  }
  if (drag && drag.kind === "newroom" && drag.end) {
    const a = drag.start, b = drag.end, x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
    out.push(`<rect x="${x * S}" y="${y * S}" width="${Math.abs(b[0] - a[0]) * S}" height="${Math.abs(b[1] - a[1]) * S}" fill="rgba(255,157,46,.12)" stroke="#ff9d2e" stroke-width="${2 / px}" stroke-dasharray="${8 / px} ${6 / px}"/>`);
    out.push(`<text x="${(x + Math.abs(b[0] - a[0]) / 2) * S}" y="${(y + Math.abs(b[1] - a[1]) / 2) * S}" text-anchor="middle" font-size="${14 / px}" fill="#b0600c" font-family="IBM Plex Mono, monospace">${Math.abs(b[0] - a[0]).toFixed(2)} × ${Math.abs(b[1] - a[1]).toFixed(2)} m</text>`);
  }
  const bx = view.x * S + 30 / px, by = (view.y + view.h) * S - 30 / px;  // a 1 m scale bar, bottom left of the view
  out.push(`<g pointer-events="none" font-family="IBM Plex Mono, monospace" font-size="${13 / px}" fill="#5d6675"><rect x="${bx}" y="${by}" width="100" height="${6 / px}" fill="#1d2533"/><text x="${bx + 100 + 8 / px}" y="${by + 6 / px}">1 m</text></g>`);
  svg.innerHTML = out.join("") + hits.join("");
}

function panel() {
  const box = $("#edit");
  box.replaceChildren();
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (label, cls, fn) => { const b = h("button", `btn ${cls}`, label); b.type = "button"; b.onclick = fn; return b; };
  const done = () => button("Done", "secondary", () => { sel = null; showPlan(); });
  const number = (id, value, label, onSet) => {
    const row = h("div", "row inline"), f = h("input", "field");
    f.id = id; f.type = "number"; f.step = "0.01"; f.min = "0.1"; f.inputMode = "decimal"; f.value = value; f.setAttribute("aria-label", label);
    const set = button("Set", "secondary", () => onSet(parseFloat(f.value)));
    f.addEventListener("keydown", (e) => { if (e.key === "Enter") set.click(); });
    row.append(h("span", "unit label", label), f, h("span", "unit", "m"), set);
    return row;
  };
  const seg = (label, options, current, onPick) => {
    const g = h("div", "seg"); g.setAttribute("role", "group"); g.setAttribute("aria-label", label);
    g.style.gridTemplateColumns = `repeat(${options.length}, 1fr)`;
    for (const [value, text] of options) { const b = h("button", "", text); b.type = "button"; b.setAttribute("aria-pressed", current === value); b.onclick = () => onPick(value); g.append(b); }
    return g;
  };

  if (tool === "door" || tool === "window") {
    box.append(h("h2", "", tool === "door" ? "Adding a door" : "Adding a window"),
      h("p", "", `Tap a wall exactly where the ${tool} goes. Add as many as you like; then drag them along their wall and set them up.`),
      button("Back to selecting", "secondary", () => { tool = "select"; showPlan(); }));
    return;
  }
  if (tool === "room") {
    box.append(h("h2", "", "Drawing a room"), h("p", "", "Drag a rectangle on an empty part of the plan. It snaps to the 5 cm grid; reshape it afterwards by its corners."),
      button("Back to selecting", "secondary", () => { tool = "select"; showPlan(); }));
    return;
  }
  if (sel && sel.door !== undefined && fp.doors[sel.door]) {
    const i = sel.door, d = fp.doors[i], r = fp.rooms[d.room];
    const names = { door: "Door", opening: "Opening", window: "Window" };
    box.append(h("h2", "", `${names[d.type]} in ${r.name}`));
    box.append(seg("Type", [["door", "Door"], ["opening", "Opening"], ["window", "Window"]], d.type, (type) => editElement(i, { type, w: d.type === type ? d.w : DOOR_W[type] })));
    box.append(number("element-width", d.w.toFixed(2), "Width", (w) => editElement(i, { w })));
    if (d.type === "door") {
      const row = h("div", "row");
      row.append(button("Flip hinge", "secondary", () => editElement(i, { hinge: d.hinge ? 0 : 1 })),
                 button(d.swing === 1 ? "Swing out" : "Swing in", "secondary", () => editElement(i, { swing: -(d.swing || 1) })));
      box.append(row, h("p", "note", `Opens ${d.swing === 1 ? "into" : "out of"} ${r.name}, hinged on its ${d.hinge ? "far" : "near"} side. Drag it along the wall to move it.`));
    } else box.append(h("p", "note", "Drag it along the wall to move it."));
    const row = h("div", "row");
    row.append(button("Delete", "ghost", () => deleteElement(i)), done());
    box.append(row);
    return;
  }
  if (sel && sel.room !== undefined && fp.rooms[sel.room]) {
    const ri = sel.room, r = fp.rooms[ri];
    if (sel.edge !== undefined) {
      const a = r.pts[sel.edge], b = next(r, sel.edge), ei = sel.edge, on = elements().filter((d) => d.room === ri && d.edge === ei).length;
      box.append(h("h2", "", `Wall of ${r.name}`));
      box.append(number("wall-length", len(a, b).toFixed(2), "Length", (L) => setLength(ri, ei, L)));
      box.append(seg("What this wall is", [["wall", "Wall"], ["open", "No wall"]], isOpen(ri, ei) ? "open" : "wall", (k) => setOpen(ri, ei, k === "open")));
      const row = h("div", "row");
      row.append(button("+ Door here", "secondary", () => addElement(ri, ei, 0.5, "door")), button("+ Window here", "secondary", () => addElement(ri, ei, 0.5, "window")),
                 button("Add a corner", "secondary", () => splitWall(ri, ei)));
      box.append(row, h("p", "note", `${on ? `${on} door${on === 1 ? "" : "s"} or window${on === 1 ? "" : "s"} on this wall. ` : ""}Setting the length moves the far end (and the next corner, so right angles stay right). "No wall" applies to both rooms.`), done());
      return;
    }
    if (sel.corner !== undefined) {
      box.append(h("h2", "", `Corner of ${r.name}`), h("p", "", "Drag it to reshape the room; it snaps to other corners and a 5 cm grid."));
      const row = h("div", "row");
      row.append(button("Delete corner", "ghost", () => deleteCorner(ri, sel.corner)), button("Back to the room", "secondary", () => { sel = { room: ri }; showPlan(); }));
      box.append(row);
      return;
    }
    box.append(h("h2", "", "Room"));
    const name = h("input", "field"); name.id = "room-name"; name.value = r.name; name.setAttribute("aria-label", "Room name");
    name.addEventListener("change", () => { remember(); r.name = name.value.trim() || r.name; save(); showPlan(); });
    const row = h("div", "row");
    row.append(button("Turn 90°", "secondary", () => turnRoom(ri)), button("Delete room", "ghost", () => deleteRoom(ri)), done());
    box.append(name, h("p", "note", `${area(r.pts).toFixed(1)} m². Drag the room to move it (it snaps to its neighbours). Drag an orange corner to reshape it, or tap it to delete it. Tap a wall to add a corner in it.`), row);
    return;
  }
  box.append(h("h2", "", "Edit the plan"),
    h("p", "", "Tap a room, a wall, a corner or a door to change it. + Door and + Window place them where you tap a wall; + Room draws one. Drag empty space to move around, pinch or use the buttons to zoom."));
}

const toPlan = (x, y) => {
  const p = svg.createSVGPoint(); p.x = x; p.y = y;
  const q = p.matrixTransform(svg.getScreenCTM().inverse());
  return [q.x / 100, q.y / 100];
};

svg.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  svg.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {  // two fingers: pinch to zoom, move to pan (whatever one finger was doing stops)
    const [a, b] = [...pointers.values()];
    drag = { kind: "pinch", dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: toPlan((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), view: { ...view } };
    return;
  }
  const d = e.target.dataset || {}, p = toPlan(e.clientX, e.clientY);
  if ((tool === "door" || tool === "window") && d.edge !== undefined) {
    const r = fp.rooms[+d.room];
    addElement(+d.room, +d.edge, tOn(r, +d.edge, p), tool);
    tool = "select"; showPlan(); drag = null; return;
  }
  if (tool === "room" && d.room === undefined && d.door === undefined) {
    const g = (v) => Math.round(v / 0.05) * 0.05;
    drag = { kind: "newroom", start: [g(p[0]), g(p[1])] }; return;
  }
  if (d.door !== undefined) {
    sel = { door: +d.door };
    drag = { kind: "door-maybe", i: +d.door, start: p };
  } else if (d.corner !== undefined) {
    sel = { room: +d.room, corner: +d.corner };
    drag = { kind: "corner-maybe", room: +d.room, k: +d.corner, start: p };
  } else if (d.edge !== undefined) {
    sel = { room: +d.room, edge: +d.edge };
    drag = null;
  } else if (d.room !== undefined) {
    sel = { room: +d.room };
    drag = { kind: "room-maybe", room: +d.room, start: p, orig: fp.rooms[+d.room].pts.map((q) => [...q]) };
  } else {
    sel = null;
    drag = { kind: "pan", start: [e.clientX, e.clientY], view: { ...view } };
  }
  showPlan();
});

svg.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (!drag) return;
  if (drag.kind === "pinch") {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    view = { ...drag.view };
    zoom(drag.dist / Math.max(dist, 1), drag.mid);
    return;
  }
  if (drag.kind === "pan") {
    const k = view.w / (svg.getBoundingClientRect().width || 1);
    view = { ...drag.view, x: drag.view.x - (e.clientX - drag.start[0]) * k, y: drag.view.y - (e.clientY - drag.start[1]) * k };
    render(); return;
  }
  const p = toPlan(e.clientX, e.clientY);
  if (drag.kind === "newroom") { const g = (v) => Math.round(v / 0.05) * 0.05; drag.end = [g(p[0]), g(p[1])]; render(); return; }
  if (drag.kind.endsWith("-maybe")) {  // a tap until the finger has moved 8 cm on the plan
    if (Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) < 0.08) return;
    remember(); drag.kind = drag.kind.replace("-maybe", "");
  }
  if (drag.kind === "door") {
    const d = fp.doors[drag.i], r = fp.rooms[d.room], l = len(r.pts[d.edge], next(r, d.edge));
    d.t = Math.min(1 - d.w / 2 / l, Math.max(d.w / 2 / l, tOn(r, d.edge, p)));
  } else if (drag.kind === "corner") {
    fp.rooms[drag.room].pts[drag.k] = snapPoint(drag.room, drag.k, p);
  } else if (drag.kind === "room") {
    let dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    fp.rooms[drag.room].pts = drag.orig.map((q) => [q[0], q[1]]);
    [dx, dy] = snapMove(drag.room, dx, dy);
    fp.rooms[drag.room].pts = drag.orig.map((q) => [q[0] + dx, q[1] + dy]);
  }
  render();
});

const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (!drag) return;
  if (drag.kind === "pinch") { if (pointers.size === 0) drag = null; return; }
  const kind = drag.kind;
  if (kind === "newroom") {
    const made = drag.end && addRoom(drag.start, drag.end);
    drag = null;
    if (made) tool = "select";
    else $("#plan-status").textContent = "Drag a bigger rectangle (at least 50 cm a side) to draw a room.";
    showPlan(); return;
  }
  drag = null;
  if (["door", "corner", "room"].includes(kind)) save();
  showPlan();
};
svg.addEventListener("pointerup", endPointer);
svg.addEventListener("pointercancel", endPointer);
svg.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, toPlan(e.clientX, e.clientY)); }, { passive: false });

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
  for (const s of shapes.filter((s) => ["door", "opening", "window"].includes(s.kind))) {
    const a = X(s.a), bb = X(s.b);
    doc.setDrawColor(255, 255, 255); doc.setLineWidth(Math.max(0.9, 0.12 * k)); doc.line(a[0], a[1], bb[0], bb[1]);
    if (s.kind === "door") {
      doc.setDrawColor(139, 148, 163); doc.setLineWidth(0.25); doc.setLineDashPattern([1.2, 0.9], 0);
      const arc = s.arc.map(X); for (let i = 1; i < arc.length; i++) doc.line(arc[i - 1][0], arc[i - 1][1], arc[i][0], arc[i][1]);
      doc.setLineDashPattern([], 0); doc.setLineWidth(0.45);
      const l0 = X(s.leaf[0]), l1 = X(s.leaf[1]); doc.line(l0[0], l0[1], l1[0], l1[1]);
    } else if (s.kind === "opening") {
      doc.setDrawColor(29, 37, 51); doc.setLineWidth(0.4);
      for (const e of [s.a, s.b]) { const p0 = X([e[0] - s.n[0] * 0.07, e[1] - s.n[1] * 0.07]), p1 = X([e[0] + s.n[0] * 0.07, e[1] + s.n[1] * 0.07]); doc.line(p0[0], p0[1], p1[0], p1[1]); }
    } else {
      doc.setDrawColor(75, 132, 196);
      for (const o of [-0.045, 0, 0.045]) { doc.setLineWidth(o ? 0.3 : 0.2); const p0 = X([s.a[0] + s.n[0] * o, s.a[1] + s.n[1] * o]), p1 = X([s.b[0] + s.n[0] * o, s.b[1] + s.n[1] * o]); doc.line(p0[0], p0[1], p1[0], p1[1]); }
    }
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
  const top = (ri) => fp.rooms[ri].pts.findIndex((a, e) => { const b = next(fp.rooms[ri], e); return Math.abs(a[1] - b[1]) < 1e-6 && a[1] <= Math.min(...fp.rooms[ri].pts.map((p) => p[1])) + 1e-6; });
  fp.doors.push({ room: living, edge: top(living), t: 0.5, w: 1.4, type: "window", hinge: 0, swing: 1 });
  const bed = fp.rooms.findIndex((r) => r.name === "Bedroom");
  fp.doors.push({ room: bed, edge: top(bed), t: 0.55, w: 1.1, type: "window", hinge: 0, swing: 1 });
  view = null;
  showPlan();
  $("#plan-title").textContent = "Sample plan";
  $("#plan-status").textContent = "A made-up flat (the kitchen is open to the living room), to show what a scan gives. Start over to scan your own.";
}

// ---------- start ----------
$("#sample").addEventListener("click", sample);
$("#go").addEventListener("click", startAR);
$("#more").addEventListener("click", () => { if (navigator.xr) startAR(); });
$("#restart").addEventListener("click", () => {
  remember(); fp = { rooms: [], doors: [] }; sel = null; view = null; tool = "select"; save();
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== "start"));
});
$("#undo-edit").addEventListener("click", undoEdit);
$("#pdf").addEventListener("click", savePDF);
$("#json").addEventListener("click", saveJSON);
window.addEventListener("resize", () => { if (!$("#planview").hidden && view) render(); });
document.querySelectorAll("#tools [data-tool]").forEach((b) => b.addEventListener("click", () => { tool = tool === b.dataset.tool ? "select" : b.dataset.tool; sel = null; showPlan(); }));
$("#zoom-in").addEventListener("click", () => zoom(1 / 1.3));
$("#zoom-out").addEventListener("click", () => zoom(1.3));
$("#fit").addEventListener("click", () => { frameView(); render(); });

fp = load();
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
