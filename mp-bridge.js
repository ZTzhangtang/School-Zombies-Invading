/* ============================================================
 * mp-bridge.js v2 — 地图页联机桥（零侵入版）
 * 自动钩住 renderer.render 抓取 scene/camera，自带 rAF 心跳
 * 地图页只需在 </body> 前引入 3 个 <script>，无需改任何游戏代码
 * ============================================================ */
window.MP = (() => {
  'use strict';
  const q    = new URLSearchParams(location.search);
  const MODE = q.get('mp');                            // host | client | null
  const CODE = (q.get('room') || '').toUpperCase();
  const NAME = (q.get('name') || '玩家').slice(0, 8);

  const state = { active:false, mode:MODE || null, code:CODE, name:NAME, players:0 };
  let scene = null, camera = null;                     // 由钩子自动捕获
  const avatars = new Map();                           // id → {group, tgt, scene}
  const tracers = [];
  const COLORS = [0x4d96ff,0x16c79a,0xffd166,0xc77dff,0xff8c42,0x4dd0e1];
  let hp = 100;

  /* ---------- 右上角联机徽标 ---------- */
  function badge(txt){
    let el = document.getElementById('mp-badge');
    if (!el){
      el = document.createElement('div'); el.id = 'mp-badge';
      el.style.cssText = 'position:fixed;top:10px;right:12px;z-index:99990;font:600 12px system-ui;' +
        'padding:6px 12px;border-radius:20px;background:rgba(10,14,20,.72);color:#9fe8c1;' +
        'border:1px solid rgba(46,194,126,.4);pointer-events:none;backdrop-filter:blur(4px)';
      document.body.appendChild(el);
    }
    el.textContent = txt;
  }
  function updateBadge(){
    if (!state.active) return;
    badge((state.mode === 'host' ? '🌐 联机 · 房主' : '🌐 联机 · 玩家') +
          ' · ' + state.code + ' · ' + (state.players + 1) + ' 人');
  }

  /* ---------- 核心：钩住 WebGLRenderer.render 自动抓 scene/camera ---------- */
  function hookRenderer(){
    if (!window.THREE || !THREE.WebGLRenderer){ setTimeout(hookRenderer, 60); return; }
    const proto = THREE.WebGLRenderer.prototype;
    if (proto.__mpHooked) return;
    proto.__mpHooked = true;
    const orig = proto.render;
    proto.render = function(s, c){
      if (s && c){ scene = s; camera = c; }            // 每帧刷新（重建场景也能跟上）
      return orig.call(this, s, c);
    };
  }

  /* ---------- 队友模型 ---------- */
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y);
    c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
    c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function tagSprite(text){
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,.55)'; roundRect(c, 4, 6, 248, 52, 14); c.fill();
    c.fillStyle = '#9fe8c1'; c.font = 'bold 30px system-ui'; c.textAlign = 'center';
    c.fillText(text, 128, 44);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.set(1.7, 0.42, 1); sp.renderOrder = 999; return sp;
  }
  function hash(s){ let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }
  function buildAvatar(name, color){
    const g = new THREE.Group();
    const bodyGeo = (typeof THREE.CapsuleGeometry === 'function')
      ? new THREE.CapsuleGeometry(0.34, 0.95, 4, 10)
      : new THREE.CylinderGeometry(0.34, 0.34, 1.3, 10);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xe8c9a8 })); head.position.y = 1.72;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.72),
      new THREE.MeshLambertMaterial({ color: 0x15181d })); gun.position.set(0.26, 1.4, -0.34);
    const tag = tagSprite(name); tag.position.y = 2.15;
    g.add(body, head, gun, tag);
    return g;
  }

  /* ---------- 同步 ---------- */
  function syncAvatars(){
    if (!scene) return;
    const seen = new Set();
    P2P.eachRemote(s => {
      seen.add(s.id);
      let a = avatars.get(s.id);
      if (!a || a.scene !== scene){                    // 场景被重建 → 重新加入
        if (a) scene.remove(a.group);
        const col = COLORS[Math.abs(hash(s.id)) % COLORS.length];
        const g = buildAvatar(s.name || ('玩家' + s.id.slice(-2)), col);
        scene.add(g);
        a = { group: g, scene, tgt: { x:s.x, y:s.y, z:s.z, ry:s.ry || 0 } };
        avatars.set(s.id, a);
      }
      a.tgt = { x:s.x, y:s.y, z:s.z, ry:s.ry || 0 };
      a.group.visible = !(s.hp != null && s.hp <= 0);
    });
    avatars.forEach((a, id) => {
      if (!seen.has(id) || a.scene !== scene){ if(a.scene===scene) scene.remove(a.group); avatars.delete(id); }
    });
    state.players = avatars.size;
    updateBadge();
  }
  function animateAvatars(){
    avatars.forEach(a => {
      const g = a.group;
      g.position.x += (a.tgt.x - g.position.x) * 0.25;
      g.position.y += (Math.max(0, (a.tgt.y || 1.6) - 1.58) - g.position.y) * 0.25;
      g.position.z += (a.tgt.z - g.position.z) * 0.25;
      let d = a.tgt.ry - g.rotation.y;
      while (d >  Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      g.rotation.y += d * 0.3;
    });
  }
  function spawnTracer(x, y, z, ry){
    if (!scene) return;
    const dir = new THREE.Vector3(-Math.sin(ry), 0, -Math.cos(ry)).multiplyScalar(28);
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, y - 0.12, z),
      new THREE.Vector3(x + dir.x, y - 0.12, z + dir.z)]);
    const line = new THREE.Line(geo,
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 }));
    scene.add(line); tracers.push({ line, life: 1, scene });
  }

  /* ---------- 自带心跳（无需地图改循环） ---------- */
  function heartbeat(){
    if (state.active){
      if (camera){
        const p = camera.position, e = camera.rotation;
        P2P.setLocal({ x:+p.x.toFixed(2), y:+p.y.toFixed(2), z:+p.z.toFixed(2),
                       ry:+e.y.toFixed(2), hp, name: state.name });
      }
      syncAvatars();
      animateAvatars();
      for (let i = tracers.length - 1; i >= 0; i--){
        const t = tracers[i]; t.life -= 0.08; t.line.material.opacity = t.life;
        if (t.life <= 0){ if(t.line.parent) t.line.parent.remove(t.line); tracers.splice(i, 1); }
      }
    }
    requestAnimationFrame(heartbeat);
  }

  /* ---------- 启动 ---------- */
  async function boot(){
    hookRenderer();
    requestAnimationFrame(heartbeat);
    if (!MODE || !CODE) return;                        // 无参数 = 纯单机，不打扰
    badge(MODE === 'host' ? '联机 · 房主建立对局中…' : '联机 · 连接房间 ' + CODE + '…');
    try {
      await P2P.enterGame({ code: CODE, isHost: MODE === 'host', name: NAME });
      state.active = true;
    } catch (e){
      badge('❌ 联机失败: ' + (e.type || e.message || e));
      return;
    }
    P2P.on('shot', d => { if (d && d.s) spawnTracer(d.s.x, d.s.y || 1.6, d.s.z, d.s.ry || 0); });
    P2P.on('host-lost', () => badge('⚠ 与房主断线'));
    updateBadge();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    tick: (cam, scn) => { if (cam) camera = cam; if (scn) scene = scn; }, // 手动接线仍兼容（可选）
    setHP: v => { hp = v; },
    state
  };
})();
