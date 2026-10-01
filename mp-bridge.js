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

  /* ============================================================
   * ★ §3 联机协作：职业 / 救援 / 雷达 / 聊天
   * ============================================================ */

  /* ---------- §3.2 职业定义表（★ 对齐需求清单：3 职业 · 各 1 被动 + 1 主动） ----------
   *   被动（passive）：常驻加成，写入地图页 CLS 系数
   *   主动（active） ：按 V 释放，带 CD；实际效果由地图页 window.__classSkill 执行
   *   —— 弃用旧版的 engineer / scout（清单只有 突击兵 / 医疗兵 / 壮汉） */
  const CLASSES = {
    assault: {
      name: '突击兵', icon: '🔫', color: '#ff8c42',
      passive: '伤害 +15% · 弹药上限 +20%',
      desc: '伤害 +15% · 弹药上限 +20%',
      dmgMul: 1.15, ammoMul: 1.20, spdMul: 1, nadeBonus: 0, radarMul: 1, hpBonus: 0,
      active: { id: 'dash', name: '战术突进', cd: 25, desc: '3 秒内移速 +60%，无视丧尸拖拽，便于突围或抢占制高点' }
    },
    medic: {
      name: '医疗兵', icon: '➕', color: '#4dd0e1',
      passive: '脱战缓慢回血 3/s · 救援仅需 3 秒（他人 10 秒）',
      desc: '缓慢回血 · 救援 3 秒',
      dmgMul: 1, ammoMul: 1, spdMul: 1, nadeBonus: 0, radarMul: 1, hpBonus: 0, regen: true,
      active: { id: 'aid', name: '急救包', cd: 35, desc: '立刻回复自身 60% 生命，并治疗 6 米内队友各 40% 生命' }
    },
    brute: {
      name: '壮汉', icon: '💪', color: '#ffd166',
      passive: '最大生命 +50 · 近战伤害 ×2 · 受击伤害 −20%',
      desc: '生命 +50 · 近战强化 · 减伤',
      dmgMul: 1, ammoMul: 1, spdMul: 1, nadeBonus: 0, radarMul: 1, hpBonus: 50,
      meleeMul: 2, hurtMul: 0.8, armored: true,
      active: { id: 'roar', name: '怒吼冲撞', cd: 30, desc: '正面 5 米内丧尸被击退并受到 80 点伤害，短暂清出安全区' }
    }
  };
  let myClass = 'assault';                        // 默认突击兵
  let classPicked = false;                        // ★ 本局是否已在开局面板选定职业
  let skillCd = 0;                                // ★ 主动技能剩余冷却
  let clsApplied = null;
  const CLASS_CSS = cls => (CLASSES[cls] || CLASSES.assault);

  /* ---------- §3.1 救援状态 ---------- */
  const DOWN_TIME = 30;                           // 濒死倒计时（秒）
  const REVIVE_RANGE = 2.5;                       // 救援距离
  const REVIVE_TIME = 10;                         // ★ 救援所需时长（秒，清单：10 秒）
  const MEDIC_REVIVE_TIME = 3;                    // ★ 医疗兵专用救援时长（清单：3 秒）
  let downed = false;                             // 本地是否濒死
  let downT = 0;                                  // 本地濒死剩余
  let reviving = 0;                               // 本地救援他人进度 0~1
  let reviveTarget = null;                        // 正在救的目标 id
  let heldKey = false;                            // 是否按住交互键（F）
  let hostLost = false;                           // 房主掉线标记（禁用濒死）
  const _lastPos = { x: null, z: null };          // 上一帧位置（判定移动打断）

  /* ---------- §3.3 雷达 ---------- */
  const RADAR_R = 40;                             // ★ 雷达世界半径（米，清单：40 米）
  const RADAR_SIZE = 168;                         // 画布尺寸 px

  /* ---------- §3.4 聊天 ---------- */
  let chatOpen = false;
  const chatCool = {};                            // 快捷指令冷却
  const QUICKS = [
    { id: 'gather', txt: '📣 集合到我这里！', cool: 5 },
    { id: 'retreat', txt: '🏃 撤退！', cool: 5 },
    { id: 'help', txt: '🆘 救我！我倒了！', cool: 5 },
    { id: 'incoming', txt: '⚠ 敌人来袭！', cool: 5 }
  ];


/* ============================================================
 * ★ §3 / §4 本地 UI 工厂（单人 + 联机共用）
 *   —— 解决「单人也必须有小地图 / 商店 / 职业」这一硬需求：
 *      这些 UI 不再依赖 MODE/CODE（联机参数），进图即构建。
 * ============================================================ */

/* ---------- ★ §3.3(新增) 雷达可见性（收起 / 展开，持久化） ---------- */
const RADAR_LS = 'zs_radar';
let radarCollapsed = false;
try {
  const r = JSON.parse(localStorage.getItem(RADAR_LS) || '{}');
  radarCollapsed = !!r.collapsed;
} catch (_) {}
function saveRadarState() {
  try { localStorage.setItem(RADAR_LS, JSON.stringify({ collapsed: radarCollapsed })); } catch (_) {}
}
/* 统一入口：折叠按钮与 M 键共用 */
function setRadarCollapsed(v) {
  radarCollapsed = !!v;
  saveRadarState();
  const c = document.getElementById('mp-radar');
  if (c) c.style.display = radarCollapsed ? 'none' : '';
  const b = document.getElementById('mp-radar-toggle');
  if (b) {
    b.textContent = radarCollapsed ? '🗺' : '▸';
    b.title = radarCollapsed ? '展开小地图 (M)' : '收起小地图 (M)';
    b.style.right = radarCollapsed ? '14px' : 'calc(14px + ' + RADAR_SIZE + 'px)';
  }
}
function toggleRadar() { setRadarCollapsed(!radarCollapsed); }

/* ---------- ★ §3.3 雷达底盘 + 折叠按钮 ---------- */
function buildRadarUi() {
  getRadarCanvas();
  let b = document.getElementById('mp-radar-toggle');
  if (!b) {
    b = document.createElement('button');
    b.id = 'mp-radar-toggle';
    b.style.cssText = 'position:fixed;right:14px;top:46px;z-index:99990;cursor:pointer;'
      + 'width:30px;height:30px;border-radius:50%;border:1px solid rgba(90,200,150,.4);'
      + 'background:rgba(10,14,20,.78);color:#9fe8c1;font:700 13px system-ui;line-height:1;'
      + 'padding:0;backdrop-filter:blur(4px)';
    b.textContent = '▸';
    b.title = '收起小地图 (M)';
    b.addEventListener('click', e => { e.preventDefault(); toggleRadar(); });
    document.body.appendChild(b);
  }
  setRadarCollapsed(radarCollapsed);
}

/* ---------- ★ §3.2 职业 HUD（当前职业 + 主动技能 CD） ---------- */
function buildClassHud() {
  let el = document.getElementById('mp-class-hud');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mp-class-hud';
    el.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99990;display:none;'
      + 'align-items:center;gap:10px;font:600 12px system-ui;padding:6px 10px;border-radius:12px;'
      + 'background:rgba(10,14,20,.72);border:1px solid rgba(120,200,160,.25);pointer-events:none;'
      + 'backdrop-filter:blur(4px)';
    el.innerHTML = '<span id="mp-class-name">—</span>'
      + '<span id="mp-skill" style="display:flex;align-items:center;gap:6px;opacity:.6">'
      + '<b id="mp-skill-key" style="color:#ffd166">V</b>'
      + '<span id="mp-skill-name">主动技能</span>'
      + '<span id="mp-skill-cd" style="color:#8fd"></span></span>';
    document.body.appendChild(el);
  }
  return el;
}
function refreshClassHud() {
  const el = document.getElementById('mp-class-hud');
  if (!el) return;
  const c = CLASS_CSS(myClass);
  el.style.display = classPicked ? 'flex' : 'none';
  const nm = el.querySelector('#mp-class-name');
  if (nm) { nm.textContent = c.icon + ' ' + c.name; nm.style.color = c.color; }
  const sn = el.querySelector('#mp-skill-name');
  if (sn) sn.textContent = (c.active && c.active.name) || '主动技能';
  const box = el.querySelector('#mp-skill');
  if (box) box.style.opacity = skillCd > 0 ? '0.55' : '1';
  const cdEl = el.querySelector('#mp-skill-cd');
  if (cdEl) cdEl.textContent = skillCd > 0 ? '冷却 ' + Math.ceil(skillCd) + 's' : '就绪';
}

