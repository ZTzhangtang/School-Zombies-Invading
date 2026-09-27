/* ============================================================
 * touch-ui.js —— 触屏按钮「统一布局 + 自定义位置」模块
 *
 * 解决的问题：
 *   1. 三张地图的触屏按钮各不相同（map1 有 6 个，map2/map3 只有 3 个）
 *   2. 按钮位置写死在 CSS 里，手机上够不到 / 挡视野，玩家无法自行调整
 *
 * 本模块提供：
 *   · 一套统一的 6 个按钮定义（开火/疾跑/换弹/瞄准/手雷/换枪）
 *   · 位置以【视口百分比】存储，跨手机尺寸一致
 *   · localStorage 持久化（键名 zs_ui），三张地图 + index 设置页共用
 *   · index 设置页可拖拽调整；地图内直接读取生效
 *
 * 坐标约定：
 *   pos = { x: 0..100, y: 0..100 }  表示按钮【中心】在视口中的百分比位置
 *   x=92 → 靠右, y=88 → 靠下
 *
 * 对外 API：
 *   TouchUI.ACTIONS            按钮定义数组
 *   TouchUI.baseSize()         当前屏幕下按钮基准像素（随屏宽自适应）
 *   TouchUI.get(action)        取某动作的位置（含默认回退）
 *   TouchUI.set(action, x, y)  写位置并保存
 *   TouchUI.resetAll()         恢复全部默认
 *   TouchUI.apply(scopeEl)     把位置套用到已存在的 [data-tbtn] 元素上
 *   TouchUI.watch(scopeEl)     监听窗口尺寸变化自动重算
 * ============================================================ */
window.TouchUI = (function () {
  'use strict';

  var LS = 'zs_ui';

  /* ---------- 统一按钮定义 ----------
   * action  : 逻辑动作名（与 keys.js 一致，便于语义对齐）
   * id      : 地图页里按钮的 DOM id
   * label   : 按钮显示文字
   * kind    : fire=大圆键 / normal=普通圆键
   * def     : 默认中心位置（视口百分比）；按右手拇指可及的右下弧线排布
   */
  var ACTIONS = [
    { action: 'fire',   id: 'tbtn-fire',   label: 'FIRE', kind: 'fire',   def: { x: 88, y: 84 } },
    { action: 'aim',    id: 'tbtn-aim',    label: '瞄准', kind: 'normal', def: { x: 88, y: 62 } },
    { action: 'reload', id: 'tbtn-reload', label: '换弹', kind: 'normal', def: { x: 70, y: 78 } },
    { action: 'nade',   id: 'tbtn-nade',   label: '手雷', kind: 'normal', def: { x: 62, y: 92 } },
    { action: 'swap',   id: 'tbtn-swap',   label: '换枪', kind: 'normal', def: { x: 74, y: 92 } },
    { action: 'sprint', id: 'tbtn-sprint', label: '疾跑', kind: 'normal', def: { x: 58, y: 64 } }
  ];

  var byAction = {};
  ACTIONS.forEach(function (a) { byAction[a.action] = a; });

  /* ---------- 读取 / 保存 ---------- */
  var map = {};                                   // action -> {x,y}
  function load() {
    map = {};
    ACTIONS.forEach(function (a) { map[a.action] = { x: a.def.x, y: a.def.y }; });
    try {
      var raw = JSON.parse(localStorage.getItem(LS) || '{}');
      for (var k in raw) {
        if (!byAction[k]) continue;
        var v = raw[k];
        if (v && typeof v.x === 'number' && typeof v.y === 'number') {
          map[k] = { x: clamp(v.x, 0, 100), y: clamp(v.y, 0, 100) };
        }
      }
    } catch (_) {}
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(map)); } catch (_) {} }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function get(action) {
    var d = byAction[action];
    if (!d) return null;
    var p = map[action];
    return p ? { x: p.x, y: p.y } : { x: d.def.x, y: d.def.y };
  }
  function set(action, x, y) {
    if (!byAction[action]) return;
    map[action] = { x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
    save();
  }
  function resetOne(action) {
    var d = byAction[action];
    if (d) { map[action] = { x: d.def.x, y: d.def.y }; save(); }
  }
  function resetAll() {
    ACTIONS.forEach(function (a) { map[a.action] = { x: a.def.x, y: a.def.y }; });
    save();
  }

  /* ---------- 尺寸：基准像素随屏宽自适应（和旧 CSS 变量保持一致的量级） ---------- */
  function baseSize() {
    var w = (window.innerWidth || 375);
    if (w < 380) return { normal: 50, fire: 72 };
    if (w < 520) return { normal: 54, fire: 78 };
    if (w < 820) return { normal: 58, fire: 84 };
    return { normal: 60, fire: 86 };
  }

  /* ---------- 把位置套用到元素 ---------- */
  function applyEl(el, action) {
    if (!el) return;
    var p = get(action);
    if (!p) return;
    var d = byAction[action];
    var sz = baseSize();
    var px = (d.kind === 'fire') ? sz.fire : sz.normal;
    el.style.left = p.x + '%';
    el.style.top = p.y + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.width = px + 'px';
    el.style.height = px + 'px';
    el.style.transform = 'translate(-50%, -50%)';
  }

  /* scopeEl 可为 document 或某个容器 */
  function apply(scopeEl) {
    load();
    var root = scopeEl || document;
    ACTIONS.forEach(function (a) {
      var el = root.querySelector('[data-tbtn="' + a.action + '"]') || document.getElementById(a.id);
      if (el) {
        el.setAttribute('data-tbtn', a.action);
        applyEl(el, a.action);
      }
    });
  }

  var watching = false;
  function watch(scopeEl) {
    if (watching) return;
    watching = true;
    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t); t = setTimeout(function () { apply(scopeEl); }, 120);
    });
    window.addEventListener('orientationchange', function () {
      clearTimeout(t); t = setTimeout(function () { apply(scopeEl); }, 200);
    });
  }

  load();

  return {
    ACTIONS: ACTIONS,
    byAction: byAction,
    baseSize: baseSize,
    get: get, set: set, resetOne: resetOne, resetAll: resetAll,
    load: load, save: save,
    apply: apply, applyEl: applyEl, watch: watch
  };
})();
