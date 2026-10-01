/* ============================================================
 * profile.js — 生化·校园突围 个人档案与长期留存（§7）
 *
 * 与 settings.js / keys.js / touch-ui.js 并列的「三图共用」持久化模块：
 * 每张地图 + index 主菜单都以同一份 localStorage 记录玩家的长期战绩，
 * 并据此做「永久武器解锁」（§7.2 武器升级树，区别于 §4 的局内零件经济）。
 *
 * 存储键：localStorage.zs_profile（与 zs_cfg / zs_keys / zs_ui 互不干扰）
 *   {
 *     v: 2,
 *     total: { runs, kills, headshots, bestWave, bestTime, bestStreak, victories, wKills:{} },
 *     byMap: { map1:{...}, map2:{...}, map3:{...} },
 *     wpn:   { pistol:1, melee:1, ak:1, shotgun:1, smg:1, sniper:1 }   // §7.2 武器等级 1~3
 *   }
 *
 *   注：v1 → v2 平滑升级，旧数据缺字段一律补默认（sanitize 内处理），不会清档。
 *
 * 用法：
 *   一局结束时（死亡 / 胜利 / 全员阵亡）：
 *     if (window.Profile) Profile.recordRun({ map:'map1', kills, wave, timeS, victory:false,
 *                                             headshots, bestStreak, wKills });
 *
 *   进图初始化武器解锁：
 *     const wpUnlocked = Object.assign({ pistol:true, melee:true }, Profile.unlocks());
 *
 *   主菜单档案页：
 *     Profile.all()      // 全量
 *     Profile.get('map1')// 某图桶
 *     Profile.unlocks()  // 永久解锁表（由 total 换算）
 *
 *   §7.1 新增派生指标：
 *     Profile.headshotRate()  // 爆头率 0~1（headshots / kills）
 *     Profile.favWeapon()     // 最常用武器 key（按总击杀数），无数据返回 null
 *     Profile.favWeaponName() // 最常用武器中文名，无数据返回 '—'
 *
 *   §7.2 武器等级（每把 3 级，持久化）：
 *     Profile.wpnLevel('ak')     // 1~3，缺省 1
 *     Profile.wpnLevels()        // 全表副本 { pistol:2, ak:1, ... }
 *     Profile.setWpnLevel('ak',2)// 写入（自动夹取 1~3）
 *     Profile.upgradeWpn('ak')   // 升一级，返回新等级
 * ============================================================ */
