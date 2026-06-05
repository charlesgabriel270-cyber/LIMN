// ═══════════════════════════════════════════════════════
//  LIMN · engine.js
//  Mundo infinito por chunks · Multiplayer realtime · Ecos
// ═══════════════════════════════════════════════════════

// ── CONFIG ──────────────────────────────────────────────
const CHUNK_SIZE   = 4;   // salas por chunk (4x4)
const ROOM_SIZE    = 4;   // metros por sala
const ROOM_H       = 2.8;
const MOVE_SPEED   = 0.055;
const CHUNK_RADIUS = 1;   // chunks carregados ao redor — reduzido pra performance
const PLAYER_COLOR_SEED = 0x9b59b6;

// ── SUPABASE ─────────────────────────────────────────────
const SB_URL = "https://egfslhfevswjzmohrljm.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnZnNsaGZldnN3anptb2hybGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNzU0NzksImV4cCI6MjA5NTg1MTQ3OX0.sq9Dswanc9npNGMLSUTQ6Z7l5pv9ZRoBTKBWBkHy6ko";

// ── STATE ────────────────────────────────────────────────
let scene, camera, renderer;
let yaw = 0, pitch = 0, pointerLocked = false;
let frame = 0;
let playerName = '', playerId = null, playerColor = '#c8af3c';
let isFragmenting = false;
let currentEchoId = null;
let currentRoomKey = '0,0';
let lastRoomKey = '';

const keys = {}, mobile = { f:0, b:0, l:0, r:0 };
const loadedChunks = new Map();   // "cx,cy" -> THREE.Group
const roomWalls    = new Set();   // "rx,ry" passable rooms
const echoCache    = {};          // roomKey -> [{id,text,author,resonances}]
const echoOrbs     = {};          // roomKey -> THREE.Group
const playerLights = {};          // playerId -> THREE.Group
let realtimeChannel = null;

// ── SEEDED RNG ───────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// ── PLAYER COLOR from name ───────────────────────────────
function nameToColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xFFFFFF;
  const hue = (h % 360);
  return `hsl(${hue},70%,65%)`;
}
function hslToHex(hsl) {
  const tmp = document.createElement('div');
  tmp.style.color = hsl;
  document.body.appendChild(tmp);
  const c = getComputedStyle(tmp).color;
  document.body.removeChild(tmp);
  const m = c.match(/\d+/g).map(Number);
  return (m[0] << 16) | (m[1] << 8) | m[2];
}

// ── LOADING SCREEN ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const bar = document.getElementById('loading-bar');
  const status = document.getElementById('loading-status');
  const steps = [
    [300,  20, 'calibrando lâmpadas...'],
    [600,  50, 'construindo corredores...'],
    [900,  80, 'a mente está acordando...'],
    [1200, 100, ''],
  ];
  steps.forEach(([delay, pct, msg]) => {
    setTimeout(() => {
      bar.style.width = pct + '%';
      if (msg) status.textContent = msg;
      if (pct === 100) {
        setTimeout(() => {
          document.getElementById('screen-loading').style.opacity = '0';
          setTimeout(() => {
            document.getElementById('screen-loading').style.display = 'none';
            document.getElementById('screen-entry').style.display = 'flex';
            document.getElementById('entry-name').focus();
          }, 800);
        }, 300);
      }
    }, delay);
  });

  document.getElementById('entry-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') startGame();
  });
});

// ── START ────────────────────────────────────────────────
window.startGame = function () {
  const val = document.getElementById('entry-name').value.trim();
  playerName = val || 'anônimo';
  playerId   = 'p_' + Math.random().toString(36).slice(2, 10);
  playerColor = nameToColor(playerName);

  // recupera última posição
  const saved = localStorage.getItem('limn_pos');
  let startX = 0, startZ = 0;
  if (saved) {
    try { const p = JSON.parse(saved); startX = p.x; startZ = p.z; } catch {}
  }

  document.getElementById('screen-entry').style.display = 'none';
  document.getElementById('screen-game').style.display = 'block';

  initThree(startX, startZ);
  buildInitialChunks(startX, startZ);
  setupInput();
  connectRealtime();
  animate();

  // salva posição periodicamente
  setInterval(savePosition, 5000);
  window.addEventListener('beforeunload', () => { savePosition(); disconnectPlayer(); });
};

