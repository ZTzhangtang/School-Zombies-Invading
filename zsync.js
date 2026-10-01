/* ============================================================
 * zsync.js v2 — 丧尸同步桥（地图页 ↔ P2P 层）
 *
 * 相对 v1 的关键修复：
 *   1. 用【稳定 id】对齐，不再用数组下标 —— 这是"数量不同步"的根因
 *   2. 快照带 type / boss / dead / sca，客户端可完整重建丧尸
 *   3. 修正 v1 的 parent 判定错误
 *      （v1 用 z.parent，但 map1 的丧尸挂在 zombieRoot 组下、组本身也挂在
 *       scene 下，导致"仍在场景中"的判断失效）
 *   4. 唯一实现：不再与 mp-hooks.js 的同名 __zombieSync 冲突
 *   5. 新增：全员阵亡重开（restart）时清空本地丧尸
 *
 * 地图页需要提供的钩子（map1/map2 已内置）：
 *   window.__zombieSpawn({id,type,boss,x,y,z,sca}) → 返回新建的 Group
 *   window.__zombieRemove(grp)                     → 立即移除一只（可选，兜底用）
 *   window.__onZombieKilled(grp)                   → 房主侧播放死亡流程
 *   window.__waveSet(w) / window.__killsSet(k)
 *   window.resetMatch()                            → 全员阵亡后统一重开
 * ============================================================ */
