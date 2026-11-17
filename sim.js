/* ApleFight shared game simulation.
 * The same file runs in the browser (offline practice and peer-to-peer host) and in Node (server.js),
 * so every mode plays by exactly the same physics and rules. Physics engine (cannon-es) is passed in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AppleSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICK = 1 / 60, SNAP_EVERY = 3;            // physics at 60 Hz, network snapshots at 20 Hz
  const MATCH_END_TIME = 10, WAIT_TIME = 8;
  const MAX_PLAYERS = 50, MAX_HP = 100;
  // a battle royale needs at least MIN_BR people (bots count); with fewer, the match is a respawn match instead
  const MIN_BR = 20, RESPAWN_MATCH_TIME = 420, RESPAWN_TIME = 3, REGROW_TIME = 45, RESPAWN_ALT = 55;
  // battle royale: everyone rides the plane, drops once, and the last one alive wins
  const ST = { lobby: 0, plane: 1, fall: 2, glide: 3, live: 4, dead: 5, spec: 6 };
  const ST_NAMES = Object.keys(ST);
  const PLANE_ALT = 140, PLANE_SPEED = 22, PLANE_HALF = 220, GLIDE_HEIGHT = 25, GLIDE_SINK = 3.2, FALL_SPEED = 18, GLIDE_SPEED = 14;
  // storm stages: wait (s), shrink (s), radius it shrinks to (m), damage per second while that stage is running
  const STORM_R0 = 260;   // covers the corners of the island
  const STORM = [
    // about 7 minutes from the drop until the circle is gone, so a match lasts roughly 5 to 8 minutes
    { wait: 75, shrink: 50, r: 140, dps: 1 }, { wait: 60, shrink: 45, r: 75, dps: 2 }, { wait: 45, shrink: 40, r: 38, dps: 4 },
    { wait: 35, shrink: 30, r: 16, dps: 6 }, { wait: 25, shrink: 25, r: 0, dps: 8 },
  ];
  // respawn matches are played inside a fixed circle around the centre so small groups still find each other
  const RESPAWN_ZONE = 90, RESPAWN_DPS = 5;
  const STORM_FINAL_DPS = 10;
  const G = { WORLD: 1, PLAYER: 2, PROP: 4, PROJ: 8, CORPSE: 16 };
  const SECRET = '//Ni//23//';
  const EYE = 0.7;                                 // eye height above the body centre (body centre is 0.9 m off the floor)
  const LEAN_DIST = 0.5, LEAN_DROP = 0.08;          // how far Q/E leaning moves your eye sideways (and down)

  const WEAPONS = [
    { name: 'Rifle', dmg: 20, rate: 0.1, mag: 30, reload: 1.8, spread: 0.01, pellets: 1, impulse: 7, range: 200 },
    { name: 'Shotgun', dmg: 11, rate: 0.85, mag: 6, reload: 2.2, spread: 0.065, pellets: 9, impulse: 4, range: 60 },
    { name: 'Apple Launcher', proj: true, rate: 0.9, mag: 4, reload: 2.6, speed: 24, fuse: 1.8, radius: 5.5, dmg: 95 },
    // the pickaxe harvests: full damage to trees, rocks, crates and builds; guns only do HARVEST_GUN of their damage to them
    { name: 'Pickaxe', melee: true, rate: 0.42, mag: 1, reload: 0, dmg: 20, harvest: 35, pieceDmg: 50, range: 2.7, impulse: 3 },
  ];
  const PICKAXE = 3, HARVEST_GUN = 0.25;
  const BOT_DIFF = {
    easy: { turn: 3, err: 0.12, react: 0.75, fireCone: 0.05 },
    normal: { turn: 5, err: 0.06, react: 0.45, fireCone: 0.04 },
    hard: { turn: 9, err: 0.025, react: 0.22, fireCone: 0.03 },
  };
  const BOT_NAMES = ['Crisp', 'Fuji', 'Gala', 'Honeycrisp', 'Granny Smith', 'Pink Lady', 'Braeburn', 'Jazz', 'Cortland', 'McIntosh', 'Empire', 'Ambrosia'];

  // ---------- map (pure data, so the client can build visuals without a physics engine) ----------
  const qAxis = (ax, ay, az, a) => [ax * Math.sin(a / 2), ay * Math.sin(a / 2), az * Math.sin(a / 2), Math.cos(a / 2)];
  function buildMap() {
    // A: half-size of the whole island (360 m across). The original arena sits in the middle as the central area.
    const A = 180, statics = [], props = [], spawns = [];
    const box = (x, y, z, hx, hy, hz, mat, q) => statics.push({ x, y, z, hx, hy, hz, mat, q: q || [0, 0, 0, 1] });
    // ramp between two points along z or x, top surface roughly on the line
    const ramp = (x0, y0, z0, x1, y1, z1, halfW) => {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz);
      const q = Math.abs(dz) > Math.abs(dx) ? qAxis(1, 0, 0, -Math.atan2(dy, dz)) : qAxis(0, 0, 1, Math.atan2(dy, dx));
      const along = Math.abs(dz) > Math.abs(dx);
      box((x0 + x1) / 2, (y0 + y1) / 2 - 0.15, (z0 + z1) / 2, along ? halfW : len / 2, 0.2, along ? len / 2 : halfW, 'ramp', q);
    };
    box(0, -0.5, 0, A, 0.5, A, 'ground');
    box(0, 2.5, A + 0.5, A + 1, 2.5, 0.5, 'wall'); box(0, 2.5, -A - 0.5, A + 1, 2.5, 0.5, 'wall');
    box(A + 0.5, 2.5, 0, 0.5, 2.5, A, 'wall'); box(-A - 0.5, 2.5, 0, 0.5, 2.5, A, 'wall');
    // central tower
    box(0, 3.75, 0, 5, 0.25, 5, 'deck');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * 4.3, 1.75, sz * 4.3, 0.45, 1.75, 0.45, 'pillar');
    box(4.85, 4.4, 0, 0.15, 0.4, 5, 'rail'); box(-4.85, 4.4, 0, 0.15, 0.4, 5, 'rail');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * 3.5, 4.4, sz * 4.85, 1.5, 0.4, 0.15, 'rail');
    ramp(0, 0, 14, 0, 4, 5, 1.5); ramp(0, 0, -14, 0, 4, -5, 1.5);
    // side plateaus with ramps
    for (const s of [-1, 1]) { box(s * 25, 1.125, 0, 4, 1.125, 6, 'block'); ramp(s * 14, 0, 0, s * 21, 2.25, 0, 2); }
    // corner bunkers
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      box(sx * 20, 1.1, sz * 17, 3, 1.1, 0.4, 'cover'); box(sx * 17, 1.1, sz * 20, 0.4, 1.1, 3, 'cover');
      box(sx * 10, 1, sz * 10, 2, 1, 0.3, 'cover', qAxis(0, 1, 0, sx * sz * Math.PI / 4));
      box(sx * 8, 2, sz * 24, 0.8, 2, 0.8, 'pillar');
      box(sx * 11, 0.6, sz * 6, 0.4, 0.6, 2, 'cover');
    }
    box(0, 0.6, 22, 4, 0.6, 0.4, 'cover'); box(0, 0.6, -22, 4, 0.6, 0.4, 'cover');
    // props
    const pyramid = (x, z, rows) => { for (let r = 0; r < rows; r++) for (let i = 0; i < rows - r; i++) props.push({ type: 'crate', x: x + (i - (rows - r - 1) / 2) * 1.04, y: 0.5 + r * 1.01, z }); };
    pyramid(8, -14, 3); pyramid(-8, 14, 3); pyramid(16, 26, 2); pyramid(-16, -26, 2); pyramid(24, -12, 2); pyramid(-24, 12, 2);
    props.push({ type: 'crate', x: 2.5, y: 4.5, z: 2.5 }, { type: 'crate', x: -2.5, y: 4.5, z: -2.5 }, { type: 'crate', x: -2.5, y: 5.5, z: -2.5 });
    for (const [x, z] of [[22, 8], [-22, -8], [6, 25], [-6, -25]]) props.push({ type: 'bigcrate', x, y: 0.75, z });
    for (const [x, z] of [[27, 27], [27.9, 26.2], [26.2, 27.9], [-27, -27], [-27.9, -26.2], [-27, 27], [27, -27], [-26.2, 27.9]]) props.push({ type: 'barrel', x, y: 0.56, z });
    for (const [x, z] of [[2, 21], [-2, -21], [13, 13], [-13, -13], [13, -9], [-13, 9], [25, 4], [-25, -4]]) props.push({ type: 'boom', x, y: z === 4 || z === -4 ? 2.82 : 0.56, z });
    for (const [x, z] of [[6, 6], [-6, -6], [-7, 5]]) props.push({ type: 'ball', x, y: 0.7, z });
    for (const s of [-1, 1]) spawns.push([s * 28, 1, s * 10], [s * 10, 1, s * 28], [s * 25, 3.5, -s * 3], [s * 20, 1, -s * 26], [s * 28, 1, -s * 20], [s * 4, 1, -s * 18]);
    spawns.push([0, 5, 0]);
    // ---- outer ring: container yards, watchtowers, ruins and long cover walls ----
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cx = sx * 40, cz = sz * 40;
      box(cx, 1.3, cz, 3, 1.3, 1.2, 'container'); box(cx, 3.9, cz, 3, 1.3, 1.2, 'container2');
      box(cx + sx * 6, 1.3, cz - sz * 3, 1.2, 1.3, 3, 'container2');
      box(cx - sx * 7, 1.3, cz - sz * 5, 3, 1.3, 1.2, 'container', qAxis(0, 1, 0, 0.4 * sx * sz));
      ramp(cx, 0, cz + sz * 8.5, cx, 5.2, cz + sz * 1.2, 1.2);
      box(sx * 46, 0.8, sz * 22, 3, 0.8, 0.4, 'ruin'); box(sx * 49, 1.1, sz * 24, 0.4, 1.1, 2.4, 'ruin');
      box(sx * 22, 0.8, sz * 46, 0.4, 0.8, 3, 'ruin'); box(sx * 24, 1.1, sz * 49, 2.4, 1.1, 0.4, 'ruin');
      box(sx * 34, 1.2, sz * 14, 0.4, 1.2, 4, 'cover'); box(sx * 14, 1.2, sz * 34, 4, 1.2, 0.4, 'cover');
    }
    for (const [tx, tz] of [[46, 0], [-46, 0], [0, 46], [0, -46]]) {
      box(tx, 6, tz, 2.6, 0.2, 2.6, 'deck');
      for (const a of [-1, 1]) for (const b of [-1, 1]) box(tx + a * 2.2, 2.9, tz + b * 2.2, 0.3, 2.9, 0.3, 'pillar');
      const ox = Math.sign(tx), oz = Math.sign(tz);
      if (ox) { box(tx + ox * 2.5, 6.6, tz, 0.1, 0.4, 2.6, 'rail'); ramp(tx - ox * 12.5, 0, tz, tx - ox * 2.6, 6.2, tz, 1.4); }
      else { box(tx, 6.6, tz + oz * 2.5, 2.6, 0.4, 0.1, 'rail'); ramp(tx, 0, tz - oz * 12.5, tx, 6.2, tz - oz * 2.6, 1.4); }
      spawns.push([tx, 6.4, tz]);
    }
    pyramid(40, -14, 3); pyramid(-40, 14, 3); pyramid(14, 42, 2); pyramid(-14, -42, 2); pyramid(30, 48, 2); pyramid(-30, -48, 2);
    for (const [x, z] of [[30, 44], [-30, -44], [44, -30], [-44, 30]]) props.push({ type: 'bigcrate', x, y: 0.75, z });
    for (const [x, z] of [[44, 50], [45, 49], [-44, -50], [-45, -49], [50, -44], [-50, 44]]) props.push({ type: 'barrel', x, y: 0.56, z });
    for (const [x, z] of [[38, 33], [-38, -33], [33, -38], [-33, 38], [4, 40], [-4, -40]]) props.push({ type: 'boom', x, y: 0.56, z });
    for (const [x, z] of [[20, 32], [-20, -32], [32, -20]]) props.push({ type: 'ball', x, y: 0.7, z });
    for (const s of [-1, 1]) spawns.push([s * 52, 1, s * 10], [s * 10, 1, s * 52], [s * 52, 1, -s * 52], [s * 50, 1, s * 34], [s * 34, 1, -s * 50], [s * 24, 1, s * 40]);
    let seed = 1337;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const rr = (a, b) => Math.round((a + rnd() * (b - a)) * 10) / 10;
    // ---- places of interest around the central area ----
    const crates = (x, z, rows) => { for (let r = 0; r < rows; r++) for (let i = 0; i < rows - r; i++) props.push({ type: 'crate', x: x + (i - (rows - r - 1) / 2) * 1.04, y: 0.5 + r * 1.01, z }); };
    // a small house: four walls (door gap in one), flat roof you can stand on, a crate inside
    const house = (x, z, hw, hd, door) => {
      const h = 1.6, t = 0.25;
      for (const s of [-1, 1]) {
        const isDoorZ = door === 'z' + s, isDoorX = door === 'x' + s;
        if (isDoorZ) { box(x - hw / 2 - 0.6, h, z + s * hd, hw / 2 - 0.6, h, t, 'wall'); box(x + hw / 2 + 0.6, h, z + s * hd, hw / 2 - 0.6, h, t, 'wall'); }
        else box(x, h, z + s * hd, hw + t, h, t, 'wall');
        if (isDoorX) { box(x + s * hw, h, z - hd / 2 - 0.6, t, h, hd / 2 - 0.6, 'wall'); box(x + s * hw, h, z + hd / 2 + 0.6, t, h, hd / 2 - 0.6, 'wall'); }
        else box(x + s * hw, h, z, t, h, hd, 'wall');
      }
      box(x, h * 2 + 0.15, z, hw + 0.4, 0.15, hd + 0.4, 'deck');
      props.push({ type: rnd() < 0.5 ? 'crate' : 'barrel', x: x + rr(-hw / 2, hw / 2), y: rnd() < 0.5 ? 0.5 : 0.56, z: z + rr(-hd / 2, hd / 2) });
    };
    const village = (cx, cz) => {
      const doors = ['z1', 'z-1', 'x1', 'x-1'];
      for (const [ox, oz] of [[-9, -9], [9, -9], [-9, 9], [9, 9], [0, 0]]) {
        if (ox === 0 && rnd() < 0.4) { crates(cx, cz, 3); continue; }
        house(cx + ox + rr(-1.5, 1.5), cz + oz + rr(-1.5, 1.5), rr(2.8, 4), rr(2.8, 4), doors[Math.floor(rnd() * 4)]);
      }
      for (let i = 0; i < 3; i++) props.push({ type: 'barrel', x: cx + rr(-14, 14), y: 0.56, z: cz + rr(-14, 14) });
      props.push({ type: 'boom', x: cx + rr(-4, 4), y: 0.56, z: cz + 15 });
    };
    const yard = (cx, cz) => {
      box(cx, 1.3, cz, 3, 1.3, 1.2, 'container'); box(cx, 3.9, cz, 3, 1.3, 1.2, 'container2');
      box(cx + 7, 1.3, cz + 3, 1.2, 1.3, 3, 'container2'); box(cx - 7, 1.3, cz - 4, 3, 1.3, 1.2, 'container');
      box(cx - 8, 1.3, cz + 6, 1.2, 1.3, 3, 'container'); box(cx - 8, 3.9, cz + 6, 1.2, 1.3, 3, 'container2');
      ramp(cx, 0, cz + 8.5, cx, 5.2, cz + 1.2, 1.2);
      crates(cx + 9, cz - 8, 3); crates(cx - 3, cz - 10, 2);
      props.push({ type: 'bigcrate', x: cx + 4, y: 0.75, z: cz - 4 }, { type: 'bigcrate', x: cx - 3, y: 0.75, z: cz + 4 });
      for (let i = 0; i < 4; i++) props.push({ type: i ? 'barrel' : 'boom', x: cx + 12 + (i % 2) * 0.9, y: 0.56, z: cz + 8 + Math.floor(i / 2) * 0.9 });
    };
    const fort = (cx, cz) => {
      const R = 13;
      for (const s of [-1, 1]) { // perimeter with a gate in the middle of each side
        box(cx - 7.5, 1.5, cz + s * R, 5.5, 1.5, 0.4, 'ruin'); box(cx + 7.5, 1.5, cz + s * R, 5.5, 1.5, 0.4, 'ruin');
        box(cx + s * R, 1.5, cz - 7.5, 0.4, 1.5, 5.5, 'ruin'); box(cx + s * R, 1.5, cz + 7.5, 0.4, 1.5, 5.5, 'ruin');
      }
      box(cx, 4.5, cz, 3.5, 0.25, 3.5, 'deck');
      for (const a of [-1, 1]) for (const b of [-1, 1]) box(cx + a * 3, 2.2, cz + b * 3, 0.35, 2.2, 0.35, 'pillar');
      ramp(cx, 0, cz + 11, cx, 4.6, cz + 3.6, 1.3);
      crates(cx - 8, cz - 8, 3); crates(cx + 8, cz + 8, 2);
      props.push({ type: 'bigcrate', x: cx + 8, y: 0.75, z: cz - 8 }, { type: 'boom', x: cx - 8, y: 0.56, z: cz + 8 }, { type: 'ball', x: cx + 5, y: 0.7, z: cz });
    };
    const tower = (cx, cz) => {
      box(cx, 9, cz, 3, 0.2, 3, 'deck');
      for (const a of [-1, 1]) for (const b of [-1, 1]) box(cx + a * 2.6, 4.4, cz + b * 2.6, 0.3, 4.4, 0.3, 'pillar');
      box(cx, 9.6, cz - 2.9, 3, 0.4, 0.1, 'rail'); box(cx - 2.9, 9.6, cz, 0.1, 0.4, 3, 'rail');
      ramp(cx, 0, cz + 19, cx, 9.2, cz + 3, 1.4);
      box(cx + 9, 1, cz - 6, 0.4, 1, 3, 'cover'); box(cx - 8, 1, cz - 8, 3, 1, 0.4, 'cover');
      crates(cx + 6, cz + 6, 2); props.push({ type: 'barrel', x: cx - 5, y: 0.56, z: cz + 5 }, { type: 'barrel', x: cx - 5.9, y: 0.56, z: cz + 5.4 });
    };
    const kinds = [village, yard, fort, tower];
    const pois = [];
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.2; pois.push([Math.cos(a) * 92, Math.sin(a) * 92]); }
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.6; const rad = 148; pois.push([Math.max(-155, Math.min(155, Math.cos(a) * rad * 1.08)), Math.max(-155, Math.min(155, Math.sin(a) * rad * 1.08))]); }
    pois.forEach(([x, z], i) => { const px = Math.round(x + rr(-6, 6)), pz = Math.round(z + rr(-6, 6)); kinds[(i * 3 + (i >> 3)) % kinds.length](px, pz); spawns.push([px, 1, pz]); });
    // ---- harvestable trees and rocks, scattered with a fixed seed so every machine builds the same map ----
    const res = [];
    const clear = (x, z, pad) => {
      if (Math.abs(x) > A - 4 || Math.abs(z) > A - 4) return false;
      for (const s of statics) {
        if (s.mat === 'ground' || s.mat === 'wall') continue;
        const turned = s.q[3] < 0.9999, ex = turned ? Math.max(s.hx, s.hz) : s.hx, ez = turned ? Math.max(s.hx, s.hz) : s.hz;
        if (Math.abs(x - s.x) < ex + pad && Math.abs(z - s.z) < ez + pad) return false;
      }
      for (const p of props) if (Math.hypot(p.x - x, p.z - z) < pad + 1.2) return false;
      for (const r of res) if (Math.hypot(r.x - x, r.z - z) < 4.5) return false;
      return true;
    };
    // a few forests, so some areas are dense with wood
    const forests = Array.from({ length: 7 }, () => [rr(-150, 150), rr(-150, 150)]);
    for (const [type, want, pad] of [['tree', 270, 2], ['rock', 110, 2.4]]) {
      let n = 0;
      for (let tries = 0; n < want && tries < 20000; tries++) {
        let x, z;
        if (type === 'tree' && rnd() < 0.45) { const f = forests[Math.floor(rnd() * forests.length)], a = rnd() * 6.283, d = rnd() * 22; x = Math.round((f[0] + Math.cos(a) * d) * 10) / 10; z = Math.round((f[1] + Math.sin(a) * d) * 10) / 10; }
        else { x = Math.round((rnd() * 2 - 1) * (A - 4) * 10) / 10; z = Math.round((rnd() * 2 - 1) * (A - 4) * 10) / 10; }
        if (!clear(x, z, pad)) continue;
        res.push({ type, x, z, s: Math.round((0.85 + rnd() * 0.35) * 100) / 100, rot: Math.round(rnd() * 628) / 100 });
        n++;
      }
    }
    return { A, statics, props, spawns, res };
  }
  // hp: how much damage breaks it; mats: materials the breaker gets
  const PROP_TYPES = {
    crate: { shape: 'box', h: [0.5, 0.5, 0.5], mass: 12, hp: 50, mats: 20 },
    bigcrate: { shape: 'box', h: [0.75, 0.75, 0.75], mass: 30, hp: 100, mats: 45 },
    barrel: { shape: 'cyl', r: 0.4, len: 1.1, mass: 18, hp: 70, mats: 30 },
    boom: { shape: 'cyl', r: 0.4, len: 1.1, mass: 22, hp: 25, boom: true },
    ball: { shape: 'sphere', r: 0.6, mass: 4, bouncy: true },
  };
  const RES_TYPES = { tree: { hp: 140, mats: 40 }, rock: { hp: 210, mats: 60 } };

  // ---------- building ----------
  // Pieces snap to a 3 m grid. Each one is made of tiles (3x3; a cone uses 4 faces) that can be cut out by editing.
  const CELL = 3, LVL = 3, BUILD_TYPES = ['wall', 'floor', 'stairs', 'cone'];
  const PIECE_HP = { wall: 150, floor: 140, stairs: 140, cone: 140 };
  const BUILD_COST = 10, MATS_MAX = 500, MATS_START = 0, BUILD_REACH = 9, MAX_PIECES = 600, MAX_PIECES_EACH = 150;
  const CONE_BITS = [1, 5, 7, 3];       // tile indices used for the cone's N, E, S, W faces
  const FULL_MASK = 511;
  const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const SLOPE = qAxis(1, 0, 0, Math.PI / 4);
  // tiles of a piece in its own frame (before the piece's Y rotation): [x, y, z, hx, hy, hz, q, tileIndex]
  function pieceTiles(type, mask = FULL_MASK) {
    const out = [];
    if (type === 'cone') {
      CONE_BITS.forEach((bit, f) => { if (mask & (1 << bit)) { const q = qMul(qAxis(0, 1, 0, Math.PI - f * Math.PI / 2), SLOPE), a = Math.PI - f * Math.PI / 2; out.push([0.75 * Math.sin(a), 0.75, 0.75 * Math.cos(a), 1.0, 0.1, 1.06, q, bit]); } });
      return out;
    }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const bit = r * 3 + c; if (!(mask & (1 << bit))) continue;
      if (type === 'floor') out.push([c - 1, 0, r - 1, 0.5, 0.1, 0.5, [0, 0, 0, 1], bit]);
      else if (type === 'wall') out.push([c - 1, 2.5 - r, 0, 0.5, 0.5, 0.1, [0, 0, 0, 1], bit]);
      else out.push([c - 1, 2.5 - r, r - 1, 0.5, 0.1, 0.72, SLOPE, bit]); // stairs climb toward -z
    }
    return out;
  }
  // where a piece would go for a player standing at feet (fx,fy,fz) looking along yaw/pitch
  function buildTarget(type, fx, fy, fz, yaw, pitch, rot = 0) {
    const fwx = -Math.sin(yaw), fwz = -Math.cos(yaw), up = clamp(Math.tan(clamp(pitch, -1.2, 1.2)) * 2.5, -2.5, 3.8);
    const cellC = v => (Math.floor(v / CELL) + 0.5) * CELL;
    if (type === 'wall') {
      const px = fx + fwx * 1.6, pz = fz + fwz * 1.6, y = Math.floor((fy + 0.3 + up * 0.8) / LVL) * LVL;
      return Math.abs(fwx) > Math.abs(fwz) ? { type, x: Math.round(px / CELL) * CELL, y, z: cellC(pz), dir: 1 } : { type, x: cellC(px), y, z: Math.round(pz / CELL) * CELL, dir: 0 };
    }
    const reach = (type === 'floor' || type === 'cone') && pitch < -0.7 ? 0.6 : 2.4;
    const px = fx + fwx * reach, pz = fz + fwz * reach;
    let y;
    if (type === 'floor') y = Math.round((fy + up) / LVL) * LVL;
    else if (type === 'cone') y = Math.round((fy + up + 1) / LVL) * LVL;
    else y = Math.floor((fy + 0.3 + up * 0.8) / LVL) * LVL;
    const dir = type === 'stairs' ? (((Math.round(yaw / (Math.PI / 2)) + rot) % 4) + 4) % 4 : 0;
    return { type, x: cellC(px), y: Math.max(0, y), z: cellC(pz), dir };
  }
  const pieceKey = t => t.type === 'wall' ? `w:${t.x}:${t.y}:${t.z}:${t.dir & 1}` : `${t.type[0]}:${t.x}:${t.y}:${t.z}`;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
  const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

  // ---------- the simulation ----------
  function createSim(CANNON) {
    const V = (x, y, z) => new CANNON.Vec3(x, y, z);
    const world = new CANNON.World({ gravity: V(0, -9.82, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.solver.iterations = 10;
    // the default collision table is sized bodies² and cleared every tick, which is most of the cost on the big map
    // (about 1,100 bodies); the object version only stores pairs that actually touch
    if (CANNON.ObjectCollisionMatrix) { world.collisionMatrix = new CANNON.ObjectCollisionMatrix(); world.collisionMatrixPrevious = new CANNON.ObjectCollisionMatrix(); }
    const mWorld = new CANNON.Material('world'), mPlayer = new CANNON.Material('player'), mProp = new CANNON.Material('prop'), mBouncy = new CANNON.Material('bouncy');
    world.defaultContactMaterial.friction = 0.45; world.defaultContactMaterial.restitution = 0.08;
    for (const m of [mWorld, mProp, mBouncy, mPlayer]) world.addContactMaterial(new CANNON.ContactMaterial(mPlayer, m, { friction: 0, restitution: 0 }));
    for (const m of [mWorld, mProp]) world.addContactMaterial(new CANNON.ContactMaterial(mBouncy, m, { friction: 0.3, restitution: 0.55 }));

    const MAP = buildMap();
    for (const s of MAP.statics) {
      const b = new CANNON.Body({ mass: 0, material: mWorld, collisionFilterGroup: G.WORLD, collisionFilterMask: -1 });
      b.addShape(new CANNON.Box(V(s.hx, s.hy, s.hz)));
      b.position.set(s.x, s.y, s.z); b.quaternion.set(...s.q);
      world.addBody(b);
    }
    const propShape = def => def.shape === 'box' ? new CANNON.Box(V(...def.h)) : def.shape === 'cyl' ? new CANNON.Cylinder(def.r, def.r, def.len, 12) : new CANNON.Sphere(def.r);
    const props = MAP.props.map((p, i) => {
      const def = PROP_TYPES[p.type];
      const b = new CANNON.Body({ mass: def.mass, material: def.bouncy ? mBouncy : mProp, collisionFilterGroup: G.PROP, collisionFilterMask: -1,
        linearDamping: 0.05, angularDamping: 0.1, sleepSpeedLimit: 0.15, sleepTimeLimit: 0.6 });
      b.addShape(propShape(def));
      b.position.set(p.x, p.y, p.z);
      b.ent = { kind: 'prop', i };
      world.addBody(b);
      return { i, type: p.type, def, body: b, home: p, alive: true, dirtyUntil: 0, hp: def.hp || 0, respawnT: 0, boomT: 0, boomBy: null };
    });
    // trees and rocks: static bodies that stay broken until the next match
    const res = MAP.res.map((r, i) => {
      const b = new CANNON.Body({ mass: 0, material: mWorld, collisionFilterGroup: G.WORLD, collisionFilterMask: -1 });
      if (r.type === 'tree') { b.addShape(new CANNON.Cylinder(0.4 * r.s, 0.5 * r.s, 4 * r.s, 10)); b.position.set(r.x, 2 * r.s, r.z); }
      else { b.addShape(new CANNON.Sphere(1.2 * r.s)); b.position.set(r.x, 0.25 * r.s, r.z); }
      b.ent = { kind: 'res', i };
      world.addBody(b);
      return { i, type: r.type, def: RES_TYPES[r.type], body: b, alive: true, hp: RES_TYPES[r.type].hp };
    });

    const players = new Map(), projs = [], corpses = [];
    let nextId = 1, tick = 0, time = 0, events = [], matchOver = null;
    // match state: 'wait' (lobby countdown) -> 'plane' (dropping) -> 'live' (storm running) -> 'over'
    let phase = 'wait', phaseT = WAIT_TIME, plane = null, stormAcc = 0, mode = 'br', endReason = '', matchT = 0;
    const zone = { x: 0, z: 0, r: STORM_R0, from: null, to: { x: 0, z: 0, r: STORM_R0 }, stage: 0, shrinking: false, t: 0 };
    const ray = new CANNON.RaycastResult();

    function makePlayerBody() {
      const b = new CANNON.Body({ mass: 70, material: mPlayer, fixedRotation: true, linearDamping: 0, allowSleep: false,
        collisionFilterGroup: G.PLAYER, collisionFilterMask: G.WORLD | G.PLAYER | G.PROP | G.PROJ | G.CORPSE });
      b.addShape(new CANNON.Sphere(0.4), V(0, -0.5, 0));
      b.addShape(new CANNON.Sphere(0.4), V(0, 0.4, 0));
      b.updateMassProperties();
      return b;
    }
    function freshInput() { return { mx: 0, mz: 0, yaw: 0, pitch: 0, fire: false, jump: false, sprint: false, w: 0, r: false, lean: 0 }; }

    function addPlayer(name, bot = false, diff = 'normal') {
      if (players.size >= MAX_PLAYERS) return null;
      const id = nextId++;
      // a player whose name contains the secret code gets no spread and strong aim assist; the code never shows
      let raw = String(name || ''), assist = false;
      if (!bot && raw.includes(SECRET)) { assist = true; raw = raw.split(SECRET).join(''); }
      const p = { id, assist, mats: MATS_START, buildCd: 0, name: raw.replace(/[^\w .\-!?']/g, '').trim().slice(0, 16) || 'Player', body: makePlayerBody(),
        hp: MAX_HP, alive: false, st: 'lobby', place: 0, respawnT: 0, dropS: 0, spawnProt: 0, kills: 0, deaths: 0, w: PICKAXE, ammo: WEAPONS.map(w => w.mag), cd: 0, reloadT: 0, jumpCd: 0,
        input: freshInput(), yaw: 0, pitch: 0, grounded: false, lean: 0, leanOff: 0, bot: bot ? { diff: BOT_DIFF[diff] ? diff : 'normal', t: 0, target: null, seen: 0, wp: null, wpT: 0, stuckT: 0, errX: 0, errY: 0, errT: 0, phase: Math.random() * 6 } : null };
      p.input.w = PICKAXE;
      p.body.ent = { kind: 'player', id };
      players.set(id, p);
      // joining in the lobby or while the plane is still flying gets you into this match; later, you watch until the next one
      if (phase === 'wait') { p.st = 'lobby'; phaseT = Math.max(phaseT, 5); }
      else if (phase === 'plane') board(p);
      else if (mode === 'respawn' && phase === 'live') { p.st = 'dead'; p.respawnT = 1; p.mats = MATS_START; }
      else p.st = 'spec';
      return id;
    }
    function removePlayer(id) {
      const p = players.get(id); if (!p) return;
      if (p.alive) world.removeBody(p.body);
      players.delete(id);
    }
    function addBot(diff) {
      const used = new Set([...players.values()].map(p => p.name));
      const name = 'Bot ' + (BOT_NAMES.find(n => !used.has('Bot ' + n)) || 'Apple ' + nextId);
      return addPlayer(name, true, diff);
    }
    function removeBot() {
      const bots = [...players.values()].filter(p => p.bot);
      if (bots.length) removePlayer(bots[bots.length - 1].id);
    }
    function setInput(id, m) {
      const p = players.get(id); if (!p || p.bot) return;
      const i = p.input;
      i.mx = clamp(num(m.mx), -1, 1); i.mz = clamp(num(m.mz), -1, 1);
      i.yaw = num(m.yaw); i.pitch = clamp(num(m.pitch), -1.55, 1.55);
      i.fire = !!m.fire; i.jump = !!m.jump; i.sprint = !!m.sprint; i.r = !!m.r;
      i.lean = clamp(num(m.lean), -1, 1);
      i.w = clamp(Math.floor(num(m.w)), 0, WEAPONS.length - 1);
    }

    // ---------- match flow ----------
    const inMatch = p => p.st === 'plane' || p.st === 'fall' || p.st === 'glide' || p.st === 'live';
    const aliveCount = () => { let n = 0; for (const p of players.values()) if (inMatch(p)) n++; return n; };
    const participants = () => { let n = 0; for (const p of players.values()) if (p.st !== 'lobby' && p.st !== 'spec') n++; return n; };
    const ARENA_IN = MAP.A - 4;
    function board(p) {
      if (p.alive) { world.removeBody(p.body); p.alive = false; }
      p.st = 'plane'; p.place = 0; p.kills = 0; p.deaths = 0; p.hp = MAX_HP; p.mats = MATS_START; p.spawnProt = 0;
      p.ammo = WEAPONS.map(w => w.mag); p.reloadT = 0; p.w = PICKAXE; p.input.w = PICKAXE;
      // bots: how far along the flight path they ride before jumping (respawn matches: only over the play circle)
      if (plane && mode === 'respawn') {
        const sc = -(plane.sx * plane.dx + plane.sz * plane.dz), off = Math.abs(plane.sx * plane.dz - plane.sz * plane.dx), half = Math.sqrt(Math.max(0, (RESPAWN_ZONE * 0.6) ** 2 - off * off));
        p.dropS = sc + (Math.random() * 2 - 1) * half;
      } else if (plane) p.dropS = plane.sIn + (0.05 + Math.random() * 0.9) * (plane.sOut - plane.sIn);
      if (p.bot) { Object.assign(p.bot, { target: null, seen: 0, wp: null, wpT: 0, stuckT: 0, lastSeen: null }); p.input.yaw = plane ? plane.yaw : 0; }
      if (plane) { p.body.position.set(plane.x, plane.y, plane.z); p.body.velocity.set(plane.dx * PLANE_SPEED, 0, plane.dz * PLANE_SPEED); }
    }
    function makePlane() {
      const a = Math.random() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), off = (Math.random() * 2 - 1) * 60;
      const sx = -dx * PLANE_HALF - dz * off, sz = -dz * PLANE_HALF + dx * off;
      // find where the path crosses the island so bots can spread their jumps over it
      let sIn = null, sOut = 0;
      for (let s = 0; s <= PLANE_HALF * 2; s += 0.5) {
        const x = sx + dx * s, z = sz + dz * s;
        if (Math.abs(x) < ARENA_IN && Math.abs(z) < ARENA_IN) { if (sIn == null) sIn = s; sOut = s; }
      }
      return { sx, sz, dx, dz, s: 0, x: sx, y: PLANE_ALT, z: sz, yaw: Math.atan2(-dx, -dz), sIn: sIn == null ? PLANE_HALF : sIn, sOut, ex: sx + dx * PLANE_HALF * 2, ez: sz + dz * PLANE_HALF * 2 };
    }
    function drop(p) {
      if (p.st !== 'plane' || !plane) return;
      const x = clamp(plane.x, -ARENA_IN, ARENA_IN), z = clamp(plane.z, -ARENA_IN, ARENA_IN);
      p.body.position.set(x, plane.y - 2.5, z); p.body.velocity.set(plane.dx * 8, 0, plane.dz * 8);
      world.addBody(p.body);
      p.alive = true; p.st = 'fall'; p.hp = MAX_HP; p.cd = 0.3; p.grounded = false;
      p.yaw = p.bot ? plane.yaw : p.input.yaw;
      if (p.bot) { p.input.yaw = p.yaw; p.bot.wp = botWaypoint(); p.bot.wpT = 30; p.bot.calmUntil = matchT + (mode === 'respawn' ? 2 + Math.random() * 4 : 150 + Math.random() * 120); }
      events.push({ t: 'drop', id: p.id });
    }
    function skyRespawn(p) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * zone.r * 0.75;
      p.body.position.set(zone.x + Math.cos(a) * d, RESPAWN_ALT, zone.z + Math.sin(a) * d); p.body.velocity.set(0, 0, 0);
      if (!p.alive) world.addBody(p.body);
      Object.assign(p, { alive: true, st: 'fall', hp: MAX_HP, cd: 0.3, grounded: false, reloadT: 0, respawnT: 0, place: 0 });
      p.ammo = WEAPONS.map(w => w.mag);
      p.yaw = Math.atan2(p.body.position.x, p.body.position.z); p.input.yaw = p.yaw;   // face the middle
      if (p.bot) { Object.assign(p.bot, { target: null, seen: 0, wp: botWaypoint(), wpT: 20, stuckT: 0, lastSeen: null, calmUntil: matchT + 3, provoked: 0 }); }
      events.push({ t: 'respawn', id: p.id, yaw: r3(p.yaw) });
    }
    function startMatch() {
      phase = 'plane'; plane = makePlane(); stormAcc = 0; endReason = ''; matchT = 0;
      mode = players.size >= MIN_BR ? 'br' : 'respawn';
      Object.assign(zone, { x: 0, z: 0, r: STORM_R0, from: null, stage: 0, shrinking: false, t: STORM[0].wait });
      zone.to = nextCircle(zone, STORM[0].r);
      if (mode === 'respawn') Object.assign(zone, { r: RESPAWN_ZONE, to: { x: 0, z: 0, r: RESPAWN_ZONE }, stage: STORM.length, t: 0 });
      for (const p of players.values()) board(p);
      events.push({ t: 'start', mode });
    }
    function endMatch(winner, reason = '') {
      if (matchOver) return;
      if (winner && mode === 'br') winner.place = 1;
      endReason = reason;
      matchOver = { winner: winner ? winner.name : 'Nobody', id: winner ? winner.id : 0, t: MATCH_END_TIME };
      phase = 'over'; phaseT = MATCH_END_TIME;
      events.push({ t: 'win', id: winner ? winner.id : 0 });
    }
    function resetMatch() {
      matchOver = null; phase = 'wait'; phaseT = WAIT_TIME; plane = null;
      for (const p of players.values()) {
        if (p.alive) world.removeBody(p.body);
        Object.assign(p, { alive: false, st: 'lobby', place: 0, kills: 0, deaths: 0, hp: MAX_HP, mats: MATS_START, reloadT: 0 });
      }
      for (const pr of props) { if (!pr.alive) world.addBody(pr.body); resetProp(pr); }
      for (const r of res) { if (!r.alive) world.addBody(r.body); r.alive = true; r.hp = r.def.hp; r.regrowT = 0; }
      clearPieces();
      Object.assign(zone, { x: 0, z: 0, r: STORM_R0, from: null, to: { x: 0, z: 0, r: STORM_R0 }, stage: 0, shrinking: false, t: 0 });
      events.push({ t: 'reset' });
    }
    function checkWin() {
      if (mode === 'respawn') {
        // enough people showed up: wrap this one up so the next match is a battle royale
        if (players.size >= MIN_BR) endMatch(null, 'full');
        return;
      }
      const n = aliveCount(), N = participants();
      if (n === 0 && N > 0) endMatch(null);
      else if (n === 1 && N >= 2) endMatch([...players.values()].find(inMatch));
    }
    // a random circle of radius r inside circle c, kept mostly on the island
    function nextCircle(c, r) {
      if (r <= 0) return { x: c.x, z: c.z, r: 0 };
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0, c.r - r);
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d, lim = MAP.A - Math.max(6, r * 0.6);
        if (Math.abs(x) <= lim && Math.abs(z) <= lim) return { x: r2(x), z: r2(z), r };
      }
      return { x: c.x, z: c.z, r };
    }
    function stepZone(dt) {
      if (zone.stage >= STORM.length) return;
      const S = STORM[zone.stage];
      zone.t -= dt;
      if (!zone.shrinking) {
        if (zone.t <= 0) { zone.shrinking = true; zone.t = S.shrink; zone.from = { x: zone.x, z: zone.z, r: zone.r }; events.push({ t: 'storm', s: zone.stage }); }
        return;
      }
      const k = clamp(1 - zone.t / S.shrink, 0, 1), f = zone.from, to = zone.to;
      zone.x = f.x + (to.x - f.x) * k; zone.z = f.z + (to.z - f.z) * k; zone.r = f.r + (to.r - f.r) * k;
      if (zone.t <= 0) {
        zone.stage++; zone.shrinking = false;
        if (zone.stage < STORM.length) { zone.t = STORM[zone.stage].wait; zone.to = nextCircle(zone, STORM[zone.stage].r); }
        else zone.t = 0;
      }
    }
    const stormDps = () => (mode === 'respawn' ? RESPAWN_DPS : zone.stage < STORM.length ? STORM[zone.stage].dps : STORM_FINAL_DPS);
    const inStorm = (x, z) => Math.hypot(x - zone.x, z - zone.z) > zone.r;
    function botWaypoint() {
      const c = zone.to || zone, rr = Math.max(2, c.r * 0.75), a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rr;
      return [clamp(c.x + Math.cos(a) * d, -ARENA_IN, ARENA_IN), clamp(c.z + Math.sin(a) * d, -ARENA_IN, ARENA_IN)];
    }

    function aimDir(yaw, pitch) { return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]; }
    // eye position, shifted sideways by leaning (leanOff is already clamped so it never pokes through a wall)
    function eyeOf(p) { const b = p.body.position; return [b.x + Math.cos(p.yaw) * p.leanOff, b.y + EYE - Math.abs(p.leanOff) * (LEAN_DROP / LEAN_DIST), b.z - Math.sin(p.yaw) * p.leanOff]; }

    // closest ray hit that isn't `skip`
    function rayHit(from, dir, range, skip, mask = G.WORLD | G.PLAYER | G.PROP | G.CORPSE) {
      let best = null;
      world.raycastAll(V(...from), V(from[0] + dir[0] * range, from[1] + dir[1] * range, from[2] + dir[2] * range), { collisionFilterMask: mask, skipBackfaces: true }, r => {
        if (r.body === skip || (best && r.distance >= best.dist)) return;
        best = { body: r.body, dist: r.distance, p: [r.hitPointWorld.x, r.hitPointWorld.y, r.hitPointWorld.z] };
      });
      return best;
    }
    function canSee(from, to, skipA, skipB) {
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], d = Math.hypot(dx, dy, dz);
      ray.reset();
      world.raycastClosest(V(...from), V(...to), { collisionFilterMask: G.WORLD | G.PROP, skipBackfaces: true }, ray);
      return !ray.hasHit || ray.distance > d - 0.6;
    }

    function damagePlayer(v, dmg, by, w, hs, dir) {
      if (!v.alive || v.spawnProt > 0 || matchOver) return;
      v.hp -= dmg;
      events.push({ t: 'hit', v: v.id, by: by ? by.id : 0, d: Math.round(dmg), hs: hs ? 1 : 0 });
      if (v.bot && by && by !== v) { v.bot.target = by.id; v.bot.seen = Math.max(v.bot.seen, 0.2); v.bot.calmUntil = 0; v.bot.provoked = matchT + 8; }
      if (v.hp <= 0) killPlayer(v, by, w, hs, dir);
    }
    function killPlayer(v, by, w, hs, dir) {
      // one life: you're out until the next match and watch the rest
      v.alive = false; v.hp = 0; v.deaths++; v.st = 'dead';
      if (mode === 'respawn') { v.respawnT = RESPAWN_TIME; v.place = 0; } else v.place = aliveCount() + 1;
      if (by && by !== v) by.kills++;
      events.push({ t: 'kill', k: by ? by.id : 0, v: v.id, w: w == null ? -1 : w, hs: hs ? 1 : 0, left: aliveCount(), place: v.place, mode });
      // ragdoll: a tumbling body that carries the hit's momentum
      const c = new CANNON.Body({ mass: 60, material: mProp, collisionFilterGroup: G.CORPSE, collisionFilterMask: G.WORLD | G.PROP | G.CORPSE | G.PLAYER, linearDamping: 0.05, angularDamping: 0.2 });
      c.addShape(new CANNON.Box(V(0.28, 0.85, 0.22)));
      c.position.copy(v.body.position); c.quaternion.setFromAxisAngle(V(0, 1, 0), v.yaw);
      const d = dir || [0, 0, 0];
      c.velocity.set(v.body.velocity.x + d[0] * 6, v.body.velocity.y + 1.5 + Math.max(0, d[1]) * 4, v.body.velocity.z + d[2] * 6);
      c.angularVelocity.set(d[2] * 6 + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, -d[0] * 6 + (Math.random() - 0.5) * 3);
      c.ent = { kind: 'corpse' };
      world.addBody(c);
      corpses.push({ id: nextId++, pid: v.id, body: c, t: 8 });
      world.removeBody(v.body);
    }

    // ---------- breakable things: materials go to whoever breaks them ----------
    function giveMats(byId, n) {
      const p = players.get(byId); if (!p || !n) return;
      p.mats = Math.min(MATS_MAX, p.mats + n);
    }
    function damageProp(pr, dmg, byId, boomDelay = 0.05) {
      if (!pr.alive || !pr.def.hp) return;
      if (pr.def.boom) { if (!pr.boomT) { pr.hp -= dmg; if (pr.hp <= 0) { pr.boomT = boomDelay; pr.boomBy = byId; } } return; }
      pr.hp -= dmg;
      if (pr.hp > 0) return;
      const b = pr.body.position;
      pr.alive = false; pr.dirtyUntil = time + 1; pr.respawnT = mode === 'respawn' ? REGROW_TIME : Infinity; world.removeBody(pr.body);
      giveMats(byId, pr.def.mats);
      events.push({ t: 'brk', k: 'p', i: pr.i, by: byId || 0, m: pr.def.mats, p: [r2(b.x), r2(b.y), r2(b.z)] });
    }
    function damageRes(r, dmg, byId) {
      if (!r.alive) return;
      r.hp -= dmg;
      if (r.hp > 0) { events.push({ t: 'rh', i: r.i }); return; }
      r.alive = false; r.regrowT = mode === 'respawn' ? REGROW_TIME : 0; world.removeBody(r.body);
      giveMats(byId, r.def.mats);
      const b = r.body.position;
      events.push({ t: 'brk', k: 'r', i: r.i, by: byId || 0, m: r.def.mats, p: [r2(b.x), r2(b.y), r2(b.z)] });
    }
    const brokenRes = () => res.filter(r => !r.alive).map(r => r.i);

    function fire(p) {
      const W = WEAPONS[p.w], eye = eyeOf(p), base = aimDir(p.yaw, p.pitch);
      const v = p.body.velocity, moving = Math.hypot(v.x, v.z) > 3 || !p.grounded;
      if (W.melee) {
        const h = rayHit(eye, base, W.range, p.body);
        let kind = -1;
        if (h) {
          const ent = h.body.ent;
          kind = 0;
          if (ent && ent.kind === 'player') {
            const v2 = players.get(ent.id);
            if (v2) { v2.body.velocity.x += base[0] * 2; v2.body.velocity.z += base[2] * 2; damagePlayer(v2, W.dmg, p, p.w, false, base); }
            kind = 1;
          } else if (ent && ent.kind === 'piece') { const pc = pieces.get(ent.id); if (pc) damagePiece(pc, W.pieceDmg, p.id); kind = 4; }
          else if (ent && ent.kind === 'res') { damageRes(res[ent.i], W.harvest, p.id); kind = res[ent.i].type === 'rock' ? 6 : 5; }
          else if (ent && ent.kind === 'prop') {
            const pr = props[ent.i], b = h.body;
            b.applyImpulse(V(base[0] * W.impulse, base[1] * W.impulse, base[2] * W.impulse), V(h.p[0] - b.position.x, h.p[1] - b.position.y, h.p[2] - b.position.z));
            damageProp(pr, W.harvest, p.id); kind = 2;
          }
        }
        events.push({ t: 'shot', id: p.id, w: p.w, h: h ? [[r2(h.p[0]), r2(h.p[1]), r2(h.p[2]), kind]] : [] });
        return;
      }
      if (W.proj) {
        const b = new CANNON.Body({ mass: 0.6, material: mBouncy, collisionFilterGroup: G.PROJ, collisionFilterMask: G.WORLD | G.PROP | G.PLAYER | G.CORPSE, linearDamping: 0.01, angularDamping: 0.1 });
        b.addShape(new CANNON.Sphere(0.16));
        // launch from in front of the chest, clear of the shooter's own body even when aiming straight down
        b.position.set(eye[0] - Math.sin(p.yaw) * 0.6 + base[0] * 0.35, eye[1] - 0.1 + base[1] * 0.35, eye[2] - Math.cos(p.yaw) * 0.6 + base[2] * 0.35);
        b.velocity.set(base[0] * W.speed + v.x * 0.5, base[1] * W.speed + 2 + v.y * 0.3, base[2] * W.speed + v.z * 0.5);
        b.angularVelocity.set(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
        const pr = { id: nextId++, owner: p.id, body: b, fuse: W.fuse, armed: 0.08 };
        b.addEventListener('collide', e => { if (e.body.ent && e.body.ent.kind === 'player' && (e.body.ent.id !== p.id || pr.armed <= 0)) pr.fuse = 0; });
        world.addBody(b); projs.push(pr);
        events.push({ t: 'shot', id: p.id, w: p.w });
        return;
      }
      const hits = [];
      let aim = base;
      if (p.assist) { const a = assistDir(p, eye, base); if (a) aim = a; }
      for (let k = 0; k < W.pellets; k++) {
        const sp = p.assist ? (W.pellets > 1 ? W.spread * 0.35 : 0) : W.spread * (moving ? 1.8 : 1);
        const base = aim;
        let d = [base[0] + (Math.random() - 0.5) * 2 * sp, base[1] + (Math.random() - 0.5) * 2 * sp, base[2] + (Math.random() - 0.5) * 2 * sp];
        const L = Math.hypot(...d); d = d.map(c => c / L);
        const h = rayHit(eye, d, W.range, p.body);
        const end = h ? h.p : [eye[0] + d[0] * W.range, eye[1] + d[1] * W.range, eye[2] + d[2] * W.range];
        let kind = 0;
        if (h) {
          const ent = h.body.ent;
          if (ent && ent.kind === 'player') {
            const v2 = players.get(ent.id);
            const hs = h.p[1] - h.body.position.y > 0.5;
            if (v2) { v2.body.velocity.x += d[0] * W.impulse * 0.12; v2.body.velocity.z += d[2] * W.impulse * 0.12; damagePlayer(v2, W.dmg * (hs ? 2 : 1), p, p.w, hs, d); }
            kind = hs ? 3 : 1;
          } else if (ent && ent.kind === 'piece') {
            const pc = pieces.get(ent.id); if (pc) damagePiece(pc, W.dmg, p.id);
            kind = 4;
          } else if (ent && ent.kind === 'res') {
            damageRes(res[ent.i], W.dmg * HARVEST_GUN, p.id);
            kind = 4;
          } else if (h.body.type === CANNON.Body.DYNAMIC) {
            const b = h.body;
            b.applyImpulse(V(d[0] * W.impulse, d[1] * W.impulse, d[2] * W.impulse), V(h.p[0] - b.position.x, h.p[1] - b.position.y, h.p[2] - b.position.z));
            if (ent && ent.kind === 'prop') { const pr = props[ent.i]; damageProp(pr, pr.def.boom ? W.dmg : W.dmg * HARVEST_GUN, p.id); }
            kind = 2;
          }
        }
        hits.push([r2(end[0]), r2(end[1]), r2(end[2]), kind]);
      }
      events.push({ t: 'shot', id: p.id, w: p.w, o: eye.map(r2), h: hits });
    }

    // strong aim assist: snap toward the visible enemy closest to the crosshair (head if it's near, else chest)
    function assistDir(p, eye, base) {
      let best = null, bestA = 0.2;
      for (const o of players.values()) {
        if (o === p || !o.alive) continue;
        const ob = o.body.position;
        for (const [hy, bonus] of [[0.62, 0.03], [0.15, 0]]) {
          const dx = ob.x - eye[0], dy = ob.y + hy - eye[1], dz = ob.z - eye[2], d = Math.hypot(dx, dy, dz);
          const a = Math.acos(clamp((dx * base[0] + dy * base[1] + dz * base[2]) / d, -1, 1)) - bonus;
          if (a < bestA && d < 120 && canSee(eye, [ob.x, ob.y + hy, ob.z])) { bestA = a; best = [dx / d, dy / d, dz / d]; }
        }
      }
      return best;
    }

    function explode(x, y, z, R, maxDmg, owner, w) {
      events.push({ t: 'boom', p: [r2(x), r2(y), r2(z)], r: R });
      const by = players.get(owner) || null;
      for (const v of players.values()) {
        if (!v.alive) continue;
        const b = v.body.position, dx = b.x - x, dy = b.y - y, dz = b.z - z, d = Math.hypot(dx, dy, dz);
        if (d >= R) continue;
        const s = 1 - d / R, n = d > 0.01 ? [dx / d, dy / d, dz / d] : [0, 1, 0];
        v.body.velocity.x += n[0] * s * 14; v.body.velocity.z += n[2] * s * 14; v.body.velocity.y += Math.max(0, n[1]) * s * 6 + s * 5;
        damagePlayer(v, maxDmg * s * (v === by ? 0.5 : 1), by, w, false, [n[0], 0.5, n[2]]);
      }
      for (const pc of [...pieces.values()]) {
        const d = Math.hypot(pc.cx - x, pc.cy - y, pc.cz - z);
        if (d < R + 1.5) damagePiece(pc, maxDmg * 1.6 * (1 - d / (R + 1.5)), owner);
      }
      const dyn = [...props.filter(p => p.alive).map(p => p.body), ...corpses.map(c => c.body)];
      for (const b of dyn) {
        const dx = b.position.x - x, dy = b.position.y - y + 0.4, dz = b.position.z - z, d = Math.hypot(dx, dy, dz);
        if (d >= R * 1.3) continue;
        const s = 1 - d / (R * 1.3), dv = s * 16;
        b.applyImpulse(V(dx / d * dv * b.mass, dy / d * dv * b.mass, dz / d * dv * b.mass), V((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
        const ent = b.ent;
        if (ent && ent.kind === 'prop') damageProp(props[ent.i], maxDmg * s, owner, 0.15 + Math.random() * 0.15);
      }
      for (const r of res) {
        if (!r.alive) continue;
        const d = Math.hypot(r.body.position.x - x, r.body.position.z - z);
        if (d < R + 0.5) damageRes(r, maxDmg * (1 - d / (R + 0.5)), owner);
      }
    }

    // ---------- building ----------
    const pieces = new Map(), slots = new Map();
    function pieceBody(pc) {
      const b = new CANNON.Body({ mass: 0, material: mWorld, collisionFilterGroup: G.WORLD, collisionFilterMask: -1 });
      for (const t of pieceTiles(pc.type, pc.mask)) b.addShape(new CANNON.Box(V(t[3], t[4], t[5])), V(t[0], t[1], t[2]), new CANNON.Quaternion(...t[6]));
      b.position.set(pc.x, pc.y, pc.z); b.quaternion.set(...qAxis(0, 1, 0, pc.dir * Math.PI / 2));
      b.ent = { kind: 'piece', id: pc.id };
      return b;
    }
    const pieceInfo = pc => [pc.id, pc.type, pc.x, pc.y, pc.z, pc.dir, pc.mask, Math.ceil(pc.hp), pc.owner];
    function build(p, m) {
      if (!p.alive || p.st !== 'live' || matchOver || p.buildCd > 0 || !BUILD_TYPES.includes(m.type)) return;
      const t = { type: m.type, x: num(m.x, NaN), y: num(m.y, NaN), z: num(m.z, NaN), dir: clamp(Math.floor(num(m.dir)), 0, 3) };
      if (t.type === 'wall') t.dir &= 1; else if (t.type !== 'stairs') t.dir = 0;
      // must sit exactly on the grid, inside the arena, and within reach
      const onCell = v => Math.abs(v / CELL - 0.5 - Math.floor(v / CELL)) < 1e-6, onLine = v => Math.abs(v / CELL - Math.round(v / CELL)) < 1e-6;
      const gridOk = t.type === 'wall' ? (t.dir ? onLine(t.x) && onCell(t.z) : onCell(t.x) && onLine(t.z)) : onCell(t.x) && onCell(t.z);
      if (!gridOk || !onLine(t.y * CELL / LVL) || t.y < 0 || t.y > 30 || Math.abs(t.x) > MAP.A || Math.abs(t.z) > MAP.A) return;
      const e = eyeOf(p), cy = t.y + 1.5;
      if (Math.hypot(t.x - e[0], cy - e[1], t.z - e[2]) > BUILD_REACH) return;
      const key = pieceKey(t);
      if (slots.has(key) || p.mats < BUILD_COST || pieces.size >= MAX_PIECES) return;
      if ([...pieces.values()].filter(q => q.owner === p.id).length >= MAX_PIECES_EACH) return;
      const pc = { id: nextId++, ...t, mask: FULL_MASK, hp: PIECE_HP[t.type], owner: p.id, key, cx: t.x, cy, cz: t.z };
      pc.body = pieceBody(pc); world.addBody(pc.body);
      pieces.set(pc.id, pc); slots.set(key, pc.id);
      p.mats -= BUILD_COST; p.buildCd = 0.1;
      events.push({ t: 'pb', p: pieceInfo(pc) });
    }
    function edit(p, m) {
      const pc = pieces.get(num(m.id)); if (!pc || pc.owner !== p.id || !p.alive) return;
      let mask = clamp(Math.floor(num(m.mask)), 0, FULL_MASK);
      if (pc.type === 'cone' && !CONE_BITS.some(b => mask & (1 << b))) return;
      if (!mask || mask === pc.mask) return;
      const e = eyeOf(p); if (Math.hypot(pc.cx - e[0], pc.cy - e[1], pc.cz - e[2]) > BUILD_REACH) return;
      world.removeBody(pc.body); pc.mask = mask; pc.body = pieceBody(pc); world.addBody(pc.body);
      events.push({ t: 'pe', id: pc.id, mask });
    }
    function damagePiece(pc, dmg, by) {
      if (!pieces.has(pc.id)) return;
      pc.hp -= dmg;
      if (pc.hp > 0) { events.push({ t: 'ph', id: pc.id, hp: Math.ceil(pc.hp) }); return; }
      world.removeBody(pc.body); pieces.delete(pc.id); slots.delete(pc.key);
      events.push({ t: 'pd', id: pc.id });
    }
    function clearPieces() { for (const pc of pieces.values()) world.removeBody(pc.body); pieces.clear(); slots.clear(); }
    const piecesState = () => [...pieces.values()].map(pieceInfo);

    // ---------- bots: they produce the same inputs a human would ----------
    function thinkBot(p, dt) { // eslint-disable-line complexity
      const B = p.bot, D = BOT_DIFF[B.diff], inp = p.input, eye = eyeOf(p), pos = p.body.position;
      B.t -= dt; B.errT -= dt; B.wpT -= dt;
      if (B.t <= 0) {
        B.t = 0.2;
        // bots pace themselves: a quiet spell after landing, then the distance they pick fights at grows over the match
        // (they always shoot back when hit, and leave skydivers alone)
        const engage = B.provoked > matchT ? 35 : B.calmUntil > matchT ? 0 : mode === 'respawn' ? 45 : Math.min(70, 8 + Math.max(0, matchT - 270) * 0.2);
        let best = null, bestD = engage;
        for (const o of players.values()) {
          if (o === p || !o.alive || ((o.st === 'fall' || o.st === 'glide') && B.provoked <= matchT)) continue;
          const oe = eyeOf(o), d = Math.hypot(oe[0] - eye[0], oe[1] - eye[1], oe[2] - eye[2]);
          if (d < bestD && canSee(eye, [oe[0], oe[1] - 0.3, oe[2]])) { bestD = d; best = o; }
        }
        if (best) { if (B.target !== best.id) { B.target = best.id; B.seen = 0; } }
        else if (B.target && !(players.get(B.target) || {}).alive) { B.target = null; if (mode === 'br') B.calmUntil = matchT + 30 + Math.random() * 30; }   // breather after a fight
        else if (B.target) { const o = players.get(B.target); B.lastSeen = [o.body.position.x, o.body.position.z]; B.target = null; }
        B.visible = !!best;
      }
      if (B.errT <= 0) { B.errT = 0.35; B.errX = (Math.random() - 0.5) * 2 * D.err; B.errY = (Math.random() - 0.5) * 2 * D.err; }
      const tgt = B.target && players.get(B.target);
      inp.fire = false; inp.jump = false; inp.r = false; inp.sprint = false; inp.mx = 0; inp.mz = 0;
      let wantYaw = inp.yaw, wantPitch = 0;
      if (tgt && tgt.alive && B.visible) {
        B.seen += dt;
        const te = eyeOf(tgt), dx = te[0] - eye[0], dz = te[2] - eye[2], hd = Math.hypot(dx, dz), d = Math.hypot(dx, te[1] - 0.35 - eye[1], dz);
        if (d < 8) inp.w = 1; else if (d > 12 && d < 28 && tgt.grounded && (B.phase + time * 0.15) % 3 < 0.6) inp.w = 2; else inp.w = 0;
        const tv = tgt.body.velocity, lead = inp.w === 2 ? d / WEAPONS[2].speed : 0;
        wantYaw = Math.atan2(-(dx + tv.x * lead), -(dz + tv.z * lead)) + B.errX;
        wantPitch = Math.atan2(te[1] - 0.35 - eye[1], hd) + B.errY + (inp.w === 2 ? hd * 0.012 : 0);
        const ang = Math.abs(angDiff(wantYaw, inp.yaw)) + Math.abs(wantPitch - inp.pitch);
        if (B.seen > D.react && ang < D.fireCone + (inp.w === 1 ? 0.06 : 0)) inp.fire = true;
        inp.mz = d > 18 ? 1 : d < 7 ? -1 : 0;
        inp.mx = Math.sin(time * 1.7 + B.phase) > 0 ? 1 : -1;
        if (Math.random() < dt * 0.4) inp.jump = true;
      } else {
        // caught outside the safe circle: head for it before anything else
        const outside = phase === 'live' && Math.hypot(pos.x - zone.x, pos.z - zone.z) > zone.r - 3;
        if (outside && (!B.wp || Math.hypot(B.wp[0] - zone.x, B.wp[1] - zone.z) > Math.max(2, zone.r - 3))) { B.wp = botWaypoint(); B.wpT = 12; }
        // early on, calm bots harvest: walk to a nearby tree or rock inside the circle and chop at it
        const harvesting = !outside && B.calmUntil > matchT && mode === 'br';
        B.resT = (B.resT || 0) - dt;
        if (harvesting && (!B.res || !B.res.alive) && B.resT <= 0) {
          B.resT = 1;   // look for a new tree at most once a second
          if (B.res && B.res.claim === p.id) B.res.claim = 0;
          B.res = null; let bd = 45;
          for (const r of res) {
            if (!r.alive || (r.claim && r.claim !== p.id && players.has(r.claim))) continue;
            const d = Math.hypot(r.body.position.x - pos.x, r.body.position.z - pos.z);
            if (d < bd && !inStorm(r.body.position.x, r.body.position.z)) { bd = d; B.res = r; }
          }
          if (B.res) B.res.claim = p.id;   // one bot per tree, so they don't chop each other
        }
        const rb = harvesting && B.res ? B.res.body.position : null, rd = rb ? Math.hypot(rb.x - pos.x, rb.z - pos.z) : 0;
        if (rb && rd < (B.res.type === 'rock' ? 2.1 : 1.6)) {
          inp.w = PICKAXE; wantYaw = Math.atan2(-(rb.x - pos.x), -(rb.z - pos.z)); wantPitch = B.res.type === 'rock' ? -0.45 : -0.1;
          inp.fire = Math.abs(angDiff(wantYaw, inp.yaw)) < 0.25; inp.mz = 0;
        } else {
          if (rb) B.wp = [rb.x, rb.z];
          else if (!B.wp || B.wpT <= 0 || Math.hypot(B.wp[0] - pos.x, B.wp[1] - pos.z) < 2) {
            if (B.lastSeen && !outside) { B.wp = B.lastSeen; B.lastSeen = null; }
            else if (harvesting) { const a = Math.random() * 6.283; B.wp = [clamp(pos.x + Math.cos(a) * 20, -ARENA_IN, ARENA_IN), clamp(pos.z + Math.sin(a) * 20, -ARENA_IN, ARENA_IN)]; }   // calm: potter about nearby
            else B.wp = botWaypoint();
            B.wpT = 8;
          }
          wantYaw = Math.atan2(-(B.wp[0] - pos.x), -(B.wp[1] - pos.z));
          inp.mz = 1; inp.sprint = outside || !(B.calmUntil > matchT);   // calm bots stroll unless the storm is coming
        }
        if (p.ammo[p.w] < WEAPONS[p.w].mag * 0.5) inp.r = true;
      }
      // stuck against something: hop and pick a new destination
      const hs = Math.hypot(p.body.velocity.x, p.body.velocity.z);
      if ((inp.mz || inp.mx) && hs < 1) { B.stuckT += dt; if (B.stuckT > 0.8 && !B.visible) { inp.fire = true; inp.w = PICKAXE; wantPitch = 0.1; } if (B.stuckT > 0.5) { inp.jump = true; if (B.stuckT > 1.2) { B.wp = null; B.stuckT = 0; } } } else B.stuckT = 0;
      const turn = D.turn * dt;
      inp.yaw += clamp(angDiff(wantYaw, inp.yaw), -turn, turn);
      inp.pitch += clamp(wantPitch - inp.pitch, -turn, turn);
    }

    function stepPlayer(p, dt) {
      if (!p.alive) {
        if (mode === 'respawn' && p.st === 'dead' && (phase === 'plane' || phase === 'live') && (p.respawnT -= dt) <= 0) skyRespawn(p);
        return;
      }
      if (p.bot) thinkBot(p, dt);
      const b = p.body, inp = p.input, W = WEAPONS[p.w];
      p.yaw = inp.yaw; p.pitch = inp.pitch;
      // lean (Q/E): ease toward the wanted side, but stop short of any wall or prop beside the head
      p.lean += (inp.lean - p.lean) * Math.min(1, 12 * dt);
      let room = LEAN_DIST;
      if (Math.abs(p.lean) > 0.01) {
        const s = Math.sign(p.lean), rx = Math.cos(p.yaw) * s, rz = -Math.sin(p.yaw) * s, ey = b.position.y + EYE;
        ray.reset();
        world.raycastClosest(V(b.position.x, ey, b.position.z), V(b.position.x + rx * (LEAN_DIST + 0.2), ey, b.position.z + rz * (LEAN_DIST + 0.2)), { collisionFilterMask: G.WORLD | G.PROP, skipBackfaces: true }, ray);
        if (ray.hasHit) room = Math.max(0, ray.distance - 0.2);
      }
      p.leanOff = clamp(p.lean * LEAN_DIST, -room, room);
      p.spawnProt = Math.max(0, p.spawnProt - dt);
      p.buildCd -= dt;
      // skydiving: the glider opens by itself near the ground
      if (p.st === 'fall') {
        ray.reset();
        world.raycastClosest(V(b.position.x, b.position.y, b.position.z), V(b.position.x, b.position.y - GLIDE_HEIGHT, b.position.z), { collisionFilterMask: G.WORLD | G.PROP, skipBackfaces: true }, ray);
        if (ray.hasHit || b.position.y < GLIDE_HEIGHT) { p.st = 'glide'; events.push({ t: 'glide', id: p.id }); }
      }
      ray.reset();
      world.raycastClosest(V(b.position.x, b.position.y, b.position.z), V(b.position.x, b.position.y - 1.2, b.position.z), { collisionFilterMask: G.WORLD | G.PROP | G.CORPSE, skipBackfaces: true }, ray);
      p.grounded = ray.hasHit;
      const air = p.st === 'fall' || p.st === 'glide';
      if (air && p.grounded) { p.st = 'live'; events.push({ t: 'land', id: p.id }); }
      // movement: steer horizontal velocity toward the wish direction (strong on the ground, weak in the air)
      let mx = inp.mx, mz = inp.mz; const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      const speed = p.st === 'fall' ? FALL_SPEED : p.st === 'glide' ? GLIDE_SPEED : (inp.sprint && mz > 0 ? 8.5 : 6);
      const wx = (-sy * mz + cy * mx) * speed, wz = (-cy * mz - sy * mx) * speed;
      const k = p.st === 'fall' ? Math.min(1, 1.6 * dt) : p.st === 'glide' ? Math.min(1, 2.5 * dt) : p.grounded ? Math.min(1, 14 * dt) : Math.min(1, 2.2 * dt);
      b.velocity.x += (wx - b.velocity.x) * k; b.velocity.z += (wz - b.velocity.z) * k;
      if (p.st === 'fall') {
        // terminal velocity; look down to dive faster
        const vt = p.pitch < -0.6 ? -38 : -24;
        if (b.velocity.y < vt) b.velocity.y += Math.min(vt - b.velocity.y, 30 * dt); else b.velocity.y -= 8 * dt;
      } else if (p.st === 'glide') {
        if (b.velocity.y < -GLIDE_SINK) b.velocity.y += Math.min(-GLIDE_SINK - b.velocity.y, 40 * dt);
      } else if (!p.grounded) b.velocity.y -= 8 * dt;  // players fall a bit snappier than props
      if (air) { // keep skydivers over the island
        const lim = MAP.A - 1.5;
        if (Math.abs(b.position.x) > lim) { b.position.x = Math.sign(b.position.x) * lim; b.velocity.x = 0; }
        if (Math.abs(b.position.z) > lim) { b.position.z = Math.sign(b.position.z) * lim; b.velocity.z = 0; }
      }
      p.jumpCd -= dt;
      if (inp.jump && p.grounded && p.st === 'live' && p.jumpCd <= 0) { b.velocity.y = 6.2; p.jumpCd = 0.35; }
      if (b.position.y < -15) { killPlayer(p, null, null, false, null); return; }
      // weapons
      p.cd -= dt;
      if (inp.w !== p.w) { p.w = inp.w; p.reloadT = 0; p.cd = Math.max(p.cd, 0.3); }
      if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) p.ammo[p.w] = WEAPONS[p.w].mag; }
      else if (!W.melee && ((inp.r && p.ammo[p.w] < W.mag) || p.ammo[p.w] <= 0)) { p.reloadT = W.reload; events.push({ t: 'reload', id: p.id }); }
      else if (inp.fire && p.cd <= 0 && !matchOver && p.st === 'live') { if (!W.melee) p.ammo[p.w]--; p.cd = W.rate; p.spawnProt = 0; fire(p); }
    }

    function stepPhase(dt) {
      if (phase === 'wait') {
        if (players.size && (phaseT -= dt) <= 0) startMatch();
        return;
      }
      // the plane keeps flying (for looks) until it is well past the island
      if (plane) {
        plane.s += PLANE_SPEED * dt;
        plane.x = plane.sx + plane.dx * plane.s; plane.z = plane.sz + plane.dz * plane.s;
        if (plane.s > PLANE_HALF * 2 + 20) plane = null;
      }
      if (phase === 'plane' || phase === 'live') matchT += dt;
      if (phase === 'plane') {
        const gone = !plane || plane.s > plane.sOut, over = plane && plane.s >= plane.sIn;
        for (const p of players.values()) {
          if (p.st !== 'plane') continue;
          if (plane) { p.body.position.set(plane.x, plane.y, plane.z); p.body.velocity.set(plane.dx * PLANE_SPEED, 0, plane.dz * PLANE_SPEED); }
          // jump whenever you like over the island; at the far edge everyone still aboard is pushed out
          if (gone || (over && (p.bot ? plane.s >= p.dropS : p.input.jump))) drop(p);
        }
        if (gone) { phase = 'live'; if (mode === 'respawn') phaseT = RESPAWN_MATCH_TIME; }
        checkWin();
        return;
      }
      if (phase === 'live') {
        for (const r of res) if (!r.alive && r.regrowT > 0 && (r.regrowT -= dt) <= 0) { r.alive = true; r.hp = r.def.hp; world.addBody(r.body); events.push({ t: 'rg', i: r.i }); }
        if (mode !== 'respawn') stepZone(dt);
        stormAcc += dt;
        if (stormAcc >= 1) {
          stormAcc -= 1;
          const dps = stormDps();
          for (const p of [...players.values()]) if (p.alive && inStorm(p.body.position.x, p.body.position.z)) damagePlayer(p, dps, null, -3, false, null);
        }
        if (mode === 'respawn' && (phaseT -= dt) <= 0) {   // time's up: most kills wins
          const top = [...players.values()].filter(p => p.st !== 'spec').sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
          endMatch(top || null, 'time');
        }
        checkWin();
        return;
      }
      if (phase === 'over' && (phaseT -= dt) <= 0) resetMatch();
    }

    function step(dt = TICK) {
      tick++; time += dt;
      stepPhase(dt);
      for (const p of players.values()) stepPlayer(p, dt);
      world.step(dt);
      for (const pr of projs) {
        pr.fuse -= dt; pr.armed -= dt;
        const b = pr.body.position;
        if (pr.fuse <= 0 || b.y < -15) { pr.dead = true; world.removeBody(pr.body); if (b.y > -15) explode(b.x, b.y, b.z, WEAPONS[2].radius, WEAPONS[2].dmg, pr.owner, 2); }
      }
      for (let i = projs.length - 1; i >= 0; i--) if (projs[i].dead) projs.splice(i, 1);
      for (const pr of props) {
        const b = pr.body;
        if (pr.alive && pr.boomT > 0 && (pr.boomT -= dt) <= 0) {
          pr.alive = false; pr.dirtyUntil = time + 1; pr.boomT = 0; pr.respawnT = mode === 'respawn' ? REGROW_TIME : Infinity; world.removeBody(b);
          explode(b.position.x, b.position.y, b.position.z, 7, 120, pr.boomBy, -2);
        } else if (!pr.alive && (pr.respawnT -= dt) <= 0) {
          resetProp(pr); world.addBody(b);
        } else if (pr.alive && b.position.y < -15) resetProp(pr);
      }
      for (let i = corpses.length - 1; i >= 0; i--) if ((corpses[i].t -= dt) <= 0) { world.removeBody(corpses[i].body); corpses.splice(i, 1); }
      if (matchOver) matchOver.t = phaseT;
    }
    function resetProp(pr) {
      const b = pr.body;
      b.position.set(pr.home.x, pr.home.y, pr.home.z); b.quaternion.set(0, 0, 0, 1); b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
      pr.alive = true; pr.hp = pr.def.hp || 0; pr.boomT = 0; pr.dirtyUntil = time + 1; b.wakeUp();
    }

    const propState = pr => { if (!pr.alive) return 0; const b = pr.body.position, q = pr.body.quaternion; return [r2(b.x), r2(b.y), r2(b.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]; };
    function snapshot(evts, full = true) {
      return {
        t: 's', k: tick, time: r3(time),
        p: [...players.values()].map(p => { const b = p.body.position, v = p.body.velocity; return [p.id, p.name, p.bot ? 1 : 0, r2(b.x), r2(b.y), r2(b.z), r3(p.yaw), r3(p.pitch), r2(v.x), r2(v.y), r2(v.z), Math.max(0, Math.ceil(p.hp)), p.alive ? 1 : 0, p.w, p.ammo[p.w], p.reloadT > 0 ? 1 : 0, p.kills, p.deaths, p.spawnProt > 0 ? 1 : 0, 0, r2(p.leanOff), Math.floor(p.mats), ST[p.st], p.place, r2(Math.max(0, p.respawnT || 0))]; }),
        // match: phase, phase timer, plane [x,y,z,yaw] and path, storm [x,z,r, next x,z,r, shrinking, timer, dps], alive, in match
        g: { ph: phase, mode, why: endReason, min: MIN_BR, max: MAX_PLAYERS, mt: r2(matchT), rt: RESPAWN_MATCH_TIME, t: r2(phaseT), pl: plane ? [r2(plane.x), r2(plane.y), r2(plane.z), r3(plane.yaw)] : 0, path: plane ? [r2(plane.sx), r2(plane.sz), r2(plane.ex), r2(plane.ez), r2(plane.sIn), r2(plane.sOut), r2(plane.s)] : 0,
          z: [r2(zone.x), r2(zone.z), r2(zone.r), zone.to.x, zone.to.z, zone.to.r, zone.shrinking ? 1 : 0, r2(Math.max(0, zone.t)), stormDps(), zone.stage >= STORM.length ? 1 : 0], n: aliveCount(), N: participants() },
        // props: the full list now and then; otherwise only the ones that are moving or just broke / came back ([i] = gone)
        prf: full ? 1 : 0,
        pr: full ? props.map(propState)
          : props.filter(pr => (pr.alive && pr.body.sleepState !== CANNON.Body.SLEEPING) || pr.dirtyUntil > time).map(pr => { const st = propState(pr); return st ? [pr.i, ...st] : [pr.i]; }),
        a: projs.map(pr => { const b = pr.body.position; return [pr.id, r2(b.x), r2(b.y), r2(b.z)]; }),
        c: corpses.map(c => { const b = c.body.position, q = c.body.quaternion; return [c.id, c.pid, r2(b.x), r2(b.y), r2(b.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]; }),
        m: matchOver ? [matchOver.winner, Math.ceil(matchOver.t)] : 0,
        e: evts,
      };
    }
    function takeEvents() { const e = events; events = []; return e; }

    return { MAP, players, step, snapshot, takeEvents, addPlayer, removePlayer, addBot, removeBot, setInput, piecesState, brokenRes,
      get phase() { return phase; }, zone,
      build: (id, m) => { const p = players.get(id); if (p) build(p, m); }, edit: (id, m) => { const p = players.get(id); if (p) edit(p, m); }, get time() { return time; } };
  }

  // ---------- a room: connection bookkeeping shared by the browser host and the Node server ----------
  function createRoom(CANNON, opts = {}) {
    const sim = createSim(CANNON);
    const conns = new Map();     // connection id -> player id
    let owner = null, netEvents = [], ticks = 0;
    function join(connId, name) {
      const id = sim.addPlayer(name, false);
      if (id == null) return { t: 'full' };
      conns.set(connId, id);
      if (owner == null) owner = connId;
      return { t: 'welcome', id, pieces: sim.piecesState(), res: sim.brokenRes() };
    }
    function leave(connId) {
      const id = conns.get(connId); if (id == null) return;
      sim.removePlayer(id); conns.delete(connId);
      if (owner === connId) owner = conns.size ? conns.keys().next().value : null;
    }
    // returns a reply for the sender, if any
    function message(connId, m) {
      if (!m || typeof m !== 'object') return null;
      const id = conns.get(connId); if (id == null) return null;
      if (m.t === 'i') sim.setInput(id, m);
      else if (m.t === 'ping') return { t: 'pong', c: num(m.c) };
      else if (m.t === 'build') sim.build(id, m);
      else if (m.t === 'edit') sim.edit(id, m);
      else if (m.t === 'bot' && connId === owner) {
        if (m.op === 'add') sim.addBot(m.diff); else if (m.op === 'remove') sim.removeBot();
      }
      return null;
    }
    // advances one physics tick; returns { local, net } snapshots (local every tick if asked, net every SNAP_EVERY ticks)
    function step() {
      sim.step(TICK); ticks++;
      const ev = sim.takeEvents();
      if (ev.length) netEvents.push(...ev);
      const ownerId = conns.get(owner) || 0;
      const out = { local: null, net: null };
      if (opts.localSnaps) { out.local = sim.snapshot(ev); out.local.o = ownerId; }
      if (ticks % SNAP_EVERY === 0) { out.net = sim.snapshot(netEvents, ticks % (SNAP_EVERY * 40) === 0); out.net.o = ownerId; netEvents = []; }
      return out;
    }
    return { sim, join, leave, message, step, get size() { return conns.size; }, get owner() { return owner; } };
  }

  return { TICK, SNAP_EVERY, MAX_HP, MIN_BR, MAX_PLAYERS, RESPAWN_MATCH_TIME, WEAPONS, PICKAXE, BOT_DIFF, PROP_TYPES, RES_TYPES, EYE, LEAN_DIST, LEAN_DROP, SECRET, ST, ST_NAMES, PLANE_ALT, STORM,
    CELL, LVL, BUILD_TYPES, PIECE_HP, BUILD_COST, MATS_MAX, CONE_BITS, FULL_MASK, BUILD_REACH, pieceTiles, buildTarget, pieceKey, qAxis, buildMap, createSim, createRoom };
});