function savePosition() {
  if (!camera) return;
  localStorage.setItem('limn_pos', JSON.stringify({
    x: camera.position.x, z: camera.position.z
  }));
}

// ── THREE.JS ─────────────────────────────────────────────
function initThree(sx, sz) {
  const canvas = document.getElementById('c');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080700);
  scene.fog = new THREE.Fog(0x080700, 8, 26);

  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 40);
  camera.rotation.order = 'YXZ';
  camera.position.set(sx, ROOM_H * 0.42, sz);

  scene.add(new THREE.AmbientLight(0x2a2000, 0.4));
  resize(); window.addEventListener('resize', resize);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

// ── TEXTURES ─────────────────────────────────────────────
const texCache = {};
function makeTex(hex, grid, rep = 3) {
  const k = `${hex}_${grid}_${rep}`;
  if (texCache[k]) return texCache[k];
  const s = 128, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const r = (hex>>16)&255, g = (hex>>8)&255, b = hex&255;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = (Math.random()-.5)*20;
    ctx.fillStyle = `rgb(${(r+n)|0},${(g+n)|0},${(b+n)|0})`;
    ctx.fillRect(x,y,1,1);
  }
  if (grid) {
    ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 1;
    for (let i = 0; i < s; i += 12) {
      ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(s,i); ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rep, rep);
  texCache[k] = t;
  return t;
}

const MAT = {
  floor:  () => new THREE.MeshLambertMaterial({ map: makeTex(0xb08818, true) }),
  wall:   () => new THREE.MeshLambertMaterial({ map: makeTex(0xc8a020, false) }),
  ceil:   () => new THREE.MeshLambertMaterial({ map: makeTex(0x786010, false) }),
  // Nexus — ligeiramente diferente
  floorN: () => new THREE.MeshLambertMaterial({ map: makeTex(0xc8981a, true) }),
  wallN:  () => new THREE.MeshLambertMaterial({ map: makeTex(0xe0b828, false) }),
  // metais/madeira para objetos
  metal:  new THREE.MeshLambertMaterial({ color: 0x3a3020 }),
  wood:   new THREE.MeshLambertMaterial({ color: 0x2e2010 }),
  fabric: new THREE.MeshLambertMaterial({ color: 0x221c0c }),
  paper:  new THREE.MeshLambertMaterial({ color: 0xb8a860 }),
};

// ── CHUNK GENERATION ─────────────────────────────────────
function chunkKey(cx, cy) { return `${cx},${cy}`; }
function roomKey(rx, ry)  { return `${rx},${ry}`; }

function worldToChunk(wx, wz) {
  return [
    Math.floor(wx / (CHUNK_SIZE * ROOM_SIZE)),
    Math.floor(wz / (CHUNK_SIZE * ROOM_SIZE))
  ];
}

function buildInitialChunks(sx, sz) {
  const [cx, cz] = worldToChunk(sx, sz);
  for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++)
    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++)
      loadChunk(cx+dx, cz+dz);
}

function loadChunk(cx, cy) {
  const k = chunkKey(cx, cy);
  if (loadedChunks.has(k)) return;
  const group = new THREE.Group();
  buildChunkGeometry(cx, cy, group);
  scene.add(group);
  loadedChunks.set(k, group);
}

function unloadFarChunks(cx, cy) {
  for (const [k, group] of loadedChunks) {
    const [ocx, ocy] = k.split(',').map(Number);
    if (Math.abs(ocx-cx) > CHUNK_RADIUS+1 || Math.abs(ocy-cy) > CHUNK_RADIUS+1) {
      scene.remove(group);
      loadedChunks.delete(k);
    }
  }
}

