/* ============================================================
 * mp-hooks.js v1 — ⑤ 地图页联机钩子（自动接线版）
 *
 * 自动完成：
 *   ⓪ 房主：轮询 HUD 波次/击杀 → hostGameState（覆盖 zsync 的默认实现）
 *   ① 丧尸自动发现与注册 → window.__zombies（userData 标记 / 命名 / 绿色高个物体）
 *   ② 丧尸死亡自动出队（对象移出场景 或 快照判死）
 *   ③ 本地 HP 自动探测 → MP.setHP（队友血条数据源）
 *   ④ 客户端开火 → 屏幕中心 raycast → P2P.sendHitZombie 上报房主结算
 *   ⑤ 客户端：快照对齐（覆盖 zsync 默认实现，"重叠对齐"安全策略）
 *   ⑥ 房主：接收命中上报 → 优先调地图自身伤害函数，兜底镜像 hp
 *   ⑦ 客户端：全局状态(波次/击杀) HUD 文本对齐
 *   ⑧ 客户端补怪工厂（克隆现有丧尸，zsync 需要时调用）
 *
 * 引入顺序：three.js(地图自带) → peerjs → p2p.js → mp-bridge.js → zsync.js → mp-hooks.js
 * ============================================================ */
window.MPH = (() => {
  'use strict';
  const qs   = new URLSearchParams(location.search);
  const MODE = qs.get('mp');                       // host | client | null
  const ACTIVE = !!(MODE && window.P2P);

  /* 单机空实现，保证地图页调用不报错 */
  if (!ACTIVE){
    const noop = () => {};
    return { registerZombie: noop, reportHit: noop, setHP: noop };
  }

  /* ================= 配置 ================= */
  const CFG = {
    SCAN_MS       : 400,                            // 丧尸扫描周期
    HP_POLL_MS    : 300,                            // 本地 HP 探测周期
    BULLET_DMG    : 30,                             // raycast 命中默认伤害
    HIT_CD_MS     : 90,                             // 命中上报冷却
    NAME_RE       : /zombie|zom|僵尸/i,             // 命名识别
    DMG_FN_PROBES : ['damageZombie','hitZombie','zombieHit',
                     'onZombieHit','applyZombieDamage'] // 地图伤害函数探测名单
  };

  const zombies = (window.__zombies = window.__zombies || []);
  const ray = new THREE.Raycaster();
  const NDC = new THREE.Vector2(0, 0);
  let lastHit = 0;

  /* ---------- 场景/相机捕获（与 mp-bridge 的钩子并存，取最外层） ---------- */
  (function hookScene(){
    if (!window.THREE || !THREE.WebGLRenderer){ return setTimeout(hookScene, 80); }
    const proto = THREE.WebGLRenderer.prototype;
    if (!proto.__mphSceneHook){
      proto.__mphSceneHook = true;
      const orig = proto.render;
      proto.render = function(s, c){
        if (s) window.__mpScene = s;
        if (c) window.__mpCam  = c;
        return orig.call(this, s, c);
      };
    }
  })();

  /* ---------- 丧尸识别 ---------- */
  const greenish = o => {
    const m = o.material;
    if (!m || !m.color) return false;
    const c = m.color;
    return c.g > 0.3 && c.g > c.r * 1.1 && c.g > c.b * 1.1;
  };
  const tallCache = new WeakMap();
  const tallEnough = o => {                          // 高度 1.1~3.6 才像丧尸（滤掉草丛）
    if (tallCache.has(o)) return tallCache.get(o);
    let v = false;
    try {
      const b = new THREE.Box3().setFromObject(o);
      const h = b.max.y - b.min.y;
      v = h > 1.1 && h < 3.6;
    } catch (_) {}
    tallCache.set(o, v);
    return v;
  };
  const liteZ = o => {                               // 轻量判定（用于向上找根）
    if (!o || !o.isObject3D) return false;
    const u = o.userData || {};
    if (u.zombie || u.isZombie) return true;
    if (CFG.NAME_RE.test(o.name || '')) return true;
    return !!(o.isMesh && greenish(o));
  };
  const hasAvatarAncestor = o => {                   // 排除队友模型
    let r = o;
    while (r){
      if (r.userData && r.userData.__mpAvatar) return true;
      r = r.parent;
    }
    return false;
  };
  const rootOf = o => {                              // 向上找丧尸根节点
    let r = o;
    while (r.parent && r.parent.type !== 'Scene' && liteZ(r.parent)) r = r.parent;
    return r;
  };
  const ensureReg = root => {
    if (!root || !root.parent || zombies.includes(root)) return;
    if (!root.userData.__zid) root.userData.__zid = 'z' + Math.random().toString(36).slice(2, 8);
    if (root.userData.hp == null) root.userData.hp = 100;
    zombies.push(root);
  };

  /* ---------- ① 扫描注册 + ② 死亡自动出队 ---------- */
  function scan(){
    const scene = window.__mpScene;
    if (scene){
      scene.traverse(o => {
        if (!liteZ(o) || hasAvatarAncestor(o)) return;
        const root = rootOf(o);
        if (root && tallEnough(root)) ensureReg(root);
      });
      for (let i = zombies.length - 1; i >= 0; i--){
        const z = zombies[i];
        if (!z.parent || z.userData.__deadSync) zombies.splice(i, 1);
      }
    }
    setTimeout(scan, CFG.SCAN_MS);
  }

  /* ---------- ⓪ 房主：HUD 读取 → hostGameState（覆盖 zsync 默认） ---------- */
  function readHUD(){
    const t = document.body.innerText;
    const mw = /第\s*(\d+)\s*波/.exec(t);
    const mk = /击杀\s*(\d+)/.exec(t);
    return { w: mw ? +mw[1] : 1, k: mk ? +mk[1] : 0 };
  }
  if (MODE === 'host') P2P.hostGameState(readHUD);

  /* ---------- ③ 本地 HP 探测 → MP.setHP ---------- */
  let manualHP = null;
  window.__mpSetHP = n => { manualHP = n; };         // 地图页可手动调用（可选）
  function detectHP(){
    if (manualHP != null) return manualHP;
    let best = null;                                 // 血条填充宽度（取最小值=填充条）
    const bars = document.querySelectorAll('[id*=hp i],[class*=hp i],[id*=health i],[class*=health i]');
    for (const el of bars){
      const m = /([\d.]+)%/.exec(getComputedStyle(el).width);
      if (m){
        const v = parseFloat(m[1]);
        if (best == null || v < best) best = v;
      }
    }
    if (best != null) return best;
    const t = document.body.innerText.match(/HP\s*([0-9]+)/i);   // 兜底：文本 "HP 87"
    return t ? parseFloat(t[1]) : null;
  }
  setInterval(() => {
    const v = detectHP();
    if (v != null && window.MP && MP.setHP) MP.setHP(Math.max(0, Math.min(100, v)));
  }, CFG.HP_POLL_MS);

  /* ---------- ④ 客户端开火 → raycast 命中上报 ---------- */
  function fireRaycast(){
    if (MODE !== 'client') return;
    const cam = window.__mpCam, now = performance.now();
    if (!cam || now - lastHit < CFG.HIT_CD_MS) return;
    const pool = zombies.filter(z => z.visible && !z.userData.__deadSync);
    if (!pool.length) return;
    ray.setFromCamera(NDC, cam);
    const hits = ray.intersectObjects(pool, true);
    if (!hits.length) return;
    const idx = zombies.indexOf(rootOf(hits[0].object));
    if (idx < 0) return;
    lastHit = now;
    P2P.sendHitZombie(idx, window.__zsyncBulletDmg || CFG.BULLET_DMG);
  }
  document.addEventListener('mousedown', e => {
    if (e.button === 0 && document.pointerLockElement) fireRaycast();
  });
  document.addEventListener('keydown', e => {
    if (e.code === 'KeyF' && document.pointerLockElement) fireRaycast();
  });
  document.addEventListener('touchstart', e => {     // 触屏开火
    if (e.target && e.target.tagName === 'CANVAS') fireRaycast();
  }, { passive: true });

  /* ---------- ⑤ 客户端：快照对齐（覆盖 zsync 默认实现） ---------- */
  window.__zombieSync = snap => {
    if (MODE !== 'client' || !snap || !snap.list) return;
    const n = Math.min(snap.list.length, zombies.length);
    for (let i = 0; i < n; i++){
      const z = zombies[i], s = snap.list[i];
      if (!z) continue;
      z.userData.tgt = { x: s.x, y: s.y, z: s.z, ry: s.ry || 0 };  // zsync 的 rAF tick 会插值
      z.userData.hp  = s.hp;
      if (s.hp <= 0 && !z.userData.__deadSync){
        z.userData.__deadSync = true;
        z.visible = false;                           // 房主已判死 → 隐藏
      }
    }
  };

  /* ---------- ⑥ 房主：接收客户端命中上报 → 结算 ---------- */
  window.__hitZombie = d => {
    if (MODE !== 'host' || !d) return;
    const z = zombies[d.i];
    if (!z || !z.parent || z.userData.__deadSync) return;
    const dmg = d.dmg || 0;
    for (const fn of CFG.DMG_FN_PROBES){             // 优先调地图自身伤害函数
      if (typeof window[fn] === 'function'){
        try { window[fn](z, dmg); return; } catch (_) {}
      }
    }
    z.userData.hp = (z.userData.hp != null ? z.userData.hp : 100) - dmg;  // 兜底镜像
    if (z.userData.hp <= 0){ z.userData.__deadSync = true; z.visible = false; }
  };

  /* ---------- ⑦ 客户端：全局状态 HUD 对齐（覆盖 zsync 默认实现） ---------- */
  let waveTexts = null, killTexts = null;
  function collectHud(){
    waveTexts = []; killTexts = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()){
      const v = w.currentNode.nodeValue;
      if (/第\s*\d+\s*波/.test(v)) waveTexts.push(w.currentNode);
      else if (/击杀\s*\d+/.test(v)) killTexts.push(w.currentNode);
    }
  }
  window.__gameSync = s => {
    if (MODE !== 'client' || !s) return;
    if (waveTexts == null) collectHud();
    if (s.w != null) waveTexts.forEach(t => {
      t.nodeValue = t.nodeValue.replace(/第\s*\d+\s*波/, '第 ' + s.w + ' 波');
    });
    if (s.k != null) killTexts.forEach(t => {
      t.nodeValue = t.nodeValue.replace(/击杀\s*\d+/, '击杀 ' + s.k);
    });
  };

  /* ---------- ⑧ 客户端补怪工厂（克隆现有丧尸模板） ---------- */
  window.__zombieSpawn = s => {
    const scene = window.__mpScene;
    if (!scene) return null;
    let z;
    const tpl = zombies.find(x => x.parent);
    if (tpl) z = tpl.clone(true);
    else {                                           // 无模板时的占位丧尸
      z = new THREE.Group();
      const geo = (typeof THREE.CapsuleGeometry === 'function')
        ? new THREE.CapsuleGeometry(0.34, 0.95, 4, 10)
        : new THREE.CylinderGeometry(0.34, 0.34, 1.3, 10);
      const body = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a9e4f }));
      body.position.y = 0.95;
      z.add(body);
    }
    z.userData.zombie = true;
    z.userData.__zid  = 'z' + Math.random().toString(36).slice(2, 8);
    z.userData.hp     = s && s.hp != null ? s.hp : 100;
    z.position.set(s ? s.x : 0, s ? s.y : 0, s ? s.z : 0);
    scene.add(z);
    zombies.push(z);
    return z;
  };

  /* ---------- 启动 ---------- */
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', scan);
  else scan();

  /* ---------- 对外 API（可选精调用） ---------- */
  return {
    registerZombie: ensureReg,
    reportHit: (z, dmg) => {
      const i = zombies.indexOf(z);
      if (i >= 0 && MODE === 'client') P2P.sendHitZombie(i, dmg);
    },
    setHP: n => { manualHP = n; }
  };
})();
