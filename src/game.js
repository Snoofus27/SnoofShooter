(() => {
  'use strict';

  // ---------- Config ----------
  const PALETTE = {
    R: '#ff4d5e', O: '#ff9a2e', Y: '#ffd23f', G: '#3ddc84', B: '#3d8bff', C: '#2fe0e0',
    P: '#9b5cff', K: '#ff7ac6', W: '#f4f1ea', N: '#9a6234', D: '#56627f',
  };
  const DOCK_SLOTS = 5;
  const FIRE_INTERVAL = 0.11; // seconds between shots per shooter
  const PROJ_SPEED = 1500;    // px per second
  const QUEUE_VISIBLE = 3;    // shooters drawn per column
  const STORAGE_KEY = 'snoofshooter.progress';
  const LEVELS = window.SNOOF_LEVELS;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const menuEl = $('menu');
  const resultEl = $('result');

  let W = 0, H = 0, dpr = 1;
  let L = null;     // layout
  let game = null;  // current level state
  let paused = true;

  // ---------- Storage ----------
  function loadProgress() {
    try {
      const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (p && typeof p.unlocked === 'number') {
        return { unlocked: p.unlocked, done: p.done || {}, muted: !!p.muted };
      }
    } catch (e) { /* storage unavailable */ }
    return { unlocked: 0, done: {}, muted: false };
  }
  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* ignore */ }
  }
  const progress = loadProgress();

  // ---------- Sound ----------
  const Sound = {
    ctx: null,
    last: {},
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); } catch (e) { /* no audio */ } }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, { type = 'square', vol = 0.04, slide = 0, delay = 0 } = {}) {
      if (progress.muted || !this.ctx) return;
      const t = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    throttle(name, ms) {
      const now = performance.now();
      if (now - (this.last[name] || 0) < ms) return false;
      this.last[name] = now;
      return true;
    },
    shoot() { if (this.throttle('shoot', 60)) this.tone(900, 0.05, { vol: 0.012, slide: -450 }); },
    pop() { if (this.throttle('pop', 35)) this.tone(260 + Math.random() * 200, 0.09, { type: 'triangle', vol: 0.06, slide: -150 }); },
    tap() { this.tone(420, 0.08, { type: 'sine', vol: 0.08, slide: 240 }); },
    deny() { this.tone(140, 0.18, { type: 'sawtooth', vol: 0.04, slide: -60 }); },
    done() { this.tone(620, 0.1, { type: 'sine', vol: 0.05, slide: 300 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, { type: 'triangle', vol: 0.07, delay: i * 0.11 })); },
    lose() { [392, 330, 262].forEach((f, i) => this.tone(f, 0.3, { type: 'sawtooth', vol: 0.035, delay: i * 0.16 })); },
  };

  // ---------- Helpers ----------
  const shadeCache = {};
  function shade(hex, amt) {
    const key = hex + amt;
    if (shadeCache[key]) return shadeCache[key];
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(Math.min(255, Math.max(0, amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
    const out = `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
    return (shadeCache[key] = out);
  }

  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  // ---------- Level building ----------
  function parseArt(lv) {
    const rows = lv.art.length;
    const cols = Math.max(...lv.art.map((r) => r.length));
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        let ch = lv.art[r][c] || '.';
        if (ch === '.') ch = lv.bg || null;
        row.push(ch && PALETTE[ch] ? ch : null);
      }
      grid.push(row);
    }
    return grid;
  }

  function bottomRow(grid, c) {
    for (let r = grid.length - 1; r >= 0; r--) if (grid[r][c]) return r;
    return -1;
  }

  // Simulate clearing the picture one shooter at a time. The resulting order is
  // always solvable when played front-to-back, which keeps generated levels fair.
  function buildSequence(source, lv) {
    const g = source.map((r) => r.slice());
    const cols = g[0].length;
    const [kmin, kmax] = lv.chunk || [6, 12];
    const exposed = () => {
      const out = [];
      for (let c = 0; c < cols; c++) {
        const r = bottomRow(g, c);
        if (r >= 0) out.push([r, c]);
      }
      return out;
    };
    let remaining = g.flat().filter(Boolean).length;
    const seq = [];
    while (remaining > 0) {
      const ex = exposed();
      const [er, ec] = ex[Math.floor(Math.random() * ex.length)];
      const color = g[er][ec];
      const k = randInt(kmin, kmax);
      let n = 0;
      while (n < k) {
        const options = exposed().filter(([r, c]) => g[r][c] === color);
        if (!options.length) break;
        const [r, c] = options[Math.floor(Math.random() * options.length)];
        g[r][c] = null;
        n++;
        remaining--;
      }
      const prev = seq[seq.length - 1];
      if (prev && prev.color === color && prev.ammo + n <= kmax) prev.ammo += n;
      else seq.push({ color, ammo: n });
    }
    const shuffle = lv.shuffle || 0;
    for (let i = 0; i < seq.length - 1; i++) {
      if (Math.random() < shuffle) [seq[i], seq[i + 1]] = [seq[i + 1], seq[i]];
    }
    return seq;
  }

  function makeShooter(color, ammo) {
    return {
      color, ammo, x: 0, y: 0, size: 40, tx: 0, ty: 0, tsize: 40,
      where: 'queue', slot: -1, cool: 0, angle: -Math.PI / 2, inFlight: 0,
      leaving: false, leaveT: 0, flash: 0,
    };
  }

  function startLevel(idx) {
    const lv = LEVELS[idx];
    const grid = parseArt(lv);
    const seq = buildSequence(grid, lv);
    const nCols = lv.columns || 4;
    const columns = Array.from({ length: nCols }, () => []);
    seq.forEach((s, i) => columns[i % nCols].push(makeShooter(s.color, s.ammo)));
    const total = grid.flat().filter(Boolean).length;
    game = {
      idx, lv, grid, art: parseArt(lv),
      rows: grid.length, cols: grid[0].length,
      reserved: grid.map((r) => r.map(() => false)),
      built: grid.map((r) => r.map(() => false)),
      total, remaining: total,
      columns, dock: Array(DOCK_SLOTS).fill(null),
      projectiles: [], particles: [],
      state: 'play', endTimer: 0, stuckT: 0, dockShake: 0, time: 0, result: null,
    };
    computeLayout();
    placeAll(true);
    // Slide the queue in from below.
    for (const col of columns) col.forEach((s, j) => { s.y = H + 60 + j * 40; });
    $('level-title').textContent = `${idx + 1}. ${lv.name}`;
    hide(menuEl);
    hide(resultEl);
    paused = false;
  }

  // ---------- Layout ----------
  function computeLayout() {
    if (!game) return;
    const pad = 14;
    const hudH = 56;
    const nQ = game.columns.length;
    const slotS = Math.min(64, (W - 2 * pad) / (DOCK_SLOTS + (DOCK_SLOTS - 1) * 0.22));
    const slotGap = slotS * 0.22;
    const dockH = slotS + 16;
    const qS = Math.min(slotS * 0.95, ((W - 2 * pad) / nQ) * 0.72);
    const qGap = qS * 0.2;
    const queueH = QUEUE_VISIBLE * qS + (QUEUE_VISIBLE - 1) * qGap + 26;
    const laneH = Math.max(30, H * 0.05);
    const gridAvailH = Math.max(80, H - hudH - laneH - dockH - queueH - pad * 2);
    const cell = Math.max(8, Math.floor(Math.min((W - 2 * pad) / game.cols, gridAvailH / game.rows)));
    const gw = cell * game.cols;
    const gh = cell * game.rows;
    const gx = (W - gw) / 2;
    const gy = hudH + pad + (gridAvailH - gh) / 2;
    const dockY = hudH + pad + gridAvailH + laneH;
    const dockW = DOCK_SLOTS * slotS + (DOCK_SLOTS - 1) * slotGap;
    L = {
      pad, hudH, cell, gx, gy, gw, gh, slotS, slotGap, dockY,
      dockX: (W - dockW) / 2, dockW,
      qS, qGap, queueY: dockY + dockH + pad * 0.6, colW: (W - 2 * pad) / nQ,
    };
  }

  function slotPos(i) {
    return { x: L.dockX + i * (L.slotS + L.slotGap) + L.slotS / 2, y: L.dockY + L.slotS / 2 };
  }
  function queuePos(ci, j) {
    const jj = Math.min(j, QUEUE_VISIBLE - 1);
    return { x: L.pad + ci * L.colW + L.colW / 2, y: L.queueY + jj * (L.qS + L.qGap) + L.qS / 2 };
  }
  function blockCenter(r, c) {
    return { x: L.gx + (c + 0.5) * L.cell, y: L.gy + (r + 0.5) * L.cell };
  }

  function placeAll(snap) {
    game.columns.forEach((col, ci) => col.forEach((s, j) => {
      const p = queuePos(ci, j);
      s.tx = p.x; s.ty = p.y; s.tsize = j === 0 ? L.qS : L.qS * 0.86;
      if (snap) { s.x = s.tx; s.y = s.ty; s.size = s.tsize; }
    }));
    game.dock.forEach((s, i) => {
      if (!s) return;
      const p = slotPos(i);
      s.tx = p.x; s.ty = p.y; s.tsize = L.slotS * 0.9;
      if (snap) { s.x = s.tx; s.y = s.ty; s.size = s.tsize; }
    });
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (game) { computeLayout(); placeAll(true); }
  }

  // ---------- Gameplay ----------
  function launch(ci) {
    const slot = game.dock.indexOf(null);
    if (slot < 0) { game.dockShake = 0.35; Sound.deny(); return; }
    const s = game.columns[ci].shift();
    s.where = 'dock';
    s.slot = slot;
    s.cool = 0.12;
    game.dock[slot] = s;
    placeAll(false);
    Sound.tap();
  }

  function findTarget(s) {
    const g = game;
    let best = null, bd = Infinity;
    for (let c = 0; c < g.cols; c++) {
      const r = bottomRow(g.grid, c);
      if (r < 0 || g.grid[r][c] !== s.color || g.reserved[r][c]) continue;
      const d = Math.abs(blockCenter(r, c).x - s.x);
      if (d < bd) { bd = d; best = { r, c }; }
    }
    return best;
  }

  function hasTarget(color) {
    const g = game;
    for (let c = 0; c < g.cols; c++) {
      const r = bottomRow(g.grid, c);
      if (r >= 0 && g.grid[r][c] === color && !g.reserved[r][c]) return true;
    }
    return false;
  }

  function fire(s, t) {
    const g = game;
    s.ammo--;
    s.inFlight++;
    s.flash = 1;
    g.reserved[t.r][t.c] = true;
    const tc = blockCenter(t.r, t.c);
    s.angle = Math.atan2(tc.y - s.y, tc.x - s.x);
    const ox = s.x + Math.cos(s.angle) * s.size * 0.6;
    const oy = s.y + Math.sin(s.angle) * s.size * 0.6;
    g.projectiles.push({ x: ox, y: oy, r: t.r, c: t.c, color: PALETTE[s.color], shooter: s, trail: [] });
    Sound.shoot();
  }

  function hit(p) {
    const g = game;
    const key = g.grid[p.r][p.c];
    g.grid[p.r][p.c] = null;
    g.reserved[p.r][p.c] = false;
    g.built[p.r][p.c] = true;
    g.remaining--;
    p.shooter.inFlight--;
    const { x, y } = blockCenter(p.r, p.c);
    burst(x, y, PALETTE[key], 9, L.cell);
    Sound.pop();
  }

  function burst(x, y, color, n, scale) {
    const parts = game.particles;
    for (let i = 0; i < n && parts.length < 500; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(60, 260) * (scale / 30 + 0.5);
      parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        life: rand(0.35, 0.7), max: 0.7, color, size: rand(0.15, 0.32) * scale, rot: rand(0, 6),
      });
    }
  }

  function isStuck() {
    const g = game;
    if (g.projectiles.length) return false;
    for (const s of g.dock) {
      if (!s) continue;
      if (s.leaving || Math.hypot(s.x - s.tx, s.y - s.ty) > 3) return false;
      if (s.ammo > 0 && hasTarget(s.color)) return false;
    }
    const free = g.dock.includes(null);
    const queueLeft = g.columns.some((c) => c.length);
    return !(free && queueLeft);
  }

  function easeShooter(s, k) {
    s.x += (s.tx - s.x) * k;
    s.y += (s.ty - s.y) * k;
    s.size += (s.tsize - s.size) * k;
  }

  function update(dt) {
    const g = game;
    if (!g) return;
    g.time += dt;
    g.dockShake = Math.max(0, g.dockShake - dt);
    const k = 1 - Math.exp(-dt * 14);
    for (const col of g.columns) for (const s of col) easeShooter(s, k);

    for (let i = 0; i < DOCK_SLOTS; i++) {
      const s = g.dock[i];
      if (!s) continue;
      easeShooter(s, k);
      s.flash = Math.max(0, s.flash - dt * 7);
      if (s.leaving) {
        s.leaveT += dt;
        if (s.leaveT >= 0.35) g.dock[i] = null;
        continue;
      }
      if (Math.hypot(s.x - s.tx, s.y - s.ty) > 3 || g.state === 'over') continue;
      if (s.ammo > 0) {
        s.cool -= dt;
        if (s.cool <= 0) {
          const t = findTarget(s);
          if (t) { fire(s, t); s.cool = FIRE_INTERVAL; } else s.cool = 0;
        }
      } else if (s.inFlight === 0) {
        s.leaving = true;
        s.leaveT = 0;
        burst(s.x, s.y, PALETTE[s.color], 14, s.size * 0.8);
        Sound.done();
      }
    }

    for (let i = g.projectiles.length - 1; i >= 0; i--) {
      const p = g.projectiles[i];
      const t = blockCenter(p.r, p.c);
      const dx = t.x - p.x, dy = t.y - p.y;
      const d = Math.hypot(dx, dy);
      const step = PROJ_SPEED * dt;
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 6) p.trail.shift();
      if (d <= step) { hit(p); g.projectiles.splice(i, 1); }
      else { p.x += (dx / d) * step; p.y += (dy / d) * step; }
    }

    for (let i = g.particles.length - 1; i >= 0; i--) {
      const p = g.particles[i];
      p.life -= dt;
      if (p.life <= 0) { g.particles.splice(i, 1); continue; }
      p.vy += 700 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += dt * 8;
    }

    if (g.state === 'play') {
      if (g.remaining === 0) {
        g.state = 'ending'; g.endTimer = 1.0; g.result = 'win'; Sound.win();
      } else if (isStuck()) {
        g.stuckT += dt;
        if (g.stuckT > 0.6) { g.state = 'ending'; g.endTimer = 0.5; g.result = 'lose'; Sound.lose(); }
      } else g.stuckT = 0;
    } else if (g.state === 'ending') {
      g.endTimer -= dt;
      if (g.endTimer <= 0) { g.state = 'over'; showResult(g.result === 'win'); }
    }
  }

  // ---------- Drawing ----------
  function drawBlock(x, y, s, hex, exposed) {
    const p = Math.max(1, s * 0.06);
    const w = s - 2 * p;
    ctx.fillStyle = hex;
    rr(x + p, y + p, w, w, s * 0.2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rr(x + p, y + p + w * 0.62, w, w * 0.38, s * 0.18);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    rr(x + p * 2.2, y + p * 2, w - p * 2.4, w * 0.26, s * 0.12);
    ctx.fill();
    if (exposed) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(1, s * 0.06);
      rr(x + p, y + p, w, w, s * 0.2);
      ctx.stroke();
    }
  }

  function drawHUD() {
    const g = game;
    const thumbS = L.hudH - 12;
    const tc = thumbS / Math.max(g.rows, g.cols);
    const tx = W - L.pad - tc * g.cols;
    const ty = 6 + (thumbS - tc * g.rows) / 2;

    // Thumbnail that builds up as blocks are cleared.
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    rr(tx - 4, 2, tc * g.cols + 8, thumbS + 8, 8);
    ctx.fill();
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const key = g.art[r][c];
      if (!key) continue;
      ctx.globalAlpha = g.built[r][c] ? 1 : 0.13;
      ctx.fillStyle = PALETTE[key];
      ctx.fillRect(tx + c * tc, ty + r * tc, Math.ceil(tc), Math.ceil(tc));
    }
    ctx.globalAlpha = 1;

    const bx = L.pad, bw = tx - 18 - L.pad, by = 20, bh = 14;
    const pct = 1 - g.remaining / g.total;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    rr(bx, by, bw, bh, bh / 2);
    ctx.fill();
    if (pct > 0) {
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#ff4d5e');
      grad.addColorStop(0.5, '#ffd23f');
      grad.addColorStop(1, '#3ddc84');
      ctx.fillStyle = grad;
      rr(bx, by, Math.max(bh, bw * pct), bh, bh / 2);
      ctx.fill();
    }
    ctx.fillStyle = '#9aa0b8';
    ctx.font = '600 12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.floor(pct * 100)}% built · ${g.remaining} blocks left`, bx, by + bh + 6);
  }

  function drawGrid() {
    const g = game;
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    rr(L.gx - 8, L.gy - 8, L.gw + 16, L.gh + 16, 14);
    ctx.fill();
    const exposedRow = [];
    for (let c = 0; c < g.cols; c++) exposedRow[c] = bottomRow(g.grid, c);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const key = g.grid[r][c];
      const x = L.gx + c * L.cell, y = L.gy + r * L.cell;
      if (!key) {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(x + L.cell / 2 - 1, y + L.cell / 2 - 1, 2, 2);
        continue;
      }
      drawBlock(x, y, L.cell, PALETTE[key], exposedRow[c] === r);
    }
  }

  function drawShooter(s, alpha, inDock) {
    let S = s.size;
    let a = alpha;
    if (s.leaving) {
      const t = Math.min(1, s.leaveT / 0.35);
      S *= 1 + t * 0.4;
      a *= 1 - t;
    }
    if (a <= 0.01) return;
    const hex = PALETTE[s.color];
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(s.x, s.y);

    if (inDock) {
      ctx.save();
      ctx.rotate(s.angle + Math.PI / 2);
      ctx.fillStyle = shade(hex, -0.4);
      rr(-S * 0.13, -S * 0.82, S * 0.26, S * 0.55, S * 0.08);
      ctx.fill();
      if (s.flash > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,255,255,${s.flash * 0.8})`;
        ctx.beginPath();
        ctx.arc(0, -S * 0.85, S * 0.22 * (0.6 + s.flash * 0.6), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }

    ctx.fillStyle = shade(hex, -0.4);
    rr(-S / 2, -S / 2, S, S, S * 0.26);
    ctx.fill();
    ctx.fillStyle = hex;
    rr(-S / 2 + S * 0.07, -S / 2 + S * 0.05, S * 0.86, S * 0.82, S * 0.22);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    rr(-S / 2 + S * 0.14, -S / 2 + S * 0.1, S * 0.72, S * 0.2, S * 0.1);
    ctx.fill();

    ctx.font = `800 ${Math.round(S * 0.4)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, S * 0.08);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(String(s.ammo), 0, S * 0.04);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(s.ammo), 0, S * 0.04);
    ctx.restore();
  }

  function drawDock() {
    const g = game;
    const shakeX = g.dockShake > 0 ? Math.sin(g.time * 70) * 7 * (g.dockShake / 0.35) : 0;
    ctx.save();
    ctx.translate(shakeX, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    rr(L.dockX - 10, L.dockY - 8, L.dockW + 20, L.slotS + 16, 16);
    ctx.fill();
    for (let i = 0; i < DOCK_SLOTS; i++) {
      const p = slotPos(i);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = g.dockShake > 0 ? 'rgba(255,77,94,0.7)' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      rr(p.x - L.slotS / 2, p.y - L.slotS / 2, L.slotS, L.slotS, L.slotS * 0.24);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    for (const s of g.dock) if (s) drawShooter(s, 1, true);
  }

  function drawQueue() {
    const g = game;
    const canLaunch = g.state === 'play' && g.dock.includes(null);
    g.columns.forEach((col, ci) => {
      const cx = L.pad + ci * L.colW + L.colW / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      rr(cx - L.qS * 0.62, L.queueY - 6, L.qS * 1.24, QUEUE_VISIBLE * (L.qS + L.qGap) + 4, 12);
      ctx.fill();
      const n = Math.min(col.length, QUEUE_VISIBLE);
      for (let j = n - 1; j >= 0; j--) {
        const s = col[j];
        if (j === 0 && canLaunch) {
          const pulse = 0.35 + Math.sin(g.time * 5) * 0.2;
          ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
          ctx.lineWidth = 2;
          rr(s.x - s.size / 2 - 4, s.y - s.size / 2 - 4, s.size + 8, s.size + 8, s.size * 0.3);
          ctx.stroke();
        }
        drawShooter(s, j === 0 ? 1 : 0.5, false);
      }
      if (col.length > QUEUE_VISIBLE) {
        ctx.fillStyle = '#9aa0b8';
        ctx.font = '700 12px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const last = queuePos(ci, QUEUE_VISIBLE - 1);
        ctx.fillText(`+${col.length - QUEUE_VISIBLE}`, cx, last.y + L.qS / 2 + 4);
      }
    });
  }

  function drawProjectiles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of game.projectiles) {
      const rad = Math.max(4, L.cell * 0.22);
      if (p.trail.length) {
        ctx.strokeStyle = p.color;
        ctx.lineCap = 'round';
        ctx.lineWidth = rad * 1.1;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (const t of p.trail) ctx.lineTo(t.x, t.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 2.2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, p.color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of game.particles) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life / p.max * 1.6);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!game || !L) return;
    drawHUD();
    drawGrid();
    drawDock();
    drawQueue();
    drawProjectiles();
    drawParticles();
  }

  // Render level art to a small canvas (menu thumbnails, result screen).
  function drawArt(cv, lv, locked) {
    const grid = parseArt(lv);
    const rows = grid.length, cols = grid[0].length;
    const px = 8;
    cv.width = cols * px;
    cv.height = rows * px;
    const c2 = cv.getContext('2d');
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue;
      c2.fillStyle = locked ? '#2d3048' : PALETTE[grid[r][c]];
      c2.fillRect(c * px, r * px, px, px);
    }
  }

  // ---------- Screens ----------
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  function buildLevelGrid() {
    const wrap = $('level-grid');
    wrap.innerHTML = '';
    LEVELS.forEach((lv, i) => {
      const locked = i > progress.unlocked;
      const b = document.createElement('button');
      b.className = 'lvl' + (locked ? ' locked' : '') + (progress.done[i] ? ' done' : '');
      const cv = document.createElement('canvas');
      drawArt(cv, lv, locked);
      const label = document.createElement('span');
      label.textContent = locked ? `🔒 ${i + 1}` : `${i + 1}. ${lv.name}`;
      b.append(cv, label);
      b.disabled = locked;
      b.addEventListener('click', () => { Sound.unlock(); startLevel(i); });
      wrap.append(b);
    });
  }

  function showMenu() {
    paused = true;
    buildLevelGrid();
    const resumable = game && game.state === 'play';
    $('btn-play').textContent = resumable ? 'Resume' : 'Play';
    hide(resultEl);
    show(menuEl);
  }

  function showResult(win) {
    const idx = game.idx;
    if (win) {
      progress.done[idx] = true;
      progress.unlocked = Math.min(LEVELS.length - 1, Math.max(progress.unlocked, idx + 1));
      saveProgress();
    }
    const last = idx === LEVELS.length - 1;
    $('result-title').textContent = win ? 'Picture complete!' : 'Dock jammed!';
    $('result-text').textContent = win
      ? (last ? 'You finished every level! Replays reshuffle the shooters.' : `You built "${game.lv.name}".`)
      : 'No shooter could fire and the dock was full. Plan your picks and try again.';
    drawArt($('result-art'), game.lv, false);
    $('btn-result-next').classList.toggle('hidden', !win || last);
    show(resultEl);
  }

  function updateSoundIcon() {
    $('btn-sound').textContent = progress.muted ? '🔇' : '🔊';
  }

  // ---------- Input ----------
  canvas.addEventListener('pointerdown', (e) => {
    Sound.unlock();
    if (!game || paused || game.state !== 'play') return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    for (let ci = 0; ci < game.columns.length; ci++) {
      const col = game.columns[ci];
      if (!col.length) continue;
      const p = queuePos(ci, 0);
      if (Math.abs(x - p.x) <= L.colW / 2 && Math.abs(y - p.y) <= L.qS / 2 + L.qGap) {
        launch(ci);
        return;
      }
    }
  });

  $('btn-menu').addEventListener('click', showMenu);
  $('btn-restart').addEventListener('click', () => { if (game) startLevel(game.idx); });
  $('btn-sound').addEventListener('click', () => {
    progress.muted = !progress.muted;
    saveProgress();
    updateSoundIcon();
  });
  $('btn-play').addEventListener('click', () => {
    Sound.unlock();
    if (game && game.state === 'play') { hide(menuEl); paused = false; return; }
    let idx = progress.unlocked;
    if (progress.done[idx]) idx = LEVELS.findIndex((_, i) => !progress.done[i]);
    startLevel(idx < 0 ? 0 : idx);
  });
  $('btn-result-retry').addEventListener('click', () => startLevel(game.idx));
  $('btn-result-next').addEventListener('click', () => startLevel(game.idx + 1));
  $('btn-result-menu').addEventListener('click', showMenu);

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  // ---------- Main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  resize();
  updateSoundIcon();
  showMenu();
  requestAnimationFrame(frame);

  // Exposed for debugging in the browser console.
  window.snoof = { get game() { return game; }, startLevel };
})();