function buildChunkGeometry(cx, cy, group) {
  const r = rng((cx * 73856093) ^ (cy * 19349663));
  const isNexusChunk = (cx === 0 && cy === 0);

  const DIRS = [[0,1],[0,-1],[1,0],[-1,0]];

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const rx = cx * CHUNK_SIZE + lx;
      const ry = cy * CHUNK_SIZE + lz;
      const wx = rx * ROOM_SIZE;
      const wz = ry * ROOM_SIZE;
      const rk = roomKey(rx, ry);
      roomWalls.add(rk);

      const isNexus = (rx === 0 && ry === 0);
      const fMat = isNexus || isNexusChunk ? MAT.floorN() : MAT.floor();
      const wMat = isNexus || isNexusChunk ? MAT.wallN()  : MAT.wall();
      const cMat = MAT.ceil();

      // floor
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), fMat);
      floor.rotation.x = -Math.PI/2; floor.position.set(wx, 0, wz);
      group.add(floor);

      // ceiling
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), cMat);
      ceil.rotation.x = Math.PI/2; ceil.position.set(wx, ROOM_H, wz);
      group.add(ceil);

      // walls — open corridors using seeded maze per chunk
      const open = DIRS.filter(() => r() > 0.38);
      // always open at least 2 sides
      const openDirs = open.length >= 2 ? open : [DIRS[0], DIRS[1]];

      DIRS.forEach(([dx, dz], i) => {
        const isOpen = openDirs.includes(DIRS[i]);
        if (!isOpen) {
          const wall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_H), wMat);
          if (dx === 0) {
            wall.position.set(wx, ROOM_H/2, wz + dz*ROOM_SIZE/2);
            wall.rotation.y = dz > 0 ? Math.PI : 0;
          } else {
            wall.position.set(wx + dx*ROOM_SIZE/2, ROOM_H/2, wz);
            wall.rotation.y = dx > 0 ? -Math.PI/2 : Math.PI/2;
          }
          group.add(wall);
        }
      });

      // light
      const brightness = isNexusChunk ? 0.8 : (0.4 + r()*0.4);
      const lt = new THREE.PointLight(0xffe060, brightness, 7);
      lt.position.set(wx, ROOM_H-.3, wz);
      group.add(lt);

      // flicker
      if (r() > 0.7) {
        const fl = new THREE.PointLight(0xffaa10, 0.2, 4);
        fl.position.set(wx+(r()-.5)*2, ROOM_H-.4, wz+(r()-.5)*2);
        fl.userData.flicker = true;
        group.add(fl);
      }

      // furniture (~55% das salas, menos no Nexus)
      if (!isNexus && r() > (isNexusChunk ? 0.3 : 0.45)) {
        addFurniture(wx, wz, r, group);
      }
    }
  }
}

// ── FURNITURE ────────────────────────────────────────────
function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
}