window.ZS = (() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const MODE = q.get('mp');                       // host | client | null
  const active = !!(MODE && window.P2P);
  const IS_CLIENT = MODE === 'client';

  /* ---------- 丧尸登记表：id → { grp, ref } ---------- */
  const byId = new Map();

  /* ★ 已死亡 id 墓碑：防止客户端在房主移除该 id 前"重建一只全新丧尸"
     → 下帧再次收到 dead:true → 二次倒地（"重复倒地死亡"根因） */
  const deadIds = new Set();

  /* 供地图页在创建/移除丧尸时登记，保证 id 稳定 */
  function register(grp, id) {
    if (!grp) return null;
    if (!grp.userData.__zid) grp.userData.__zid = id || ('z' + Math.random().toString(36).slice(2, 9));
    byId.set(grp.userData.__zid, { grp, ref: grp.userData.__zRef || null });
    return grp.userData.__zid;
  }
  function unregister(grp) {
    if (!grp || !grp.userData) return;
    const id = grp.userData.__zid;
    if (id) byId.delete(id);
  }
  function idOf(grp) { return grp && grp.userData ? grp.userData.__zid : null; }

  /* ---------- 房主：序列化器 ---------- */
  function initHost() {
    if (!active || MODE !== 'host') return;
    const waitZombies = () => {
      if (P2P.inGame() && window.__zombies) {
        P2P.hostZombies(() => ({
          list: window.__zombies
            .filter(g => g && (g.parent || byId.has(idOf(g))))   // ★ 修正：不再只看 parent
            .map(g => {
              const zid = register(g);                            // 保证 id 存在
              const u = g.userData || {};
              const p = g.position;
              return {
                id: zid,
                type: u.zType || (u.boss ? 'boss' : 'normal'),
                boss: !!u.boss,
                x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1),
                ry: +(g.rotation.y || 0).toFixed(2),
                sca: +(g.scale.x || 1).toFixed(2),
                hp: u.hp != null ? u.hp : 100,
                dead: !!(u.__zRef && u.__zRef.dead) || u.__deadSync === true
              };
            })
        }));
        P2P.hostGameState(() => ({
          w: window.__wave  != null ? window.__wave  : 1,
          k: window.__kills != null ? window.__kills : 0
        }));
      } else setTimeout(waitZombies, 200);
    };
    waitZombies();
  }

  /* ---------- 房主：接收客户端命中上报（按稳定 id 查表） ---------- */
  window.__hitZombie = (d) => {
    if (MODE !== 'host' || !d || !window.__zombies) return;
    const rec = byId.get(d.i);
    const grp = rec && rec.grp;
    const z = (grp && (grp.userData.__zRef || (rec && rec.ref))) || null;
    if (!grp || !z || z.dead) return;                  // 已死亡/已移除
    /* 优先调用地图自身的伤害函数（map1: killZombie / map2: damageZombie） */
    if (typeof window.__applyZombieDamage === 'function') {
      try { window.__applyZombieDamage(grp, d.dmg || 0); return; } catch (_) {}
    }
    z.hp -= (d.dmg || 0);
    if (z.hp <= 0) {
      if (typeof window.__onZombieKilled === 'function') {
        try { window.__onZombieKilled(grp); } catch (_) {}
      }
    }
  };

  /* ---------- 客户端：应用快照（按 id 对齐 / 增 / 删 / 重建） ---------- */
  let localSpawningOff = false;
  let lastSnapshotHtml = '';                       // 预留调试

  window.__zombieSync = (snap) => {
    if (!IS_CLIENT || !snap || !snap.list) return;
    if (!window.__zombies) window.__zombies = [];

    /* 首次收到快照 → 关闭本地刷怪（客户端只认房主权威） */
    if (!localSpawningOff) {
      localSpawningOff = true;
      if (typeof window.__stopSpawning === 'function') try { window.__stopSpawning(); } catch (_) {}
    }

    const list = snap.list;
    const seen = new Set();

    /* ① 新增 / 更新 */
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.id) continue;
      seen.add(s.id);
      /* ★ 已判死的 id：禁止重建（否则新 Group 的 __deadSync 为 false → 二次倒地） */
      if (deadIds.has(s.id)) continue;
      let rec = byId.get(s.id);

      /* 本地没有 → 按类型新建（由地图页工厂负责） */
      if (!rec || !rec.grp || !rec.grp.parent) {
        if (typeof window.__zombieSpawn === 'function') {
          const g = window.__zombieSpawn(s);
          if (g) {
            g.userData.__zid = s.id;
            g.userData.isZombie = true;
            g.userData.zType = s.type;
            g.userData.boss = !!s.boss;
            g.userData.hp = s.hp;
            rec = { grp: g, ref: g.userData.__zRef || null };
            byId.set(s.id, rec);
            if (window.__zombies.indexOf(g) < 0) window.__zombies.push(g);
          } else {
            continue;                              // 工厂失败 → 跳过本次，下帧再补
          }
        } else {
          continue;
        }
      }

      const g = rec.grp;
      /* ② 目标位姿（rAF 循环里插值过去） */
      g.userData.tgt = { x: s.x, y: s.y, z: s.z, ry: s.ry || 0 };
      g.userData.hp = s.hp;

      /* ③ 房主已判死 → 客户端立刻走死亡流程（只触发一次，写墓碑防重建） */
      if (s.dead || s.hp <= 0) {
        deadIds.add(s.id);
        if (!g.userData.__deadSync) {
          g.userData.__deadSync = true;
          if (typeof window.__onZombieKilled === 'function') {
            try { window.__onZombieKilled(g); } catch (_) {}
          } else if (g.parent) {
            g.parent.remove(g);
          }
        }
      }
    }

    /* ④ 房主没有、本地还有 → 移除 */
    for (const [id, rec] of Array.from(byId.entries())) {
      if (seen.has(id)) continue;
      const g = rec.grp;
      if (g && g.parent) g.parent.remove(g);
      byId.delete(id);
      /* ★ 房主彻底出队 → 清墓碑（同时兜底清掉残留墓碑，防内存增长） */
      deadIds.delete(id);
      const ix = window.__zombies.indexOf(g);
      if (ix >= 0) window.__zombies.splice(ix, 1);
    }
    /* 兜底：清掉已脱离场景的登记项 */
    for (const [id, rec] of Array.from(byId.entries())) {
      const g = rec.grp;
      if (!g || !g.parent) {
        byId.delete(id);
        deadIds.delete(id);
        const ix = window.__zombies.indexOf(g);
        if (ix >= 0) window.__zombies.splice(ix, 1);
      }
    }
    /* ★ 墓碑兜底清理：房主快照里若已彻底没有该 id，则一并清除（防无限增长） */
    if (deadIds.size) {
      for (const id of Array.from(deadIds)) {
        if (!seen.has(id)) deadIds.delete(id);
      }
    }
  };

  /* ---------- 客户端：全局状态（波次/击杀） ---------- */
  window.__gameSync = (s) => {
    if (!IS_CLIENT || !s) return;
    if (s.w != null && typeof window.__waveSet  === 'function') try { window.__waveSet(s.w);  } catch (_) {}
    if (s.k != null && typeof window.__killsSet === 'function') try { window.__killsSet(s.k); } catch (_) {}
  };

  /* ---------- 全员阵亡重开：清空本地丧尸 ---------- */
  window.__clearAllZombies = () => {
    for (const [, rec] of byId.entries()) {
      const g = rec.grp;
      if (g && g.parent) g.parent.remove(g);
    }
    byId.clear();
    deadIds.clear();                 // ★ 重开时清墓碑
    if (window.__zombies) window.__zombies.length = 0;
    localSpawningOff = false;
  };

  /* ---------- 每帧：客户端对丧尸做位置插值（幂等，若地图自带插值可忽略） ---------- */
  function tick() {
    if (IS_CLIENT && window.__zombies) {
      for (const g of window.__zombies) {
        const t = g && g.userData && g.userData.tgt;
        if (!t) continue;
        g.position.x += (t.x - g.position.x) * 0.25;
        g.position.y += (t.y - g.position.y) * 0.25;
        g.position.z += (t.z - g.position.z) * 0.25;
        let d = (t.ry || 0) - (g.rotation.y || 0);
        while (d >  Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        g.rotation.y += d * 0.3;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  initHost();

  return {
    isHost:  () => MODE === 'host',
    isClient:() => IS_CLIENT,
    active:  () => active,
    register, unregister, idOf, byId
  };
})();