/* ---------- ★ §15.10 移动端顶部按钮栏（含桌面唤出） ---------- */
function topbarWanted() {
  try { if (window.matchMedia && matchMedia('(hover:none) and (pointer:coarse)').matches) return true; } catch (_) {}
  return window.innerWidth < 820;
}
function buildTopbar() {
  let el = document.getElementById('mp-topbar');
  if (el) { el.style.display = topbarWanted() || el.__forced ? 'flex' : 'none'; return el; }
  el = document.createElement('div');
  el.id = 'mp-topbar';
  el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99991;'
    + 'display:flex;gap:6px;padding:5px 7px;border-radius:16px;background:rgba(10,14,20,.78);'
    + 'border:1px solid rgba(120,200,160,.28);backdrop-filter:blur(6px)';
  const B = (id, label, title) =>
    '<button data-tb="' + id + '" title="' + title + '" style="cursor:pointer;min-width:44px;height:36px;'
    + 'border-radius:11px;border:1px solid rgba(120,200,160,.25);background:rgba(20,30,26,.7);'
    + 'color:#dff;font:700 11px system-ui;padding:0 9px;white-space:nowrap">' + label + '</button>';
  el.innerHTML = B('shop', '🛒 商店', '补给站 (B)')
    + B('radar', '🗺 地图', '小地图收起/展开 (M)')
    + B('skill', '⚡ 技能', '释放职业主动技能 (V)')
    + B('class', '👤 职业', '查看职业与技能说明')
    + '<span id="mp-tb-chat">' + B('chat', '💬 聊天', '队伍聊天 (T)') + '</span>';
  document.body.appendChild(el);
  el.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button[data-tb]');
    if (!b) return;
    const k = b.getAttribute('data-tb');
    try {
      if (k === 'shop') toggleShop();
      else if (k === 'radar') toggleRadar();
      else if (k === 'skill') useSkill();
      else if (k === 'class') showClassInfo();
      else if (k === 'chat') openChat();
    } catch (_) {}
    refreshTopbarState();
  });
  el.style.display = topbarWanted() ? 'flex' : 'none';
  return el;
}
function refreshTopbarState() {
  const el = document.getElementById('mp-topbar');
  if (!el) return;
  /* 聊天仅联机可用（列表目标硬需求） */
  const chatBox = el.querySelector('#mp-tb-chat');
  if (chatBox) chatBox.style.display = state.active ? '' : 'none';
  const skillBtn = el.querySelector('button[data-tb="skill"]');
  if (skillBtn) {
    const ready = classPicked && skillCd <= 0;
    skillBtn.style.opacity = ready ? '1' : '0.5';
    const c = CLASS_CSS(myClass);
    skillBtn.textContent = skillCd > 0 ? ('⚡ ' + Math.ceil(skillCd) + 's') : '⚡ 技能';
    skillBtn.title = '释放「' + ((c.active && c.active.name) || '技能') + '」(V)';
  }
  const classBtn = el.querySelector('button[data-tb="class"]');
  if (classBtn) classBtn.textContent = classPicked ? ('👤 ' + CLASS_CSS(myClass).name) : '👤 选择职业';
}
/* 桌面端手动唤出/隐藏顶部栏 */
function mountTopbarToggle() {
  if (document.getElementById('mp-topbar-handle')) return;
  const h = document.createElement('button');
  h.id = 'mp-topbar-handle';
  h.textContent = '☰';
  h.title = '游戏菜单（回到游戏 / 返回主菜单）';
  h.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99992;cursor:pointer;width:34px;height:34px;'
    + 'border-radius:10px;border:1px solid rgba(120,200,160,.3);background:rgba(10,14,20,.78);'
    + 'color:#9fe8c1;font:700 15px system-ui;padding:0;backdrop-filter:blur(4px)';
  h.addEventListener('click', e => {
    e.preventDefault();
    openGameMenu();
  });
  document.body.appendChild(h);
}

/* ============================================================
 * ★ 左上角三条杠 → 游戏菜单（回到游戏 / 返回主菜单）
 *   需求：点击菜单【不暂停游戏】——联机 / 单人主循环继续跑。
 *   仅做覆盖显示 + 释放鼠标锁；不改 state、不清 P2P.timer。
 * ============================================================ */
let gameMenuOpen = false;

function ensureGameMenu() {
  let el = document.getElementById('mp-game-menu');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'mp-game-menu';
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;'
    + 'background:rgba(4,8,12,.6);backdrop-filter:blur(5px)';
  el.innerHTML = ''
    + '<div style="width:min(360px,88vw);border-radius:18px;border:1px solid rgba(120,200,160,.32);'
    + 'background:linear-gradient(160deg,rgba(14,20,28,.97),rgba(10,14,20,.97));'
    + 'box-shadow:0 22px 70px rgba(0,0,0,.65);padding:22px 22px 20px;text-align:center">'
    + '  <div style="font:800 21px system-ui;color:#9fe8c1;letter-spacing:2px;margin-bottom:4px">游戏菜单</div>'
    + '  <div id="mp-game-menu-sub" style="font:500 12px system-ui;color:#8a93a3;margin-bottom:18px"></div>'
    + '  <button id="mp-menu-resume" style="cursor:pointer;display:block;width:100%;margin-bottom:10px;'
    + '    padding:13px 0;border-radius:12px;border:1px solid rgba(46,194,126,.55);background:rgba(30,70,50,.7);'
    + '    color:#eafff4;font:800 15px system-ui;letter-spacing:1px">回到游戏</button>'
    + '  <button id="mp-menu-topbar" style="cursor:pointer;display:block;width:100%;margin-bottom:10px;'
    + '    padding:11px 0;border-radius:12px;border:1px solid rgba(120,200,160,.35);background:rgba(20,30,26,.6);'
    + '    color:#cfe8dc;font:700 13px system-ui">显示 / 隐藏顶部按钮栏</button>'
    + '  <button id="mp-menu-quit" style="cursor:pointer;display:block;width:100%;'
    + '    padding:13px 0;border-radius:12px;border:1px solid rgba(255,120,120,.45);background:rgba(60,20,20,.55);'
    + '    color:#ffb3b3;font:800 15px system-ui;letter-spacing:1px">返回主菜单</button>'
    + '  <div id="mp-menu-tip" style="font:500 11.5px system-ui;color:#6f7a86;margin-top:14px;line-height:1.6"></div>'
    + '</div>';
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeGameMenu(); });
  const rb = el.querySelector('#mp-menu-resume');
  if (rb) rb.addEventListener('click', () => closeGameMenu());
  const tb = el.querySelector('#mp-menu-topbar');
  if (tb) tb.addEventListener('click', () => {
    const bar = document.getElementById('mp-topbar');
    if (!bar) return;
    bar.__forced = !bar.__forced;
    bar.style.display = (bar.__forced || topbarWanted()) ? 'flex' : 'none';
    refreshTopbarState();
  });
  const qb = el.querySelector('#mp-menu-quit');
  if (qb) qb.addEventListener('click', () => returnToMainMenu());
  return el;
}

function openGameMenu() {
  if (gameMenuOpen) return;
  /* 其它模态（聊天 / 商店）打开时先收起，避免叠层 */
  try { if (chatOpen) closeChat(); } catch (_) {}
  try { if (shopOpen) closeShop(); } catch (_) {}
  gameMenuOpen = true;
  const el = ensureGameMenu();
  const sub = el.querySelector('#mp-game-menu-sub');
  if (sub) {
    sub.textContent = state.active
      ? ('联机 · ' + (state.mode === 'host' ? '房主' : '玩家') + ' · ' + state.code + ' · 游戏继续进行中')
      : '游戏继续进行中';
  }
  const tip = el.querySelector('#mp-menu-tip');
  if (tip) {
    tip.textContent = state.active
      ? '提示：菜单不暂停对局，「返回主菜单」会先离开房间。'
      : '提示：菜单不暂停对局。';
  }
  el.style.display = 'flex';
  /* 释放鼠标锁，让鼠标能点按钮；不改变游戏 state */
  try { if (document.exitPointerLock) document.exitPointerLock(); } catch (_) {}
}

function closeGameMenu() {
  if (!gameMenuOpen) return;
  gameMenuOpen = false;
  const el = document.getElementById('mp-game-menu');
  if (el) el.style.display = 'none';
}