function addFurniture(wx, wz, r, group) {
  const type = Math.floor(r() * 6);
  const g = new THREE.Group();
  g.position.set(wx+(r()-.5)*1.2, 0, wz+(r()-.5)*1.2);
  g.rotation.y = r()*Math.PI*2;

  switch(type) {
    case 0: { // cadeira tombada
      const seat = box(.5,.06,.5,MAT.fabric); seat.position.set(0,.25,0);
      const back = box(.5,.55,.05,MAT.fabric); back.position.set(0,.58,-.22); back.rotation.x=.2;
      [[.2,-.2],[-.2,-.2],[.2,.2],[-.2,.2]].forEach(([x,z])=>{
        const l=box(.04,.28,.04,MAT.metal); l.position.set(x,.12,z); g.add(l);
      });
      if(r()>.5) g.rotation.z = Math.PI/2+(r()-.5)*.3;
      g.add(seat,back); break;
    }
    case 1: { // mesa com papéis
      const top=box(1.1,.05,.6,MAT.wood); top.position.set(0,.75,0);
      [[.5,.27],[-.5,.27],[.5,-.27],[-.5,-.27]].forEach(([x,z])=>{
        const l=box(.05,.75,.05,MAT.metal); l.position.set(x,.37,z); g.add(l);
      });
      for(let i=0;i<3;i++){
        const p=box(.22,.01,.28,MAT.paper);
        p.position.set((r()-.5)*.6,.78,(r()-.5)*.2); p.rotation.y=(r()-.5)*.5; g.add(p);
      }
      g.add(top); break;
    }
    case 2: { // armário
      const body=box(.5,1.3,.45,MAT.metal); body.position.set(0,.65,0);
      for(let i=0;i<3;i++){
        const d=box(.46,.3,.02,MAT.metal); d.position.set(0,.25+i*.35,.24); g.add(d);
      }
      if(r()>.5){const op=box(.44,.28,.35,MAT.metal);op.position.set(0,.6,.42);g.add(op);}
      g.add(body); break;
    }
    case 3: { // caixas
      const n=1+Math.floor(r()*3);
      for(let i=0;i<n;i++){
        const s=.28+r()*.18;
        const b=box(s+r()*.1,s*.8,s+r()*.1,MAT.wood);
        b.position.set((r()-.5)*.15,s*.4+i*(s*.82),(r()-.5)*.1);
        b.rotation.y=(r()-.5)*.3; g.add(b);
      }
      break;
    }
    case 4: { // luminária caída
      const tube=box(1.1,.06,.12,MAT.metal); tube.position.set(0,.04,0); tube.rotation.z=(r()-.5)*.4;
      const wire=box(.015,.5+r()*.4,.015,MAT.metal); wire.position.set(.3,.3,0);
      g.add(tube,wire); break;
    }
    case 5: { // lixeira
      const body=new THREE.Mesh(new THREE.CylinderGeometry(.14,.10,.38,8),MAT.metal);
      if(r()>.5){body.rotation.z=Math.PI/2;body.position.set(0,.14,0);}
      else body.position.set(0,.19,0);
      g.add(body); break;
    }
  }
  group.add(g);
}

// ── ECHO ORBS ────────────────────────────────────────────
const ORB_GEO  = new THREE.SphereGeometry(.07, 8, 8);
const GLOW_GEO = new THREE.SphereGeometry(.18, 8, 8);

function spawnOrb(rk) {
  if (echoOrbs[rk]) return;
  const [rx, ry] = rk.split(',').map(Number);
  const g = new THREE.Group();
  const core = new THREE.Mesh(ORB_GEO, new THREE.MeshBasicMaterial({ color: 0xffe066 }));
  const glow = new THREE.Mesh(GLOW_GEO, new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent:true, opacity:.1, depthWrite:false }));
  const lt   = new THREE.PointLight(0xffcc33, .45, 4);
  g.add(core, glow, lt);
  g.position.set(rx*ROOM_SIZE, ROOM_H*.55, ry*ROOM_SIZE);
  g.userData.phase = Math.random()*Math.PI*2;
  scene.add(g);
  echoOrbs[rk] = g;
}

function updateOrbs() {
  const t = frame * .025;
  for (const [rk, orb] of Object.entries(echoOrbs)) {
    const ph = orb.userData.phase;
    orb.position.y = ROOM_H*.55 + Math.sin(t+ph)*.1;
    orb.children[1].material.opacity = .07 + Math.sin(t*1.2+ph)*.05;
    orb.children[1].scale.setScalar(1 + Math.sin(t*.8+ph)*.12);
    orb.children[2].intensity = .35 + Math.sin(t*1.1+ph)*.15;
  }
}

