/* ============================================================
 * zsync.js v1 — 丧尸同步桥（地图页 ↔ P2P 层）
 *
 * 房主：每 100ms 序列化 window.__zombies → P2P.hostZombies 自动广播
 * 客户端：接收快照 → 对齐丧尸数量 → 位置插值 → 命中上报
 *
 * 地图页约定（仅需 3 行钩子，见文末说明）：
 *   1. 创建丧尸时: zombie.userData.isZombie = true;
 *                  (window.__zombies = window.__zombies || []).push(zombie);
 *   2. 移除丧尸时: const i = window.__zombies.indexOf(zombie);
 *                  if (i >= 0) window.__zombies.splice(i, 1);
 *   3. 本地 HP 变化: if (window.MP) MP.setHP(当前HP);
 *   4. 客户端跳过本地刷怪: if (window.ZS && !ZS.isHost()) return;
 * ============================================================ */
window.ZS = (() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const MODE = q.get('mp');   // host | client | null
  const active = !!(MODE && window.P2P);

  /* ---------- 房主：注册序列化器 ---------- */
  function initHost(){
    if (!active || MODE !== 'host') return;
    const waitZombies = () => {
      if (P2P.inGame() && window.__zombies){
        P2P.hostZombies(() => ({
          list: window.__zombies
            .filter(z => z && z.parent)          // 仍在场景中
            .map((z, i) => ({
              i,
              x: +z.position.x.toFixed(1),
              y: +z.position.y.toFixed(1),
              z: +z.position.z.toFixed(1),
              ry: +(z.rotation.y || 0).toFixed(2),
              hp: z.userData.hp != null ? z.userData.hp : 100
            }))
        }));
        P2P.hostGameState(() => ({
          w: window.__wave  != null ? window.__wave  : 1,
          k: window.__kills != null ? window.__kills : 0
        }));
      } else setTimeout(waitZombies, 200);
    };
    waitZombies();
  }

  /* ---------- 房主：接收客户端命中上报，结算后写回 userData.hp ---------- */
  window.__hitZombie = (d) => {
    if (MODE !== 'host' || !d || !window.__zombies) return;
    const z = window.__zombies[d.i];
    if (!z || !z.parent) return;              // 已死亡/已移除
    z.userData.hp = (z.userData.hp != null ? z.userData.hp : 100) - (d.dmg || 0);
    if (z.userData.hp <= 0){
      /* 交给地图页自己的死亡动画；快照下一帧会带 hp<=0，客户端据此移除 */
      z.userData.hp = 0;
      if (typeof window.__onZombieKilled === 'function') try { window.__onZombieKilled(z); } catch (_) {}
    }
  };

  /* ---------- 客户端：接收快照，重建 + 插值 ---------- */
  let localSpawningOff = false;
  window.__zombieSync = (snap) => {
    if (MODE !== 'client' || !snap || !snap.list) return;
    if (!window.__zombies) window.__zombies = [];

    /* 首次收到快照 → 关闭本地刷怪 */
    if (!localSpawningOff){
      localSpawningOff = true;
      if (typeof window.__stopSpawning === 'function') try { window.__stopSpawning(); } catch (_) {}
    }

    const list = snap.list;
    const zarr = window.__zombies;

    /* 数量对齐：多余 → 移除；不足 → 由地图页 __zombieSpawn 补 */
    for (let i = zarr.length - 1; i >= list.length; i--){
      const z = zarr[i];
      if (z && z.parent) z.parent.remove(z);
      zarr.splice(i, 1);
    }
    while (zarr.length < list.length){
      if (typeof window.__zombieSpawn === 'function'){
        const s = list[zarr.length];
        const nz = window.__zombieSpawn(s);
        if (nz){ nz.userData.isZombie = true; nz.userData.hp = s.hp; zarr.push(nz); }
        else break;
      } else break;
    }

    /* 应用状态（目标位置，rAF 循环里插值过去） */
    list.forEach((s, i) => {
      const z = zarr[i];
      if (!z) return;
      z.userData.tgt = { x: s.x, y: s.y, z: s.z, ry: s.ry };
      z.userData.hp  = s.hp;
      if (s.hp <= 0 && z.parent) z.parent.remove(z);   // 房主已判死 → 客户端立即隐藏
    });
  };

  /* ---------- 客户端：全局状态（波次/击杀） ---------- */
  window.__gameSync = (s) => {
    if (MODE !== 'client' || !s) return;
    if (s.w != null && typeof window.__waveSet  === 'function') try { window.__waveSet(s.w);  } catch (_) {}
    if (s.k != null && typeof window.__killsSet === 'function') try { window.__killsSet(s.k); } catch (_) {}
  };

  /* ---------- 每帧：客户端对丧尸做位置插值 ---------- */
  function tick(){
    if (MODE === 'client' && window.__zombies){
      for (const z of window.__zombies){
        const t = z.userData && z.userData.tgt;
        if (!t) continue;
        z.position.x += (t.x - z.position.x) * 0.25;
        z.position.y += (t.y - z.position.y) * 0.25;
        z.position.z += (t.z - z.position.z) * 0.25;
        let d = (t.ry || 0) - (z.rotation.y || 0);
        while (d >  Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        z.rotation.y += d * 0.3;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  initHost();

  return {
    isHost:  () => MODE === 'host',
    isClient:() => MODE === 'client',
    active:  () => active
  };
})();