/* 返回主菜单：联机先退房，再跳回 index.html */
function returnToMainMenu() {
  try {
    if (window.P2P && P2P.inGame && P2P.inGame() && P2P.shutdown) P2P.shutdown();
  } catch (_) {}
  try {
    if (window.MP && MP.state) MP.state.active = false;
  } catch (_) {}
  location.href = 'index.html';
}

/* ---------- ★ §3.2 职业信息卡（只读，点顶栏「职业」或已锁定后查看） ---------- */
function showClassInfo() {
  let el = document.getElementById('mp-class-info');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mp-class-info';
    el.style.cssText = 'position:fixed;inset:0;z-index:99997;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(6,10,14,.7);backdrop-filter:blur(4px)';
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.style.display = 'none'; });
  }
  const rows = Object.keys(CLASSES).map(k => {
    const c = CLASSES[k];
    const on = k === myClass;
    return '<div style="display:flex;gap:14px;align-items:flex-start;padding:12px 14px;border-radius:12px;'
      + 'border:1px solid ' + (on ? c.color : 'rgba(120,200,160,.18)') + ';'
      + 'background:' + (on ? 'rgba(30,60,45,.7)' : 'rgba(10,14,20,.55)') + ';margin-bottom:8px">'
      + '<div style="font:700 30px system-ui;line-height:1">' + c.icon + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font:800 15px system-ui;color:' + c.color + '">' + c.name
      + (on ? ' <span style="font:600 11px system-ui;color:#9fe8c1">· 当前</span>' : '') + '</div>'
      + '<div style="font:500 12px system-ui;color:#b8c8d0;margin-top:5px"><b style="color:#8fd">被动</b>　' + c.passive + '</div>'
      + '<div style="font:500 12px system-ui;color:#b8c8d0;margin-top:3px"><b style="color:#ffd166">主动 V</b>　' + c.active.name
      + '（CD ' + c.active.cd + 's）　—　' + c.active.desc + '</div>'
      + '</div></div>';
  }).join('');
  el.innerHTML = '<div style="width:min(600px,92vw);max-height:86vh;overflow:auto;border-radius:16px;'
    + 'border:1px solid rgba(120,200,160,.32);background:linear-gradient(160deg,rgba(14,20,28,.97),rgba(10,14,20,.97));'
    + 'box-shadow:0 18px 60px rgba(0,0,0,.6);padding:18px 20px 20px;font:500 13px system-ui;color:#dff">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
    + '<div style="font:800 19px system-ui;color:#9fe8c1;letter-spacing:1px">职业与技能</div>'
    + '<button id="mp-class-info-x" style="cursor:pointer;border:1px solid rgba(255,120,120,.4);'
    + 'background:rgba(60,20,20,.5);color:#ffb3b3;border-radius:8px;padding:4px 10px;font:600 12px system-ui">关闭</button>'
    + '</div>' + rows
    + '<div style="font:500 11.5px system-ui;color:#8a93a3;margin-top:8px">'
    + '职业在开局时选定，一局只选一次；主动技能按 V 释放（或点顶栏 ⚡）。</div></div>';
  el.style.display = 'flex';
  const x = el.querySelector('#mp-class-info-x');
  if (x) x.addEventListener('click', () => { el.style.display = 'none'; });
}

/* ---------- ★ §3.2 主动技能释放（CD 由本模块统一维护） ---------- */
function useSkill() {
  if (!classPicked) { toast('请先选择职业'); return false; }
  if (skillCd > 0) { toast('技能冷却中 · ' + Math.ceil(skillCd) + 's'); return false; }
  const c = CLASS_CSS(myClass);
  if (!c.active) return false;
  let ok = true;
  if (typeof window.__classSkill === 'function') {
    try { ok = window.__classSkill(myClass, c) !== false; } catch (_) { ok = false; }
  }
  if (ok === false) { toast('当前无法释放技能'); return false; }
  skillCd = c.active.cd;
  refreshClassHud(); refreshTopbarState();
  return true;
}
function tickSkillCd(dt) {
  if (skillCd <= 0) return;
  const before = Math.ceil(skillCd);
  skillCd = Math.max(0, skillCd - dt);
  if (Math.ceil(skillCd) !== before) { refreshClassHud(); refreshTopbarState(); }
}