// ── PLAYER LIGHTS (outros jogadores) ─────────────────────
function upsertPlayerLight(pid, px, pz, color) {
  if (pid === playerId) return;
  if (!playerLights[pid]) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(.06,8,8),
      new THREE.MeshBasicMaterial({ color })
    );
    const lt = new THREE.PointLight(color, .6, 5);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(.18,8,8),
      new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.12, depthWrite:false })
    );
    g.add(core, lt, glow);
    scene.add(g);
    playerLights[pid] = g;
  }
  const g = playerLights[pid];
  g.position.set(px, ROOM_H*.42, pz);
  g.userData.lastSeen = Date.now();
}

function removePlayerLight(pid) {
  if (playerLights[pid]) {
    scene.remove(playerLights[pid]);
    delete playerLights[pid];
  }
}

function pruneOldPlayers() {
  const now = Date.now();
  for (const pid in playerLights) {
    if (now - playerLights[pid].userData.lastSeen > 12000) removePlayerLight(pid);
  }
}

// ── SUPABASE REALTIME ─────────────────────────────────────
async function connectRealtime() {
  // carrega orbes existentes
  try {
    const res = await fetch(`${SB_URL}/rest/v1/thoughts?select=room_key&limit=500`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    const rows = await res.json();
    const keys = new Set((rows||[]).map(r => r.room_key));
    keys.forEach(k => spawnOrb(k));
  } catch (e) { console.warn('orbs load error:', e); }

  // presence realtime via supabase global (carregado no HTML)
  try {
    if (typeof supabase === 'undefined') return;
    const sb = supabase.createClient(SB_URL, SB_KEY);
    realtimeChannel = sb.channel('limn-world', {
      config: { presence: { key: playerId } }
    });

    realtimeChannel
      .on('presence', { event: 'sync' }, () => {
        const state = realtimeChannel.presenceState();
        let count = 0;
        for (const key in state) {
          const p = state[key][0];
          if (p && p.pid !== playerId) {
            count++;
            upsertPlayerLight(p.pid, p.x, p.z, p.color || 0xc8af3c);
          }
        }
        document.getElementById('hud-player-count').textContent = count;
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        leftPresences.forEach(p => removePlayerLight(p.pid));
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await realtimeChannel.track({
            pid: playerId, name: playerName,
            x: camera.position.x, z: camera.position.z,
            color: hslToHex(playerColor)
          });
        }
      });
  } catch (e) { console.warn('Realtime erro:', e); }
}

async function disconnectPlayer() {
  if (realtimeChannel) await realtimeChannel.untrack();
}

async function broadcastPosition() {
  if (!realtimeChannel) return;
  try {
    await realtimeChannel.track({
      pid: playerId, name: playerName,
      x: camera.position.x, z: camera.position.z,
      color: hslToHex(playerColor)
    });
  } catch {}
}

