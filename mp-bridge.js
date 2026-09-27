/* ============================================================
 * mp-bridge.js v5 — 地图页联机桥
 *
 * 相对 v4 的改动：
 *   1. HP 改为【地图页直接上报真实值】（MP.setHP），不再靠轮询 DOM 血条猜测
 *   2. 新增队伍存活显示：队友阵亡变灰，徽标显示"存活 N/M"
 *   3. 新增【自由飞行观战】：本地阵亡后仍可移动/转视角，但不能开火
 *   4. 新增全员阵亡 / 重开的 UI 钩子（结算面板 + 重开）
 *   5. 队友头像用 playerId 稳定映射，避免 hash(undefined)
 *
 * 引入顺序：three.js → keys.js → settings.js → peerjs → p2p.js → mp-bridge.js → zsync.js
 * ============================================================ */
window.MP = (() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const MODE = q.get('mp');                       // host | client | null
  const CODE = (q.get('room') || '').toUpperCase();
  const NAME = (q.get('name') || '玩家').slice(0, 8);
  const ACTIVE = !!(MODE && window.P2P);
  const state = { active: false, mode: MODE || null, code: CODE, name: NAME, players: 0, alive: 1, total: 1 };

  let scene = null, camera = null;
  const avatars = new Map();   // id → {group, tgt, scene, hpBar, alive}
  const tracers = [];
  const COLORS = [0x4d96ff, 0x16c79a, 0xffd166, 0xc77dff, 0xff8c42, 0x4dd0e1];
  let hp = 100;
  let hooked = false;
  let spectating = false;                         // 本地是否处于观战（自己已阵亡）
  let hud = null;                                 // 地图页可选注入的 UI 句柄

  /* ---------- 右上角联机徽标 ---------- */
  function badge(txt, warn) {
    let el = document.getElementById('mp-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-badge';
      el.style.cssText = 'position:fixed;top:10px;right:12px;z-index:99990;font:600 12px system-ui;'
        + 'padding:6px 12px;border-radius:20px;background:rgba(10,14,20,.72);color:#9fe8c1;'
        + 'border:1px solid rgba(46,194,126,.4);pointer-events:none;backdrop-filter:blur(4px)';
      document.body.appendChild(el);
    }
    el.textContent = txt;
    el.style.color = warn ? '#ffc27a' : '#9fe8c1';
    el.style.borderColor = warn ? 'rgba(255,194,122,.5)' : 'rgba(46,194,126,.4)';
  }
  function updateBadge() {
    if (!state.active) return;
    const role = state.mode === 'host' ? '房主' : '玩家';
    let txt = '🌐 联机 · ' + role + ' · ' + state.code + ' · ' + (state.players + 1) + ' 人';
    txt += ' · 存活 ' + state.alive + '/' + state.total;
    if (spectating) txt += ' · 观战中';
    badge(txt, spectating);
  }

  /* ---------- 捕获 scene / camera ---------- */
  const renderers = new Set();
  function takeEarly() {
    const arr = window.__mpEarlyRenderers;
    if (Array.isArray(arr)) { arr.forEach(attachRenderer); window.__mpEarlyRenderers = null; }
  }
  function attachRenderer(r) {
    if (!r || r.__mpAttached || typeof r.render !== 'function') return;
    r.__mpAttached = true;
    const orig = r.render;
    r.render = function (s, c) { if (s && c) { scene = s; camera = c; } return orig.apply(this, arguments); };
    renderers.add(r);
  }
  function hookRenderer() {
    if (hooked) return;
    if (!window.THREE || !THREE.WebGLRenderer) { setTimeout(hookRenderer, 60); return; }
    const W = THREE.WebGLRenderer;
    if (!W.__mpCtorWrapped) {
      W.__mpCtorWrapped = true;
      if (typeof W === 'function' && W.prototype && !W.prototype.__mpCtorPatched) {
        W.prototype.__mpCtorPatched = true;
        const RealCtor = W;
        const ProxyCtor = function () {
          const inst = new (Function.prototype.bind.apply(RealCtor, [null].concat([].slice.call(arguments))));
          attachRenderer(inst);
          return inst;
        };
        ProxyCtor.prototype = RealCtor.prototype;
        Object.setPrototypeOf(ProxyCtor, RealCtor);
        for (const k of Object.getOwnPropertyNames(RealCtor)) {
          if (['prototype', 'name', 'length', 'arguments', 'caller'].includes(k)) continue;
          try { ProxyCtor[k] = RealCtor[k]; } catch (_) {}
        }
        THREE.WebGLRenderer = ProxyCtor;
      }
    }
    takeEarly();
    hooked = true;
  }

  /* ---------- 工具 ---------- */
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);         c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function tagSprite(text) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,.55)'; roundRect(c, 4, 6, 248, 52, 14); c.fill();
    c.fillStyle = '#9fe8c1'; c.font = 'bold 30px system-ui'; c.textAlign = 'center';
    c.fillText(String(text == null ? '玩家' : text), 128, 44);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true
    }));
    sp.scale.set(1.7, 0.42, 1); sp.renderOrder = 999;
    return sp;
  }
  function hpBarSprite() {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 16;
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(1.2, 0.15, 1); sp.renderOrder = 998;
    sp.userData = { cv, tex };
    return sp;
  }
  function drawHpBar(sp, ratio, alive) {
    const { cv, tex } = sp.userData;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = 'rgba(0,0,0,.65)'; c.fillRect(0, 0, 128, 16);
    if (!alive) { c.fillStyle = '#5a6470'; c.fillRect(2, 2, 124, 12); }
    else {
      const col = ratio > .5 ? '#2ec27e' : ratio > .25 ? '#ffd166' : '#d62828';
      c.fillStyle = col; c.fillRect(2, 2, 124 * Math.max(0, Math.min(1, ratio)), 12);
    }
    tex.needsUpdate = true;
  }
  function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }
  function displayName(name, id) {
    if (name) return name;
    const tail = (id == null ? '' : String(id)).slice(-2);
    return tail ? ('玩家' + tail) : '玩家';
  }
  function markAvatar(g) {
    g.userData.__mpAvatar = true;
    g.traverse(o => { if (o && o.userData) o.userData.__mpAvatar = true; });
  }

  function buildAvatar(name, color) {
    const g = new THREE.Group();
    const bodyGeo = (typeof THREE.CapsuleGeometry === 'function')
      ? new THREE.CapsuleGeometry(0.34, 0.95, 4, 10)
      : new THREE.CylinderGeometry(0.34, 0.34, 1.3, 10);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 10),
                                new THREE.MeshLambertMaterial({ color: 0xe8c9a8 }));
    head.position.y = 1.72;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.72),
                               new THREE.MeshLambertMaterial({ color: 0x15181d }));
    gun.position.set(0.26, 1.4, -0.34);
    const tag = tagSprite(name); tag.position.y = 2.35;
    const hpBar = hpBarSprite(); hpBar.position.y = 2.08;
    g.add(body, head, gun, tag, hpBar);
    g.userData.hpBar = hpBar;
    markAvatar(g);
    return g;
  }

  /* ---------- 队友同步（含存活/血条） ---------- */
  function syncAvatars() {
    if (!scene || !window.P2P || typeof P2P.eachRemote !== 'function') return;
    const seen = new Set();
    P2P.eachRemote((s, id) => {
      if (!s) return;
      const pid = id != null ? id : s.id;
      if (pid == null) return;
      seen.add(pid);
      const isAlive = s.alive !== false && !(s.hp != null && s.hp <= 0);

      let a = avatars.get(pid);
      if (!a || a.scene !== scene) {
        if (a && a.group && a.group.parent) a.group.parent.remove(a.group);
        const col = COLORS[Math.abs(hash(pid)) % COLORS.length];
        const g = buildAvatar(displayName(s.name, pid), col);
        /* ★ 修复：s.y 现在是"脚底世界高度"，模型原点就在脚底 → 直接用它，不再减眼高 */
        const tx = +s.x || 0, ty = Math.max(0, +s.y || 0), tz = +s.z || 0;
        g.position.set(tx, ty, tz);
        if (s.ry != null) g.rotation.y = s.ry;
        scene.add(g);
        a = { group: g, scene, tgt: { x: s.x, y: s.y, z: s.z, ry: s.ry || 0 } };
        avatars.set(pid, a);
      }
      a.tgt = { x: s.x, y: s.y, z: s.z, ry: s.ry || 0 };
      a.alive = isAlive;
      a.group.visible = true;
      /* 阵亡的队友：身形置灰、血条清空 */
      const bar = a.group.userData.hpBar;
      if (bar) { drawHpBar(bar, isAlive ? (s.hp / 100) : 0, isAlive); bar.visible = true; }
      a.group.traverse(o => {
        if (o.isMesh && o.material && o.material.color && !o.userData.__origCol) {
          o.userData.__origCol = o.material.color.getHex();
        }
        if (o.isMesh && o.material && o.material.color) {
          const orig = o.userData.__origCol;
          if (!isAlive) o.material.color.setHex(0x555b66);
          else if (orig != null) o.material.color.setHex(orig);
        }
      });
    });
    avatars.forEach((a, id) => {
      if (!seen.has(id) || a.scene !== scene) {
        if (a.group && a.group.parent) a.group.parent.remove(a.group);
        avatars.delete(id);
      }
    });
    state.players = avatars.size;
    updateBadge();
  }

  function animateAvatars() {
    avatars.forEach(a => {
      const g = a.group;
      if (!g || !a.tgt) return;
      /* ★ 修复 v6：系数 0.25 → 0.4，且 y 不再减眼高（s.y 已是脚底高度） */
      g.position.x += (a.tgt.x - g.position.x) * 0.4;
      g.position.y += (Math.max(0, a.tgt.y || 0) - g.position.y) * 0.4;
      g.position.z += (a.tgt.z - g.position.z) * 0.4;
      let d = (a.tgt.ry || 0) - g.rotation.y;
      while (d >  Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      g.rotation.y += d * 0.4;
    });
  }

  function spawnTracer(x, y, z, ry) {
    if (!scene) return;
    const dir = new THREE.Vector3(-Math.sin(ry), 0, -Math.cos(ry)).multiplyScalar(28);
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, y - 0.12, z),
      new THREE.Vector3(x + dir.x, y - 0.12, z + dir.z)
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.9
    }));
    scene.add(line);
    tracers.push({ line, life: 1, scene });
  }

  /* ---------- 队伍存活统计 ---------- */
  function refreshTeamRoster() {
    if (!window.P2P) return;
    try {
      const r = P2P.roster ? P2P.roster() : null;
      if (r && r.length) {
        state.total = r.length;
        state.alive = r.filter(p => p.alive !== false).length;
      } else {
        state.total = P2P.totalCount ? P2P.totalCount() : 1;
        state.alive = P2P.aliveCount ? P2P.aliveCount() : 1;
      }
    } catch (_) {}
    updateBadge();
  }

  /* ---------- 观战：自由飞行 ---------- */
  /* 本地阵亡后不冻结相机。地图页只需在 updatePlayer 里判断 MP.spectating()，
     跳过碰撞/受击/开火即可；这里仅维护标志与提示。 */
  function enterSpectate() {
    if (spectating) return;
    spectating = true;
    state.active && updateBadge();
    showSpectateHint();
    if (hud && typeof hud.onSpectate === 'function') { try { hud.onSpectate(); } catch (_) {} }
  }
  function exitSpectate() {
    if (!spectating) return;
    spectating = false;
    hideSpectateHint();
    updateBadge();
    if (hud && typeof hud.onRespawn === 'function') { try { hud.onRespawn(); } catch (_) {} }
  }

  function showSpectateHint() {
    let el = document.getElementById('mp-spectate');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-spectate';
      el.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:99991;'
        + 'font:700 15px system-ui;padding:10px 22px;border-radius:999px;'
        + 'background:rgba(20,10,10,.82);color:#ffb3b3;border:1px solid rgba(255,90,90,.45);'
        + 'pointer-events:none;letter-spacing:1px';
      document.body.appendChild(el);
    }
    el.textContent = '观战中 · 等待队友 · 剩余 ' + Math.max(0, state.alive - 0) + ' 人存活';
    el.style.display = '';
  }
  function hideSpectateHint() {
    const el = document.getElementById('mp-spectate');
    if (el) el.style.display = 'none';
  }
  function updateSpectateHint() {
    const el = document.getElementById('mp-spectate');
    if (el && spectating) el.textContent = '观战中 · 剩余 ' + state.alive + ' 人存活 · 全员阵亡后重开';
  }

  /* ---------- 心跳 ---------- */
  /* ★ 关键修复 v6：原来读的是 camera.position / camera.rotation。
     但 map1 的相机是 camRig → camPitch → camera 三层结构：
       · 玩家世界坐标在 camRig.position
       · 视角 yaw 在 camRig.rotation.y
     而 camera 自身的 position 恒为 (0,0,0)、rotation.y 恒为 0，
     所以每个玩家广播出去的都是固定坐标 → 对方模型钉死不动。
     改用 getWorldPosition / 从世界矩阵提取朝向，才能拿到真实位姿。 */
  const _wp = (typeof THREE !== 'undefined' && THREE.Vector3) ? new THREE.Vector3() : null;
  const _fwd = (typeof THREE !== 'undefined' && THREE.Vector3) ? new THREE.Vector3() : null;

  function readLocalPose() {
    if (!camera) return null;
    /* 世界坐标：优先用相机的世界位置（自动兼容 camRig 结构） */
    let x = 0, y = 0, z = 0;
    try {
      if (_wp) {
        camera.getWorldPosition(_wp);
        x = _wp.x; y = _wp.y; z = _wp.z;
      } else {
        const p = camera.position; x = p.x; y = p.y; z = p.z;
      }
    } catch (_) {
      const p = camera.position; x = p.x; y = p.y; z = p.z;
    }
    /* 朝向：用相机世界前向量的水平分量反推 yaw，避免依赖某一层 rotation */
    let ry = 0;
    try {
      if (_fwd && camera.getWorldDirection) {
        camera.getWorldDirection(_fwd);
        /* three 的相机默认看向 -Z，故 yaw = atan2(-dx, -dz) */
        ry = Math.atan2(-_fwd.x, -_fwd.z);
      } else {
        ry = camera.rotation.y;
      }
    } catch (_) {
      ry = camera.rotation.y;
    }
    /* y 归一化：地图把"脚底高度"存在 camRig.position.y，
       相机世界 y = camRig.y + camPitch.y(1.62)，减去眼高还原到脚底 */
    const EYE = 1.62;
    return {
      x: +x.toFixed(2),
      y: +(y - EYE).toFixed(2),
      z: +z.toFixed(2),
      ry: +ry.toFixed(2),
      hp, alive: !spectating, name: state.name, source: 'cameraWorld'
    };
  }

  function heartbeat() {
    if (state.active) {
      try {
        const pose = readLocalPose();
        if (pose) P2P.setLocal(pose);
        syncAvatars();
        animateAvatars();
        for (let i = tracers.length - 1; i >= 0; i--) {
          const t = tracers[i];
          t.life -= 0.08;
          t.line.material.opacity = t.life;
          if (t.life <= 0) { if (t.line.parent) t.line.parent.remove(t.line); tracers.splice(i, 1); }
        }
      } catch (err) {
        if (!heartbeat.__err) { heartbeat.__err = true; console.error('[MP] heartbeat error:', err); }
      }
    }
    requestAnimationFrame(heartbeat);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    hookRenderer();
    requestAnimationFrame(heartbeat);
    if (!MODE || !CODE) return;
    if (!window.P2P) { badge('❌ 联机模块未加载', true); return; }
    badge(MODE === 'host' ? '联机 · 房主建立对局中…' : '联机 · 连接房间 ' + CODE + '…');
    try { await P2P.enterGame({ code: CODE, isHost: MODE === 'host', name: NAME }); state.active = true; }
    catch (e) { badge('❌ 联机失败: ' + (e.type || e.message || e), true); return; }

    P2P.on('shot', d => { if (d && d.s) spawnTracer(d.s.x, d.s.y || 1.6, d.s.z, d.s.ry || 0); });
    P2P.on('host-lost', () => badge('⚠ 与房主断线', true));

    /* 丧尸快照 / 全局状态 / 命中结算 → 桥接到地图页钩子 */
    P2P.on('zombies',    snap => { refreshTeamRoster(); if (window.__zombieSync) try { window.__zombieSync(snap); } catch (_) {} });
    P2P.on('game-state', s    => { if (window.__gameSync)  try { window.__gameSync(s);    } catch (_) {} });
    P2P.on('hit-zombie', d    => { if (window.__hitZombie) try { window.__hitZombie(d);    } catch (_) {} });

    /* 队伍名册（存活状态） */
    P2P.on('players', r => {
      state.total = (r && r.length) || state.total;
      state.alive = r ? r.filter(p => p.alive !== false).length : state.alive;
      updateBadge(); updateSpectateHint();
    });

    /* 本地阵亡 → 观战 */
    P2P.on('local-dead', () => { enterSpectate(); refreshTeamRoster(); });

    /* 全员阵亡 → 结算 */
    P2P.on('all-dead', () => {
      showAllDead();
      if (hud && typeof hud.onAllDead === 'function') { try { hud.onAllDead(); } catch (_) {} }
    });

    /* 统一重开 */
    P2P.on('restart', d => {
      hideAllDead();
      exitSpectate();
      if (window.__clearAllZombies) try { window.__clearAllZombies(); } catch (_) {}
      if (window.resetMatch) try { window.resetMatch(d); } catch (_) {}
      if (hud && typeof hud.onRestart === 'function') { try { hud.onRestart(d); } catch (_) {} }
      refreshTeamRoster();
    });

    refreshTeamRoster();
    updateBadge();
  }

  function showAllDead() {
    let el = document.getElementById('mp-alldead');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-alldead';
      el.style.cssText = 'position:fixed;inset:0;z-index:99995;display:flex;align-items:center;'
        + 'justify-content:center;background:rgba(8,6,8,.82);backdrop-filter:blur(3px)';
      el.innerHTML = '<div style="text-align:center;font:700 22px system-ui;color:#ff8f8f;letter-spacing:2px">'
        + '<div style="font-size:40px;margin-bottom:10px">全员阵亡</div>'
        + '<div id="mp-alldead-sub" style="font-size:14px;color:#c9b3b3;font-weight:500;margin-bottom:18px"></div>'
        + '<div style="font-size:13px;color:#8a93a3;font-weight:500">正在重新开局…</div></div>';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  }
  function hideAllDead() {
    const el = document.getElementById('mp-alldead');
    if (el) el.style.display = 'none';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    setHP: v => { hp = v; },                        // 地图页在真实 HP 变化时调用
    getHP: () => hp,
    setHud: h => { hud = h || null; },              // 地图页注入 UI 句柄
    spectating: () => spectating,
    reportDeath: () => { if (window.P2P) P2P.reportDeath(); },
    state,
    _debug: () => ({
      scene: !!scene, camera: !!camera, avatars: avatars.size, players: state.players,
      spectating, alive: state.alive, total: state.total,
      sceneRef: scene, cameraRef: camera,
      avatarList: Array.from(avatars.entries()).map(([id, a]) => ({
        id, alive: a.alive !== false,
        pos: a.group ? [a.group.position.x, a.group.position.y, a.group.position.z] : null
      }))
    })
  };
})();