function toast(msg) {
  const b = document.getElementById('banner');
  if (b) { b.textContent = msg; b.style.opacity = 1; return; }
  let t = document.getElementById('mp-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'mp-toast';
    t.style.cssText = 'position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:99998;'
      + 'font:700 15px system-ui;color:#ffd166;background:rgba(10,14,20,.82);padding:8px 18px;'
      + 'border-radius:12px;border:1px solid rgba(255,209,102,.4);pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  clearTimeout(toast.__t);
  toast.__t = setTimeout(() => { t.style.display = 'none'; }, 1600);
  t.style.display = '';
}

/* ---------- ★ 本地 UI 装配（单人 + 联机共用，必须在 boot 早退之前调用） ---------- */
function initLocalUi() {
  mountTopbarToggle();
  ensureGameMenu();
  mountReviveBtn();
  buildTopbar();
  buildRadarUi();
  buildClassHud();
  bindShopKeys();
  bindLocalKeys();
  refreshTopbarState();
  refreshClassHud();
}
/* 单人也要能用的键（B / M / V）；联机额外还有 T / Q / F 等（bindSquadKeys） */
function bindLocalKeys() {
  if (bindLocalKeys.done) return; bindLocalKeys.done = true;
  window.addEventListener('keydown', e => {
    if (e.__localKeysHandled) return;
    if (e.code === 'KeyM') { e.__localKeysHandled = true; e.preventDefault(); toggleRadar(); refreshTopbarState(); }
    else if (e.code === 'KeyV') { e.__localKeysHandled = true; e.preventDefault(); useSkill(); }
    else if (e.code === 'Escape') {
      /* 聊天 / 商店打开时 Esc 交给各自处理；已开菜单时 Esc 关闭 */
      if (chatOpen || shopOpen) return;
      e.__localKeysHandled = true;
      if (gameMenuOpen) closeGameMenu(); else openGameMenu();
    }
  });
  window.addEventListener('resize', () => { try { buildTopbar(); } catch (_) {} });
}

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
      hp, alive: !spectating, name: state.name, source: 'cameraWorld',
      cls: myClass, down: downed, downT: +downT.toFixed(1), prog: +reviving.toFixed(2)
    };
  }

  /* ============================================================
   * §3.1 队友救援 — 濒死状态机
   *   alive → downed(downT=30) → reviving(prog 0→1) → alive / dead
   *   防单机卡死：无队友 / 未联机 / 房主掉线 → 不走濒死，直接原死亡逻辑
   * ============================================================ */

  /* 是否允许进入濒死（硬规则）
   *   ★ #6 需求：房主与普通玩家【都可以】倒地待救（全员救援机制）；
   *   ★ #8 需求：只剩自己一人时（无存活队友）直接真死，不弹"等待救助"。 */
  function canGoDown() {
    if (!state.active || !window.P2P || !P2P.inGame()) return false;
    /* ★ 用【存活数】而非连接数判断：队友已死但连接仍在时不应误判"还有人来救" */
    let alive = 1;
    try {
      if (P2P.aliveCount) alive = P2P.aliveCount();
      else if (P2P.totalCount) alive = P2P.totalCount();
    } catch (_) {}
    if (alive <= 1) return false;                  // 只剩自己 → 无人可救
    if (hostLost) return false;
    return true;
  }

  /* 地图页在 HP 归零时调用：返回 true=已接管为濒死 */
  function tryEnterDown() {
    if (!canGoDown()) return false;
    if (downed || spectating) return false;
    downed = true; downT = DOWN_TIME;
    reviving = 0; reviveTarget = null;
    try { if (window.P2P && P2P.reportDowned) P2P.reportDowned(); } catch (_) {}
    if (hud && typeof hud.onDown === 'function') { try { hud.onDown(); } catch (_) {} }
    showDownHint();
    if (window.__downedFx) try { window.__downedFx(); } catch (_) {}
    return true;
  }

  /* 濒死倒计时推进（房主权威：本地倒计时由地图页每帧驱动；联机各自维护自己的） */
  function tickDown(dt) {
    if (!downed) return;
    downT -= dt;
    if (downT <= 0) {
      downT = 0; downed = false;
      hideDownHint();
      if (window.__playerHurt === undefined) { /* noop */ }
      /* 倒计时归零 → 真死亡 */
      if (window.P2P) { try { P2P.reportDeath(); } catch (_) {} }
      if (hud && typeof hud.onDownExpire === 'function') { try { hud.onDownExpire(); } catch (_) {} }
    }
  }

  /* 被救起 */
  function onRevived(ratio) {
    if (!downed) return;
    downed = false; downT = 0;
    hideDownHint();
    if (window.__revived) { try { window.__revived(typeof ratio === 'number' ? ratio : 0.4); return; } catch (_) {} }
    hp = Math.max(hp, 100 * (typeof ratio === 'number' ? ratio : 0.4));
  }

  /* 找最近的可救目标（远端队友 / 房主）→ { id, x, z } */
  function findReviveTarget() {
    const me = localPos();
    let best = null, bestD = REVIVE_RANGE;
    try {
      P2P.eachRemote((s, id) => {
        if (!s || !s.down) return;
        if (s.alive === false) return;
        const d = Math.hypot((s.x || 0) - me.x, (s.z || 0) - me.z);
        if (d <= bestD) { bestD = d; best = { id: (id != null ? id : s.id), x: s.x, z: s.z }; }
      });
    } catch (_) {}
    return best;
  }

  /* 每帧更新"救援他人"进度 */
  function tickRevive(dt) {
    if (!state.active || spectating || downed) { reviving = 0; reviveTarget = null; return; }
    if (!heldKey) { reviving = 0; reviveTarget = null; return; }
    /* 找最近的可救目标（★ 已含房主：房主快照以 id '__host' 存入远端表并被广播） */
    const best = findReviveTarget();
    if (!best) { reviving = 0; reviveTarget = null; return; }
    const me = localPos();
    if (reviveTarget !== best.id) { reviving = 0; reviveTarget = best.id; }
    /* 移动打断 */
    if (_lastPos.x != null) {
      const moved = Math.hypot(me.x - _lastPos.x, me.z - _lastPos.z);
      if (moved > 0.045) { reviving = 0; return; }   // 本帧移动超过阈值 → 中断
    }
    /* ★ §3.1 清单：救援基底 10 秒；医疗兵专用 3 秒（直接覆盖，非乘法） */
    const need = (myClass === 'medic') ? MEDIC_REVIVE_TIME : REVIVE_TIME;
    reviving += dt / need;
    try { P2P.notifyRevive(best.id, Math.min(1, reviving), false); } catch (_) {}
    if (reviving >= 1) {
      try { P2P.notifyRevive(best.id, 1, true); } catch (_) {}
      reviving = 0; reviveTarget = null;
      if (window.__reviveFx) try { window.__reviveFx(); } catch (_) {}
    }
  }

  function localPos() {
    if (window.__getLocalCombat) { try { const c = window.__getLocalCombat(); if (c) return c; } catch (_) {} }
    return { x: 0, z: 0 };
  }

  /* ---------- ★ #7 移动端救助按钮（替代键盘 F，按住即救援） ---------- */
  function mountReviveBtn() {
    if (document.getElementById('mp-revive-btn')) return;
    const b = document.createElement('button');
    b.id = 'mp-revive-btn';
    b.textContent = '救助';
    b.title = '靠近倒地队友按住救助';
    b.style.cssText = 'position:fixed;right:18px;bottom:110px;z-index:99993;display:none;'
      + 'width:78px;height:78px;border-radius:50%;cursor:pointer;padding:0;'
      + 'border:2px solid rgba(255,159,67,.75);background:rgba(80,40,10,.72);color:#ffd8a8;'
      + 'font:800 16px system-ui;letter-spacing:1px;backdrop-filter:blur(4px);'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.45);touch-action:none;user-select:none';
    const start = e => {
      e.preventDefault(); e.stopPropagation();
      heldKey = true;
      b.style.background = 'rgba(120,60,10,.9)';
    };
    const end = e => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      heldKey = false;
      b.style.background = 'rgba(80,40,10,.72)';
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('pointerleave', end);
    b.addEventListener('contextmenu', e => e.preventDefault());
    document.body.appendChild(b);
  }
  /* 每帧刷新：附近有倒地队友时显示（单人 / 自己濒死 / 观战时隐藏） */
  function updateReviveBtn() {
    const b = document.getElementById('mp-revive-btn');
    if (!b) return;
    let show = false;
    if (state.active && !spectating && !downed) {
      try { show = !!findReviveTarget(); } catch (_) { show = false; }
    }
    b.style.display = show ? 'block' : 'none';
    if (!show && heldKey) { heldKey = false; }   // 目标消失 → 松开，避免卡住 heldKey
  }

  function showDownHint() {
    let el = document.getElementById('mp-down');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-down';
      el.style.cssText = 'position:fixed;left:50%;bottom:20%;transform:translateX(-50%);z-index:99992;'
        + 'font:800 18px system-ui;padding:12px 26px;border-radius:14px;text-align:center;'
        + 'background:rgba(60,8,8,.82);color:#ffb3b3;border:1px solid rgba(255,90,90,.5);'
        + 'pointer-events:none;letter-spacing:1px';
      document.body.appendChild(el);
    }
    el.style.display = '';
  }
  function hideDownHint() { const el = document.getElementById('mp-down'); if (el) el.style.display = 'none'; }
  function updateDownHint() {
    const el = document.getElementById('mp-down');
    if (!el || !downed) return;
    el.innerHTML = '倒地！等待救援 · <span style="color:#ff6b6b">' + Math.ceil(downT) + 's</span>'
      + '<div style="font-size:12px;font-weight:500;color:#e0b0b0;margin-top:4px">队友靠近按住 F 可救起（医疗兵仅需 3 秒）</div>';
  }

  /* ============================================================
   * §3.3 小地图（圆形雷达）
   * ============================================================ */
  /* 纯函数：把世界相对偏移映射到雷达画布坐标（可单测） */
  function radarPoint(dx, dz, R) {
    const d = Math.hypot(dx, dz);
    if (d <= R || d < 1e-6) return { x: dx / R, y: dz / R, edge: false };
    /* 超出范围 → 贴边 */
    return { x: (dx / d) * 1.0, y: (dz / d) * 1.0, edge: true };
  }
  function getRadarCanvas() {
    let c = document.getElementById('mp-radar');
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'mp-radar';
      c.width = RADAR_SIZE; c.height = RADAR_SIZE;
      c.style.cssText = 'position:fixed;right:14px;top:46px;z-index:99989;border-radius:50%;'
        + 'background:rgba(8,12,16,.55);border:2px solid rgba(90,200,150,.35);'
        + 'pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      document.body.appendChild(c);
    }
    return c;
  }
  function drawRadar() {
    /* ★ §3.3 单人也要有小地图：只判"收起"与"已开始"，不再要求 state.active */
    if (radarCollapsed) return;
    const c = getRadarCanvas();
    if (!c) return;
    if (c.style.display === 'none') return;
    const g = c.getContext('2d');
    if (!g) return;
    const S = RADAR_SIZE, cx = S / 2, cy = S / 2, rPx = S / 2 - 6;
    g.clearRect(0, 0, S, S);
    /* 底盘网格 */
    g.strokeStyle = 'rgba(120,220,170,.14)'; g.lineWidth = 1;
    for (let rr = 1; rr <= 3; rr++) { g.beginPath(); g.arc(cx, cy, rPx * rr / 3, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx, cy - rPx); g.lineTo(cx, cy + rPx); g.stroke();
    g.beginPath(); g.moveTo(cx - rPx, cy); g.lineTo(cx + rPx, cy); g.stroke();

    const R = RADAR_R * (CLASS_CSS(myClass).radarMul || 1);
    const me = localPos();
    const rot = -(me.ry || 0);                     // 跟随视角旋转
    const cos = Math.cos(rot), sin = Math.sin(rot);

    const plot = (dx, dz) => {
      const p = radarPoint(dx, dz, R);
      const rx = p.x, ry = p.y;
      const wx = rx * cos - ry * sin, wz = rx * sin + ry * cos;
      return { x: cx + wx * rPx, y: cy + wz * rPx, edge: p.edge };
    };

    /* 取丧尸列表（单机 / 房主为本地数组；客户端为本地镜像） */
    let zs = null;
    if (window.__radarData) { try { zs = window.__radarData(); } catch (_) {} }
    if (!Array.isArray(zs)) zs = [];

    /* ★ §3.3 密度热力：8×8 网格统计丧尸数 → 半透明红块（底盘之后、点之前） */
    if (zs.length) {
      const G = 8;
      const grid = new Array(G * G).fill(0);
      for (const z of zs) {
        const p = radarPoint((z.x || 0) - me.x, (z.z || 0) - me.z, R);
        const gx = Math.max(0, Math.min(G - 1, Math.floor((p.x * 0.5 + 0.5) * G)));
        const gy = Math.max(0, Math.min(G - 1, Math.floor((p.y * 0.5 + 0.5) * G)));
        grid[gy * G + gx]++;
      }
      const cell = (rPx * 2) / G;
      for (let i = 0; i < grid.length; i++) {
        const n = grid[i]; if (!n) continue;
        const gx = i % G, gy = (i / G) | 0;
        const a = Math.min(0.42, 0.09 * n);
        g.fillStyle = 'rgba(255,60,60,' + a.toFixed(3) + ')';
        g.fillRect(cx - rPx + gx * cell, cy - rPx + gy * cell, cell, cell);
      }
    }

    /* 丧尸（普通红点 / BOSS 大红点）—— 清单：Boss 为红点 */
    for (const z of zs) {
      const p = plot((z.x || 0) - me.x, (z.z || 0) - me.z);
      if (z.boss) {
        g.fillStyle = '#ff2d2d';
        g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2;
        g.beginPath(); g.arc(p.x, p.y, 6.5, 0, Math.PI * 2); g.stroke();
      } else {
        g.fillStyle = 'rgba(255,80,80,.72)';
        g.beginPath(); g.arc(p.x, p.y, 2.4, 0, Math.PI * 2); g.fill();
      }
    }
    /* 队友（★ 清单：蓝点 + 血量环；濒死橙点） */
    try {
      if (window.P2P && P2P.eachRemote) P2P.eachRemote((s, id) => {
        if (!s) return;
        const p = plot((s.x || 0) - me.x, (s.z || 0) - me.z);
        const alive = s.alive !== false && !s.down;
        g.fillStyle = s.down ? '#ff9f43' : (alive ? '#4d96ff' : '#888');
        g.beginPath(); g.arc(p.x, p.y, 3.4, 0, Math.PI * 2); g.fill();
        if (alive && typeof s.hp === 'number') {
          g.strokeStyle = 'rgba(120,170,255,.75)'; g.lineWidth = 1.6;
          g.beginPath(); g.arc(p.x, p.y, 5.2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, s.hp / 100))); g.stroke();
        }
      });
    } catch (_) {}
    /* 自己居中（白点 + 朝向） */
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 3.4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - 8); g.stroke();
    /* 濒死边框提示 */
    if (downed) { g.strokeStyle = 'rgba(255,80,80,.9)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, rPx, 0, Math.PI * 2); g.stroke(); }
  }

  /* ============================================================
   * §3.4 聊天框（文本 + 快捷指令）
   * ============================================================ */
  const chatLog = [];                             // { name, text, t, quick, self }
  function getChatBox() {
    let wrap = document.getElementById('mp-chat');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'mp-chat';
      wrap.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99993;width:300px;max-width:calc(100vw - 28px);'
        + 'font:500 13px system-ui;pointer-events:none;display:flex;flex-direction:column;gap:4px';
      wrap.innerHTML = '<div id="mp-chat-log" style="display:flex;flex-direction:column;gap:3px"></div>'
        + '<div id="mp-chat-row" style="display:none;gap:6px;align-items:stretch">'
        + '  <input id="mp-chat-input" maxlength="80" placeholder="说点什么…（Enter 发送）" '
        + '    style="flex:1;min-width:0;pointer-events:auto;padding:7px 10px;border-radius:8px;border:1px solid rgba(120,200,160,.4);'
        + '    background:rgba(10,14,20,.9);color:#dff;outline:none;font:500 13px system-ui"/>'
        + '  <button id="mp-chat-send" style="pointer-events:auto;white-space:nowrap;cursor:pointer;padding:0 14px;'
        + '    border-radius:8px;border:1px solid rgba(46,194,126,.55);background:rgba(30,70,50,.75);'
        + '    color:#eafff4;font:700 13px system-ui">发送</button>'
        + '</div>';
      document.body.appendChild(wrap);
      const btn = wrap.querySelector('#mp-chat-send');
      if (btn) btn.addEventListener('click', e => {
        e.preventDefault();
        const inp = wrap.querySelector('#mp-chat-input');
        const v = (inp && inp.value || '').trim();
        if (v) sendChatText(v, false);
        closeChat();
      });
    }
    return wrap;
  }
  function openChat() {
    /* ★ §3.4 清单：聊天仅联机可用 */
    if (!state.active) { toast('队伍聊天仅在联机时可用'); return; }
    if (chatOpen || spectating) return;
    chatOpen = true;
    const wrap = getChatBox();
    const row = wrap.querySelector('#mp-chat-row');
    const inp = wrap.querySelector('#mp-chat-input');
    if (row) row.style.display = 'flex';
    inp.style.display = ''; inp.value = '';
    if (window.__pauseForInput) { try { window.__pauseForInput(true); } catch (_) {} }
    setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
  }
  function closeChat() {
    if (!chatOpen) return;
    chatOpen = false;
    const wrap = getChatBox();
    const row = wrap.querySelector('#mp-chat-row');
    const inp = wrap.querySelector('#mp-chat-input');
    inp.style.display = 'none';
    if (row) row.style.display = 'none';
    if (window.__pauseForInput) { try { window.__pauseForInput(false); } catch (_) {} }
  }
  function sendChatText(text, quick) {
    if (!text) return;
    try { if (window.P2P && P2P.sendChat) P2P.sendChat(text, quick); } catch (_) {}
  }
  function pushChat(msg) {
    chatLog.push(Object.assign({ t: performance.now() }, msg));
    while (chatLog.length > 8) chatLog.shift();
    renderChat();
  }
  function renderChat() {
    const wrap = getChatBox();
    const log = wrap.querySelector('#mp-chat-log');
    const now = performance.now();
    log.innerHTML = chatLog.map(m => {
      const age = (now - m.t) / 1000;
      /* ★ §3.4 清单：消息 10 秒后开始淡出（原 6 秒） */
      const op = age > 10 ? Math.max(0, 1 - (age - 10) / 1.5) : 1;
      if (op <= 0) return '';
      const cls = CLASS_CSS(m.cls);
      const nm = m.quick ? '' : '<b style="color:' + (m.self ? '#9fe8c1' : cls.color) + '">' + esc(m.name || '玩家') + '：</b>';
      return '<div style="opacity:' + op.toFixed(2) + ';background:rgba(8,12,16,.5);padding:2px 7px;border-radius:6px;'
        + 'color:' + (m.quick ? '#ffd166' : '#dff') + '">' + nm + esc(m.text) + '</div>';
    }).join('');
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function pushQuick(idx) {
    const q = QUICKS[idx]; if (!q) return;
    const now = performance.now();
    if (chatCool[q.id] && now < chatCool[q.id]) return;
    chatCool[q.id] = now + q.cool * 1000;
    sendChatText(q.txt, true);
  }

  /* ---------- 键盘绑定（聊天 / 交互 / 快捷指令） ---------- */
  function bindSquadKeys() {
    if (bindSquadKeys.done) return; bindSquadKeys.done = true;
    window.addEventListener('keydown', e => {
      /* 聊天打开时：Enter 发送、Esc 取消、其余不拦截 */
      if (chatOpen) {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
          const inp = getChatBox().querySelector('#mp-chat-input');
          const v = (inp.value || '').trim();
          if (v) sendChatText(v, false);
          closeChat(); e.preventDefault();
        } else if (e.code === 'Escape') { closeChat(); e.preventDefault(); }
        return;
      }
      if (!state.active || state.mode == null) return;
      if (shopOpen) return;                       /* §4 商店打开时：不响应场景热键 */
      if (e.code === 'KeyT') { openChat(); e.preventDefault(); }
      else if (e.code === 'KeyQ') { pushQuick((quickIdx = (quickIdx + 1) % QUICKS.length)); e.preventDefault(); }
      else if (e.code === 'KeyF') { heldKey = true; }    /* ★ §3.1 清单：救援/交互键 = F */
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'KeyF') heldKey = false;
    });
  }
  let quickIdx = -1;

  /* ============================================================
   * ★ §3.2 开局面板 —— 职业一局只选一次（含被动 / 主动技能说明）
   *   需求：职业选择"只在开局时选一次，要说明每个职业的技能"
   * ============================================================ */
  function buildClassStartPanel() {
    let el = document.getElementById('mp-class-start');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-class-start';
      el.style.cssText = 'position:fixed;inset:0;z-index:99998;display:none;align-items:center;justify-content:center;'
        + 'background:rgba(6,10,14,.82);backdrop-filter:blur(5px)';
      document.body.appendChild(el);
    }
    const cards = Object.keys(CLASSES).map(k => {
      const c = CLASSES[k];
      return '<button data-cls="' + k + '" style="cursor:pointer;text-align:left;display:block;width:100%;'
        + 'padding:14px 16px;border-radius:14px;border:1px solid rgba(120,200,160,.28);'
        + 'background:rgba(14,20,28,.9);color:#dff;font:500 13px system-ui;margin-bottom:10px;transition:.15s">'
        + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">'
        + '  <span style="font:700 28px system-ui;line-height:1">' + c.icon + '</span>'
        + '  <span style="font:800 17px system-ui;color:' + c.color + ';letter-spacing:1px">' + c.name + '</span>'
        + '</div>'
        + '<div style="font:500 12.5px system-ui;color:#b8c8d0;line-height:1.7">'
        + '  <div><b style="color:#8fd">被动</b>　' + c.passive + '</div>'
        + '  <div><b style="color:#ffd166">主动（V）</b>　' + c.active.name + ' · CD ' + c.active.cd + 's</div>'
        + '  <div style="color:#93a3ad;padding-left:2px">' + c.active.desc + '</div>'
        + '</div></button>';
    }).join('');
    el.innerHTML = '<div style="width:min(540px,92vw);max-height:88vh;overflow:auto;border-radius:18px;'
      + 'border:1px solid rgba(120,200,160,.34);background:linear-gradient(160deg,rgba(14,20,28,.98),rgba(10,14,20,.98));'
      + 'box-shadow:0 20px 70px rgba(0,0,0,.7);padding:22px 22px 20px">'
      + '<div style="text-align:center;margin-bottom:4px;font:800 22px system-ui;color:#9fe8c1;letter-spacing:2px">选择你的职业</div>'
      + '<div style="text-align:center;font:500 12.5px system-ui;color:#8a93a3;margin-bottom:16px">'
      + '一局只选一次 · 每个职业各有 1 个被动与 1 个主动技能（V 键释放）</div>'
      + cards
      + '<div style="text-align:center;font:500 11.5px system-ui;color:#6f7a86;margin-top:4px">'
      + '选定后不可更换；随时可点顶栏「👤 职业」查看技能说明</div></div>';
    if (!el.__wired) {
      el.__wired = true;
      el.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('button[data-cls]');
        if (!b) return;
        pickClass(b.getAttribute('data-cls'));
      });
    }
    return el;
  }
  /* 弹出开局面板（若已选过则跳过） */
  function maybePromptClass() {
    if (classPicked) return;
    const el = buildClassStartPanel();
    el.style.display = 'flex';
  }
  /* 玩家选定职业：应用加成、锁定本局、关面板 */
  function pickClass(cls) {
    if (!CLASSES[cls]) return false;
    if (classPicked) return false;              // ★ 一局只选一次
    setClass(cls);
    classPicked = true;
    const el = document.getElementById('mp-class-start');
    if (el) el.style.display = 'none';
    refreshClassHud(); refreshTopbarState();
    try { if (window.banner) banner('职业已选定 · ' + CLASS_CSS(cls).name); } catch (_) {}
    return true;
  }
  /* 每帧检测：开局（state 变 play）时若未选职业 → 弹面板。
     单机与联机共用；地图页通过 window.__gameState 暴露当前 state。 */
  function tickClassPrompt() {
    if (classPicked) return;
    if (chatOpen || shopOpen) return;
    let st = null;
    try { if (typeof window.__gameState === 'function') st = window.__gameState(); } catch (_) {}
    if (st === 'play') maybePromptClass();
  }

  /* ---------- §3.2 职业选择（旧接口保留：侧边卡片已移除，仅用于程序化切换） ---------- */
  function buildClassPanel() { /* ★ 清单：不再提供局内随时切换的侧边卡片 */ }
  function refreshClassPanel() { refreshClassHud(); }
  function setClass(cls) {
    if (!CLASSES[cls]) return;
    myClass = cls; clsApplied = null;
    skillCd = 0;
    try { if (window.P2P && P2P.reportClass) P2P.reportClass(cls); } catch (_) {}
    applyClassNow();
    refreshClassHud();
  }
  function applyClassNow() {
    if (clsApplied === myClass) return;
    const c = CLASS_CSS(myClass);
    if (window.__applyClass) { try { window.__applyClass(myClass, c); clsApplied = myClass; return; } catch (_) {} }
    clsApplied = myClass;
  }

  /* ============================================================
   * §4 局内经济与商店（零件 / 解锁 / 补给 / 上限升级）
   *
   * 契约：地图页暴露 window.__shop = { balance(), items(), buy(id) }
   *   - balance() → number（当前零件数）
   *   - items()   → [{ id, name, desc, price, owned, canBuy, group }]
   *   - buy(id)   → { ok:boolean, msg:string }
   * 未实现 __shop 的地图（如 map3 旧版）自动降级：不渲染、不响应 B 键。
   * ============================================================ */
  let shopOpen = false;

  /* 分组显示顺序与标题 */
  const SHOP_GROUPS = [
    { key: 'unlock',  label: '武器解锁' },
    { key: 'supply',  label: '弹药补给' },
    { key: 'upgrade', label: '上限升级' }
  ];

  function shopAvailable() {
    return !!(window.__shop && typeof window.__shop.buy === 'function' && typeof window.__shop.items === 'function');
  }

  function buildShopUi() {
    let el = document.getElementById('mp-shop');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mp-shop';
    el.style.cssText = 'position:fixed;inset:0;z-index:99996;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(6,10,14,.66);backdrop-filter:blur(4px)';
    el.innerHTML = ''
      + '<div id="mp-shop-panel" style="width:min(560px,92vw);max-height:82vh;overflow:auto;border-radius:16px;'
      + 'border:1px solid rgba(120,200,160,.32);background:linear-gradient(160deg,rgba(14,20,28,.96),rgba(10,14,20,.96));'
      + 'box-shadow:0 18px 60px rgba(0,0,0,.6);padding:18px 20px 20px;font:500 13px system-ui;color:#dff">'
      + '  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">'
      + '    <div style="font:800 20px system-ui;color:#9fe8c1;letter-spacing:1px">🛒 补给站</div>'
      + '    <div style="display:flex;align-items:center;gap:12px">'
      + '      <div style="font:700 16px system-ui;color:#ffd166">🔧 零件 <b id="mp-shop-bal">0</b></div>'
      + '      <button id="mp-shop-close" style="cursor:pointer;border:1px solid rgba(255,120,120,.4);'
      + '        background:rgba(60,20,20,.5);color:#ffb3b3;border-radius:8px;padding:4px 10px;font:600 12px system-ui">关闭 (Esc)</button>'
      + '    </div>'
      + '  </div>'
      + '  <div id="mp-shop-hint" style="font-size:12px;color:#8a93a3;margin-bottom:10px">'
      + '    击杀丧尸掉落零件 · 每清一波额外奖励 · 战斗中随时可按 B 打开</div>'
      + '  <div id="mp-shop-list"></div>'
      + '  <div id="mp-shop-toast" style="min-height:18px;font:600 12px system-ui;color:#ffd166;margin-top:10px;'
      + '    transition:opacity .2s;opacity:0"></div>'
      + '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) closeShop(); });
    const closeBtn = el.querySelector('#mp-shop-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeShop());
    return el;
  }

  function refreshShop() {
    const el = document.getElementById('mp-shop');
    if (!el || !shopAvailable()) return;
    const balEl = el.querySelector('#mp-shop-bal');
    let bal = 0;
    try { bal = +window.__shop.balance() || 0; } catch (_) {}
    if (balEl) balEl.textContent = String(bal);

    let items = [];
    try { items = window.__shop.items() || []; } catch (_) {}
    const priceOf = it => (+it.price > 0 ? +it.price : 0);
    const list = el.querySelector('#mp-shop-list');
    if (!list) return;

    let html = '';
    SHOP_GROUPS.forEach(g => {
      const rows = items.filter(it => (it.group || 'misc') === g.key);
      if (!rows.length) return;
      html += '<div style="font:700 12px system-ui;color:#8fd;opacity:.75;margin:12px 0 6px;letter-spacing:1px">'
        + g.label + '</div>';
      html += rows.map(it => {
        const cost = priceOf(it);
        const owned = !!it.owned;
        const maxed = !!it.maxed;
        const canBuy = (it.canBuy !== false) && !maxed && bal >= cost;
        const stateTxt = maxed ? '已满级' : (owned ? '已拥有' : '');
        const btnTxt = maxed ? '满级' : (owned && it.rebuy ? '补给 ' + cost : (owned ? '已解锁' : '购买 ' + cost));
        const disabled = maxed || (owned && !it.rebuy) || !canBuy;
        const bcol = disabled ? 'rgba(120,200,160,.18)' : 'rgba(46,194,126,.55)';
        const fcol = disabled ? '#7d8a94' : '#dff';
        const bg = disabled ? 'rgba(20,28,24,.5)' : 'rgba(30,70,50,.6)';
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px;'
          + 'border:1px solid rgba(120,200,160,.16);background:rgba(10,14,20,.5);margin-bottom:6px">'
          + '  <div style="flex:1;min-width:0">'
          + '    <div style="font:700 13px system-ui;color:#eafff4">' + esc(it.name || it.id)
          + (stateTxt ? ' <span style="font:600 11px system-ui;color:#8fd;opacity:.8">· ' + stateTxt + '</span>' : '') + '</div>'
          + '    <div style="font:500 11.5px system-ui;color:#93a3ad;margin-top:2px">' + esc(it.desc || '') + '</div>'
          + '  </div>'
          + '  <button data-buy="' + esc(it.id) + '" ' + (disabled ? 'disabled ' : '')
          + '    style="cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';white-space:nowrap;'
          + '    border:1px solid ' + bcol + ';background:' + bg + ';color:' + fcol + ';'
          + '    border-radius:8px;padding:6px 12px;font:700 12px system-ui">' + btnTxt + '</button>'
          + '</div>';
      }).join('');
    });
    list.innerHTML = html || '<div style="color:#8a93a3;font-size:12px">暂无可购买项</div>';
  }

  function shopToast(msg, warn) {
    const el = document.getElementById('mp-shop');
    if (!el) return;
    const t = el.querySelector('#mp-shop-toast');
    if (!t) return;
    t.textContent = msg || '';
    t.style.color = warn ? '#ff9f8f' : '#9fe8c1';
    t.style.opacity = '1';
    clearTimeout(shopToast.__t);
    shopToast.__t = setTimeout(() => { t.style.opacity = '0'; }, 1600);
  }

  function buyFromShop(id) {
    if (!shopAvailable()) return;
    let r = null;
    try { r = window.__shop.buy(id); } catch (e) { r = { ok: false, msg: '购买异常：' + (e && e.message) }; }
    r = r || {};
    shopToast(r.msg || (r.ok ? '✔ 已购买' : '✖ 购买失败'), !r.ok);
    refreshShop();
  }

  function openShop() {
    if (shopOpen || chatOpen) return;
    /* ★ §4.2 单人也要有商店：仅在"已阵亡观战"时禁止打开 */
    if (spectating) return;
    if (!shopAvailable()) return;
    shopOpen = true;
    const el = buildShopUi();
    el.style.display = 'flex';
    /* ★ 暂停玩家输入与游戏主循环（与聊天一致） */
    try { if (window.__shopOpenFlag !== undefined) window.__shopOpenFlag = true; } catch (_) {}
    if (window.__pauseForInput) { try { window.__pauseForInput(true); } catch (_) {} }
    refreshShop();
    /* 事件委托：购买 */
    if (!el.__wired) {
      el.__wired = true;
      el.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('button[data-buy]');
        if (!b || b.disabled) return;
        buyFromShop(b.getAttribute('data-buy'));
      });
    }
  }

  function closeShop() {
    if (!shopOpen) return;
    shopOpen = false;
    const el = document.getElementById('mp-shop');
    if (el) el.style.display = 'none';
    try { if (window.__shopOpenFlag !== undefined) window.__shopOpenFlag = false; } catch (_) {}
    if (window.__pauseForInput) { try { window.__pauseForInput(false); } catch (_) {} }
  }

  function toggleShop() { if (shopOpen) closeShop(); else openShop(); }

  /* B / Esc 原生监听（仅当本图实现了 __shop） */
  function bindShopKeys() {
    if (bindShopKeys.done) return; bindShopKeys.done = true;
    window.addEventListener('keydown', e => {
      if (e.__shopHandled) return;                 /* 地图页已处理 → 不重复切换 */
      if (e.code === 'KeyB') {
        if (!shopAvailable()) return;
        if (chatOpen) return;
        if (!shopOpen && spectating) return;
        e.__shopHandled = true;
        e.preventDefault(); toggleShop(); return;
      }
      if (e.code === 'Escape' && shopOpen) { e.preventDefault(); closeShop(); }
    });
  }
  /* 暴露给地图页原生 B 键处理器（避免双触发） */
  window.__shopToggle = () => toggleShop();

  /* 医疗兵缓慢回血（每帧） */
  function tickRegen(dt) {
    if (spectating || downed) return;
    if (!CLASS_CSS(myClass).regen) return;
    if (hp < 100) {
      const prev = hp; hp = Math.min(100, hp + 3 * dt);
      if (window.__revived && Math.round(prev) !== Math.round(hp)) { /* 由地图页同步；此处仅兜底 */ }
      if (hud && typeof hud.onRegen === 'function') { try { hud.onRegen(hp); } catch (_) {} }
    }
  }

  function heartbeat() {
    /* ★ 本地 UI（雷达 / 技能 CD / 职业提示 / 医疗兵回血）在单人下也要推进 */
    const dt = Math.min(0.05, (performance.now() - (heartbeat.__last || performance.now())) / 1000);
    heartbeat.__last = performance.now();
    try { tickSkillCd(dt); tickClassPrompt(); } catch (_) {}
    try { drawRadar(); } catch (_) {}
    if (state.active) {
      try {
        const pose = readLocalPose();
        if (pose) P2P.setLocal(pose);
        syncAvatars();
        animateAvatars();
        /* ★ §3.1 濒死倒计时 + 救援进度 */
        tickDown(dt);
        tickRevive(dt);
        tickRegen(dt);
        updateDownHint();
        updateReviveBtn();
        _lastPos.x = localPos().x; _lastPos.z = localPos().z;
        /* ★ §3.4 聊天淡出重绘 */
        renderChat();
        /* ★ §4 商店：打开时每帧刷新（余额/可购买态随战斗变化） */
        if (shopOpen && shopAvailable()) refreshShop();
        for (let i = tracers.length - 1; i >= 0; i--) {
          const t = tracers[i];
          t.life -= 0.08;
          t.line.material.opacity = t.life;
          if (t.life <= 0) { if (t.line.parent) t.line.parent.remove(t.line); tracers.splice(i, 1); }
        }
      } catch (err) {
        if (!heartbeat.__err) { heartbeat.__err = true; console.error('[MP] heartbeat error:', err); }
      }
    } else {
      /* ★ 单人：医疗兵被动回血同样生效 */
      try { tickRegen(dt); } catch (_) {}
      try { if (shopOpen && shopAvailable()) refreshShop(); } catch (_) {}
    }
    requestAnimationFrame(heartbeat);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    hookRenderer();
    requestAnimationFrame(heartbeat);
    /* ★ §15.11 先装配本地 UI（单人 / 联机共用，必须早于任何 return） */
    try { initLocalUi(); } catch (e) { console.error('[MP] initLocalUi:', e); }
    if (!MODE || !CODE) return;                     /* ★ 单人：到此为止（小地图/商店/职业已就绪） */
    if (!window.P2P) { badge('❌ 联机模块未加载', true); return; }
    badge(MODE === 'host' ? '联机 · 房主建立对局中…' : '联机 · 连接房间 ' + CODE + '…');
    try { await P2P.enterGame({ code: CODE, isHost: MODE === 'host', name: NAME }); state.active = true; }
    catch (e) { badge('❌ 联机失败: ' + (e.type || e.message || e), true); return; }

    P2P.on('shot', d => { if (d && d.s) spawnTracer(d.s.x, d.s.y || 1.6, d.s.z, d.s.ry || 0); });
    P2P.on('host-lost', () => { hostLost = true; badge('⚠ 与房主断线', true); });

    /* ★ §3.4 聊天：收到任意端发言 → 入栈渲染 */
    P2P.on('chat', d => {
      if (!d) return;
      pushChat({ name: d.name || '玩家', text: d.text, quick: d.quick, self: d.id === (P2P.info && P2P.info().id) });
    });
    /* ★ §3.1 被队友救起 → 本地恢复 */
    P2P.on('revive', d => { if (d && d.done) onRevived(0.4); });
    /* ★ §3.1 队友进入濒死 → 刷新名单/血条 */
    P2P.on('players', () => { /* 由下方 players 监听统一处理 */ });

    bindSquadKeys();
    bindShopKeys();
    /* ★ §3.2 职业由开局面板选择（单机/联机同一条路径），此处不再建侧边卡片 */
    refreshTopbarState();

    /* 丧尸快照 / 全局状态 / 命中结算 → 桥接到地图页钩子 */
    P2P.on('zombies',    snap => { refreshTeamRoster(); if (window.__zombieSync) try { window.__zombieSync(snap); } catch (_) {} });
    P2P.on('game-state', s    => { if (window.__gameSync)  try { window.__gameSync(s);    } catch (_) {} });
    P2P.on('hit-zombie', d    => { if (window.__hitZombie) try { window.__hitZombie(d);    } catch (_) {} });
    /* ★ §2.3 尸潮预警（房主广播）→ 客户端弹横幅 */
    P2P.on('horde', () => { if (window.__hordeWarn) try { window.__hordeWarn(); } catch (_) {} });

    /* ★ §0.1 房主咬中"本机（客户端）玩家" → 本地结算掉血 */
    P2P.on('hit-player', d => {
      if (!d || spectating) return;
      const dmg = +d.dmg || 0;
      if (!(dmg > 0)) return;
      if (typeof window.__playerHurt === 'function') { try { window.__playerHurt(dmg); return; } catch (_) {} }
      hp = Math.max(0, hp - dmg);
    });

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
      /* ★ §7 联机落幕：本机写一份档案（地图页提供全局钩子） */
      if (window.__recordProfile) { try { window.__recordProfile(false); } catch (_) {} }
    });

    /* ★ §5.1 有限防守胜利（房主广播）→ 客户端弹同款面板 */
    P2P.on('victory', d => {
      showVictory(d && d.wave);
      if (hud && typeof hud.onVictory === 'function') { try { hud.onVictory(d && d.wave); } catch (_) {} }
      /* ★ §7 联机通关：本机写一份档案 */
      if (window.__recordProfile) { try { window.__recordProfile(true); } catch (_) {} }
    });

    /* 统一重开 */
    P2P.on('restart', d => {
      hideAllDead();
      hideVictory();
      exitSpectate();
      if (window.__clearAllZombies) try { window.__clearAllZombies(); } catch (_) {}
      if (window.resetMatch) try { window.resetMatch(d); } catch (_) {}
      if (hud && typeof hud.onRestart === 'function') { try { hud.onRestart(d); } catch (_) {} }
      refreshTeamRoster();
      /* ★ §3.2 新一局 → 重新选职业（解锁 + 清 CD） */
      resetClassRound();
    });

    refreshTeamRoster();
    updateBadge();
    refreshTopbarState();
  }

  /* ★ §3.2 新一局：解锁职业选择（resetMatch 后调用） */
  function resetClassRound() {
    classPicked = false;
    skillCd = 0;
    const el = document.getElementById('mp-class-start');
    if (el) el.style.display = 'none';
    refreshClassHud(); refreshTopbarState();
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

  /* ============================================================
   * ★ §5.1 有限防守：胜利结算面板（房主权威判定，广播 victory）
   * ============================================================ */
  function showVictory(wave) {
    let el = document.getElementById('mp-victory');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-victory';
      el.style.cssText = 'position:fixed;inset:0;z-index:99996;display:flex;align-items:center;'
        + 'justify-content:center;background:rgba(6,14,10,.84);backdrop-filter:blur(3px)';
      el.innerHTML = '<div style="text-align:center;font:700 22px system-ui;color:#9fe8c1;letter-spacing:2px">'
        + '<div style="font-size:44px;margin-bottom:10px">🏆 防守成功</div>'
        + '<div id="mp-victory-sub" style="font-size:14px;color:#c3e8d5;font-weight:500;margin-bottom:18px"></div>'
        + '<div style="font-size:13px;color:#8a93a3;font-weight:500">正在重新开局…</div></div>';
      document.body.appendChild(el);
    }
    const sub = el.querySelector('#mp-victory-sub');
    if (sub) sub.textContent = '全员坚守 ' + (wave || '?') + ' 波 · 校园守住了';
    el.style.display = 'flex';
  }
  function hideVictory() {
    const el = document.getElementById('mp-victory');
    if (el) el.style.display = 'none';
  }
  /* 房主：广播胜利（客户端收到后弹同款面板） */
  function broadcastVictory(wave) {
    try { if (window.P2P && P2P.broadcastVictory) P2P.broadcastVictory(wave); } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    setHP: v => { hp = v; },                        // 地图页在真实 HP 变化时调用
    getHP: () => hp,
    setHud: h => { hud = h || null; },              // 地图页注入 UI 句柄
    spectating: () => spectating,
    reportDeath: () => { if (window.P2P) P2P.reportDeath(); },
    /* ★ §2.3 尸潮：房主广播预警给客户端 */
    broadcastHorde: () => { if (window.P2P && P2P.broadcastHorde) P2P.broadcastHorde(); },
    /* ★ §3.1 救援：地图页 HP 归零时优先调用；返回 true=已转为濒死 */
    tryEnterDown: () => tryEnterDown(),
    isDowned: () => downed,
    downRemain: () => downT,
    canRevive: () => { try { return canGoDown(); } catch (_) { return false; } },
    /* ★ §3.2 职业 */
    myClass: () => myClass,
    classInfo: () => CLASS_CSS(myClass),
    setClass: cls => setClass(cls),
    classes: () => CLASSES,
    classPicked: () => classPicked,
    pickClass: cls => pickClass(cls),
    resetClassRound: () => resetClassRound(),
    promptClass: () => maybePromptClass(),
    /* ★ §3.2 主动技能 */
    useSkill: () => useSkill(),
    skillCd: () => skillCd,
    setSkillCd: v => { skillCd = Math.max(0, +v || 0); refreshClassHud(); refreshTopbarState(); },
    /* ★ §3.3 雷达（单人可用） */
    _radarPoint: radarPoint,
    toggleRadar: () => toggleRadar(),
    radarCollapsed: () => radarCollapsed,
    setRadarCollapsed: v => setRadarCollapsed(v),
    /* ★ §3.3 雷达半径（常量，供单测） */
    RADAR_R: () => RADAR_R,
    RADAR_SIZE: () => RADAR_SIZE,
    /* ★ §3.1 救援时长常量（供单测） */
    REVIVE_TIME: () => REVIVE_TIME,
    MEDIC_REVIVE_TIME: () => MEDIC_REVIVE_TIME,
    /* ★ §15.11 本地 UI 装配（单人也在 boot 内自动调用） */
    initLocalUi: () => initLocalUi(),
    buildTopbar: () => buildTopbar(),
    /* ★ 游戏菜单（左上角三条杠，不暂停） */
    openGameMenu: () => openGameMenu(),
    closeGameMenu: () => closeGameMenu(),
    gameMenuOpen: () => gameMenuOpen,
    returnToMainMenu: () => returnToMainMenu(),
    /* ★ §3.4 聊天 */
    chatOpen: () => chatOpen,
    openChat: () => openChat(),
    sendChat: (t, q) => sendChatText(t, q),
    /* ★ §4 商店 */
    shopOpen: () => shopOpen,
    openShop: () => openShop(),
    closeShop: () => closeShop(),
    toggleShop: () => toggleShop(),
    /* ★ §5.1 胜利结算 */
    showVictory: w => showVictory(w),
    hideVictory: () => hideVictory(),
    broadcastVictory: w => broadcastVictory(w),
    /* ★ §0.1 房主侧丧尸索敌用：返回可作为目标的远端玩家列表（y 为脚底世界高度） */
    peerTargets: () => Array.from(avatars.entries()).map(([id, a]) => {
      const p = a.group ? a.group.position : null;
      return { id, x: p ? p.x : 0, y: p ? p.y : 0, z: p ? p.z : 0, alive: a.alive !== false };
    }),
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