window.Profile = (function () {
  'use strict';

  const LS = 'zs_profile';
  const VER = 2;
  const MAPS = ['map1', 'map2', 'map3'];
  /* §7.2 武器等级键（与 map 内 WPN_LEVEL 保持一致） */
  const WPN_KEYS = ['pistol', 'melee', 'ak', 'shotgun', 'smg', 'sniper'];
  const WPN_LV_MAX = 3;
  const WPN_NAMES = {
    pistol: '手枪', melee: '棒球棍', ak: 'AK-47',
    shotgun: '霰弹枪', smg: 'SMG', sniper: '狙击枪'
  };

  /* 单桶计数器 */
  function mkBucket() {
    return {
      runs: 0, kills: 0, headshots: 0,
      bestWave: 0, bestTime: 0, bestStreak: 0, victories: 0,
      wKills: {}                                   // 武器 → 击杀数（§7.1 最常用武器）
    };
  }
  /* 默认武器等级表 */
  function mkWpn() {
    const w = {};
    WPN_KEYS.forEach(k => { w[k] = 1; });
    return w;
  }
  /* 默认骨架（深拷贝，避免共享引用） */
  function mkDef() {
    const d = { v: VER, total: mkBucket(), byMap: {}, wpn: mkWpn() };
    MAPS.forEach(m => { d.byMap[m] = mkBucket(); });
    return d;
  }

  let data = mkDef();

  /* 把任意来源对象「规整」为合法骨架：缺字段补默认，数值强转非负整数 */
  function sanitize(raw) {
    const def = mkDef();
    if (!raw || typeof raw !== 'object') return def;
    function normWK(w) {
      const o = {};
      if (w && typeof w === 'object') {
        Object.keys(w).forEach(k => {
          const n = Math.max(0, (w[k] | 0) || 0);
          if (n > 0) o[k] = n;
        });
      }
      return o;
    }
    function normBucket(b) {
      const o = mkBucket();
      if (b && typeof b === 'object') {
        o.runs       = Math.max(0, (b.runs       | 0) || 0);
        o.kills      = Math.max(0, (b.kills      | 0) || 0);
        o.headshots  = Math.max(0, (b.headshots  | 0) || 0);
        o.bestWave   = Math.max(0, (b.bestWave   | 0) || 0);
        o.bestTime   = Math.max(0, (+b.bestTime  || 0));
        o.bestStreak = Math.max(0, (b.bestStreak | 0) || 0);
        o.victories  = Math.max(0, (b.victories  | 0) || 0);
        o.wKills     = normWK(b.wKills);
        /* 爆头数不可能多过击杀数，兜底校正（容忍旧数据/异常输入） */
        if (o.headshots > o.kills) o.headshots = o.kills;
      }
      return o;
    }
    def.total = normBucket(raw.total);
    MAPS.forEach(m => { def.byMap[m] = normBucket(raw.byMap && raw.byMap[m]); });
    /* v2 武器等级表：缺键补 1，越界夹取 */
    const w = mkWpn();
    if (raw.wpn && typeof raw.wpn === 'object') {
      WPN_KEYS.forEach(k => {
        const lv = (raw.wpn[k] | 0) || 1;
        w[k] = Math.min(WPN_LV_MAX, Math.max(1, lv));
      });
    }
    def.wpn = w;
    def.v = (raw.v | 0) || VER;
    return def;
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS) || 'null');
      data = sanitize(raw);
    } catch (_) {
      data = mkDef();                       // 解析失败 → 回到默认，不抛错
    }
    return data;
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify(data)); } catch (_) {}
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 写入一局战绩 ---------- */
  /* opt: { map, kills, wave, timeS, victory, headshots, bestStreak, wKills } */
  function recordRun(opt) {
    opt = opt || {};
    let map = opt.map;
    if (MAPS.indexOf(map) < 0) map = 'map1';           // 容错
    const kills = Math.max(0, (opt.kills | 0) || 0);
    const wave  = Math.max(0, (opt.wave  | 0) || 0);
    const timeS = Math.max(0, (+opt.timeS || 0));
    const win   = !!opt.victory;
    /* §7.1 新增：本局爆头数 / 最高连杀 / 武器击杀计数 */
    const heads = Math.min(kills, Math.max(0, (opt.headshots | 0) || 0));
    const streak= Math.max(0, (opt.bestStreak | 0) || 0);
    const wk    = (opt.wKills && typeof opt.wKills === 'object') ? opt.wKills : null;

    /* 未加载过（如首页直接调用）→ 先 load */
    apply(data.total, kills, heads, streak, wave, timeS, win, wk);
    apply(data.byMap[map], kills, heads, streak, wave, timeS, win, wk);
    save();
    return clone(data);
  }
  function apply(b, kills, heads, streak, wave, timeS, win, wk) {
    b.runs += 1;
    b.kills += kills;
    b.headshots += heads;
    if (streak > b.bestStreak) b.bestStreak = streak;
    if (wave  > b.bestWave) b.bestWave = wave;
    if (timeS > b.bestTime) b.bestTime = timeS;
    if (win) b.victories += 1;
    if (wk) {
      if (!b.wKills || typeof b.wKills !== 'object') b.wKills = {};
      Object.keys(wk).forEach(k => {
        const n = Math.max(0, (wk[k] | 0) || 0);
        if (n > 0) b.wKills[k] = (b.wKills[k] | 0) + n;
      });
    }
    if (b.headshots > b.kills) b.headshots = b.kills;
  }

  /* ---------- 读取 ---------- */
  function get(map) {
    if (MAPS.indexOf(map) < 0) map = 'map1';
    return clone(data.byMap[map]);
  }
  function all() { return clone(data); }
  function total() { return clone(data.total); }

  function reset() { data = mkDef(); save(); return clone(data); }

  /* ---------- §7.2 武器升级树：由累计战绩换算「永久解锁」（纯函数） ---------- */
  /* s: total 桶 { runs, kills, bestWave, bestTime, victories } */
  function computeUnlocks(s) {
    s = s || {};
    const kills = (s.kills | 0) || 0;
    const best  = (s.bestWave | 0) || 0;
    return {
      pistol:  true,
      melee:   true,
      ak:      kills >= 50,                       // 累计击杀 50
      shotgun: best  >= 5,                        // 最高抵达第 5 波
      smg:     kills >= 200 && best >= 8,         // 击杀 200 且抵达第 8 波
      sniper:  best  >= 12,                       // 最高抵达第 12 波
    };
  }
  /* 当前档案对应的解锁表 */
  function unlocks() { return computeUnlocks(data.total); }

  /* ---------- §7.1 派生指标 ---------- */
  /* 爆头率：0~1（无击杀时返回 0） */
  function headshotRate(map) {
    const b = map && MAPS.indexOf(map) >= 0 ? data.byMap[map] : data.total;
    const k = (b.kills | 0) || 0;
    if (k <= 0) return 0;
    return Math.min(1, ((b.headshots | 0) || 0) / k);
  }
  /* 最常用武器：按累计击杀数取最大者；无数据返回 null */
  function favWeapon(map) {
    const b = map && MAPS.indexOf(map) >= 0 ? data.byMap[map] : data.total;
    const wk = b.wKills || {};
    let best = null, bestN = 0;
    Object.keys(wk).forEach(k => {
      const n = (wk[k] | 0) || 0;
      if (n > bestN) { bestN = n; best = k; }
    });
    return best;
  }
  /* 最常用武器中文名（档案页直接显示） */
  function favWeaponName(map) {
    const k = favWeapon(map);
    return k ? (WPN_NAMES[k] || k) : '—';
  }

  /* ---------- §7.2 武器等级（持久化，1~3 级） ---------- */
  function clampLv(lv) {
    const n = (lv | 0) || 1;
    return Math.min(WPN_LV_MAX, Math.max(1, n));
  }
  function wpnLevel(key) {
    if (!key) return 1;
    return clampLv(data.wpn ? data.wpn[key] : 1);
  }
  function wpnLevels() {
    const o = {};
    WPN_KEYS.forEach(k => { o[k] = wpnLevel(k); });
    return o;
  }
  /* 直接设等级（1~3），写盘 */
  function setWpnLevel(key, lv) {
    if (!key) return 1;
    if (!data.wpn) data.wpn = mkWpn();
    data.wpn[key] = clampLv(lv);
    save();
    return data.wpn[key];
  }
  /* 升一级（封顶 WPN_LV_MAX），返回新等级 */
  function upgradeWpn(key) {
    if (!key) return 1;
    return setWpnLevel(key, wpnLevel(key) + 1);
  }

  /* ---------- 升级树进度（供档案页渲染） ---------- */
  /* 返回 [{ key, name, desc, cur, need, done }]，need 为阈值，cur 为进度值 */
  function tree() {
    const t = data.total;
    const kills = (t.kills | 0) || 0, best = (t.bestWave | 0) || 0;
    return [
      { key: 'pistol',  name: '手枪',   desc: '初始武器',                 cur: 1,     need: 1,     done: true },
      { key: 'melee',   name: '棒球棍', desc: '初始武器',                 cur: 1,     need: 1,     done: true },
      { key: 'ak',      name: 'AK-47',  desc: '累计击杀 50',              cur: kills, need: 50,    done: kills >= 50 },
      { key: 'shotgun', name: '霰弹枪', desc: '最高抵达第 5 波',          cur: best,  need: 5,     done: best  >= 5 },
      { key: 'smg',     name: 'SMG',    desc: '击杀 200 且抵达第 8 波',   cur: Math.min(kills / 200, best / 8), need: 1, done: (kills >= 200 && best >= 8) },
      { key: 'sniper',  name: '狙击枪', desc: '最高抵达第 12 波',         cur: best,  need: 12,    done: best  >= 12 },
    ];
  }

  /* 监听跨窗口（多个标签页 / index 与地图同源不同窗）变更 */
  window.addEventListener('storage', e => {
    if (e.key === LS) load();
  });

  load();

  return {
    LS, VER, MAPS,
    recordRun, get, all, total, reset,
    computeUnlocks, unlocks, tree,
    /* §7.1 */
    headshotRate, favWeapon, favWeaponName,
    /* §7.2 */
    WPN_KEYS, WPN_LV_MAX, WPN_NAMES,
    wpnLevel, wpnLevels, setWpnLevel, upgradeWpn,
    refresh: load
  };
})();