// ── ECHOES ────────────────────────────────────────────────
async function fetchEchoes(rk) {
  if (echoCache[rk]) return echoCache[rk];
  try {
    const url = `${SB_URL}/rest/v1/thoughts?room_key=eq.${encodeURIComponent(rk)}&select=id,distorted_text,author_name,resonances&order=created_at.desc&limit=10`;
    const res = await fetch(url, { headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}` } });
    const rows = await res.json();
    echoCache[rk] = (rows||[]).map(r=>({ id:r.id, text:r.distorted_text, author:r.author_name, resonances:r.resonances||0 }));
    return echoCache[rk];
  } catch { return []; }
}

function showEcho(echo, sticky=true) {
  currentEchoId = echo ? echo.id : null;
  const el = document.getElementById('echo-display');
  if (!echo) { el.classList.remove('visible'); return; }
  document.getElementById('echo-author').textContent = echo.author ? `[ ${echo.author} ]` : '';
  document.getElementById('echo-body').textContent   = echo.text;
  el.classList.add('visible');
}

function showEchoRaw(text, label) {
  currentEchoId = null;
  document.getElementById('echo-author').textContent = label || '';
  document.getElementById('echo-body').textContent   = text;
  document.getElementById('btn-resonate').style.display = 'none';
  document.getElementById('echo-display').classList.add('visible');
  setTimeout(() => {
    document.getElementById('btn-resonate').style.display = '';
    document.getElementById('echo-display').classList.remove('visible');
  }, 12000);
}

window.resonateEcho = async function () {
  if (!currentEchoId) return;
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/resonate_echo`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}` },
      body: JSON.stringify({ echo_id: currentEchoId })
    });
    document.getElementById('btn-resonate').textContent = 'ressoado ✓';
    document.getElementById('btn-resonate').disabled = true;
  } catch {}
};

window.leaveFragment = async function () {
  const inp = document.getElementById('thought-input');
  const val = inp.value.trim();
  if (!val || isFragmenting) return;
  isFragmenting = true;
  inp.value = '';
  const btn = document.getElementById('btn-fragment');
  btn.disabled = true; btn.textContent = '···';

  // ── SLASH COMMAND: /oraculo ──────────────────────────
  if (val.startsWith('/oraculo ') || val === '/oraculo') {
    const pergunta = val.replace('/oraculo', '').trim();
    if (!pergunta) {
      showEchoRaw('o oráculo ouve. mas você não perguntou nada.', '// oráculo');
      btn.disabled = false; btn.textContent = 'FRAGMENTAR';
      isFragmenting = false;
      return;
    }
    try {
      const res = await fetch('/api/oraculo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: pergunta, playerName })
      });
      const data = await res.json();
      showEchoRaw(data.answer || '···', '// oráculo');
    } catch {
      showEchoRaw('o oráculo não responde agora.', '// oráculo');
    }
    btn.disabled = false; btn.textContent = 'FRAGMENTAR';
    isFragmenting = false;
    return;
  }

  // ── FRAGMENTO NORMAL ─────────────────────────────────
  try {
    const res = await fetch('/api/distort', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ text:val, room:currentRoomKey, author:playerName, playerId })
    });
    const data = await res.json();
    const distorted = data.distorted || val;

    if (!echoCache[currentRoomKey]) echoCache[currentRoomKey] = [];
    const newEcho = { id: data.id, text: distorted, author: playerName, resonances: 0 };
    echoCache[currentRoomKey].unshift(newEcho);

    spawnOrb(currentRoomKey);
    showEcho(newEcho);
    lastRoomKey = '';
  } catch (e) { console.error(e); }

  btn.disabled = false; btn.textContent = 'FRAGMENTAR';
  isFragmenting = false;
};

// ── INPUT ─────────────────────────────────────────────────
function setupInput() {
  document.addEventListener('keydown', e => keys[e.code] = true);
  document.addEventListener('keyup',   e => keys[e.code] = false);

  const c = document.getElementById('c');
  c.addEventListener('click', () => { if(!pointerLocked) c.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === c;
    document.getElementById('hint').style.display = pointerLocked ? 'none' : 'block';
  });
  document.addEventListener('mousemove', e => {
    if (!pointerLocked) return;
    yaw   -= e.movementX * .0022;
    pitch  = Math.max(-1.1, Math.min(1.1, pitch - e.movementY*.0022));
    camera.rotation.y = yaw; camera.rotation.x = pitch;
  });

  let tx=0, ty=0;
  c.addEventListener('touchstart', e=>{tx=e.touches[0].clientX;ty=e.touches[0].clientY;},{passive:true});
  c.addEventListener('touchmove', e=>{
    yaw  -= (e.touches[0].clientX-tx)*.003;
    pitch = Math.max(-1.1,Math.min(1.1,pitch-(e.touches[0].clientY-ty)*.003));
    camera.rotation.y=yaw; camera.rotation.x=pitch;
    tx=e.touches[0].clientX; ty=e.touches[0].clientY;
  },{passive:true});

  const bind=(id,k)=>{
    const el=document.getElementById(id);
    el.addEventListener('touchstart',e=>{e.preventDefault();mobile[k]=1;},{passive:false});
    el.addEventListener('touchend',()=>mobile[k]=0);
  };
  bind('mb-f','f');bind('mb-b','b');bind('mb-l','l');bind('mb-r','r');
}

// ── MOVEMENT ─────────────────────────────────────────────
const _d = new THREE.Vector3(), _r = new THREE.Vector3();

function movePlayer() {
  const f = keys['KeyW']||keys['ArrowUp']   ||mobile.f;
  const b = keys['KeyS']||keys['ArrowDown'] ||mobile.b;
  const l = keys['KeyA']||keys['ArrowLeft'] ||mobile.l;
  const r = keys['KeyD']||keys['ArrowRight']||mobile.r;
  if (!f&&!b&&!l&&!r) return false;

  camera.getWorldDirection(_d); _d.y=0; _d.normalize();
  _r.crossVectors(_d, new THREE.Vector3(0,1,0));

  const vel = new THREE.Vector3();
  if(f) vel.addScaledVector(_d, MOVE_SPEED);
  if(b) vel.addScaledVector(_d,-MOVE_SPEED);
  if(l) vel.addScaledVector(_r,-MOVE_SPEED);
  if(r) vel.addScaledVector(_r, MOVE_SPEED);

  const np = camera.position.clone().add(vel);
  const rx = Math.round(np.x / ROOM_SIZE);
  const rz = Math.round(np.z / ROOM_SIZE);

  // só move se a sala destino existe (foi gerada)
  if (roomWalls.has(`${rx},${rz}`)) {
    camera.position.copy(np);
    camera.position.y = ROOM_H * .42;
  }
  return true;
}

// ── HUD UPDATE ────────────────────────────────────────────
function getRoomKey() {
  const rx = Math.round(camera.position.x / ROOM_SIZE);
  const rz = Math.round(camera.position.z / ROOM_SIZE);
  return `${rx},${rz}`;
}

function updateHUD() {
  const rk = getRoomKey();
  const [rx, rz] = rk.split(',').map(Number);
  const isNexus = rx===0 && rz===0;
  document.getElementById('hud-location').textContent = isNexus ? 'LIMN · NEXUS' : 'LIMN';
  document.getElementById('hud-coords').textContent   = `${rx} · ${rz}`;

  const a = ((-yaw%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
  const dirs = ['N','NE','L','SE','S','SO','O','NO'];
  document.getElementById('hud-compass').textContent = dirs[Math.round(a/(Math.PI/4))%8];
}

// ── MAIN LOOP ─────────────────────────────────────────────
let posTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  frame++;

  const moved = movePlayer();
  updateOrbs();

  // flicker lights
  if (frame % 4 === 0) {
    scene.children.forEach(obj => {
      if (obj.isGroup) obj.traverse(c => {
        if (c.isPointLight && c.userData.flicker)
          c.intensity = .05 + Math.random()*.3;
      });
    });
  }

  // chunk management - menos frequente pra não travar
  if (frame % 120 === 0) {
    const [cx,cz] = worldToChunk(camera.position.x, camera.position.z);
    for (let dx=-CHUNK_RADIUS;dx<=CHUNK_RADIUS;dx++)
      for (let dz=-CHUNK_RADIUS;dz<=CHUNK_RADIUS;dz++)
        loadChunk(cx+dx, cz+dz);
    unloadFarChunks(cx, cz);
    pruneOldPlayers();
  }

  // echo on room change
  if (frame % 20 === 0) {
    const rk = getRoomKey();
    currentRoomKey = rk;
    if (rk !== lastRoomKey) {
      lastRoomKey = rk;
      fetchEchoes(rk).then(echoes => {
        if (echoes.length > 0) {
          showEcho(echoes[Math.floor(Math.random()*echoes.length)]);
          document.getElementById('btn-resonate').textContent = 'ressoar';
          document.getElementById('btn-resonate').disabled = false;
        } else {
          showEcho(null);
        }
      });
    }
  }

  // broadcast position
  if (frame % 30 === 0 && moved) broadcastPosition();

  if (frame % 10 === 0) updateHUD();

  renderer.render(scene, camera);
}
