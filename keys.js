/* ============================================================
 * keys.js — 生化·校园突围 统一键位系统
 *
 * 三张地图共用同一套键位表（默认照搬 map1 风格）：
 *   W/A/S/D  移动        Shift  疾跑
 *   F        开火        右键   开镜
 *   R        换弹        1 / 2  切换武器
 *   G        手雷        E      交互/救援
 *   T        聊天        Q      快捷指令
 *
 * 用法：
 *   Keys.actionOf(e.code)   → 动作名 或 null
 *   Keys.isDown(action)     → 该动作当前是否按下
 *   Keys.set(action, code)  / Keys.resetAll()  / Keys.on(cb)
 *   Keys.bindInput()        → 地图页调用一次，自动维护按下状态并派发事件
 *
 * 配置存 localStorage.zs_keys
 * ============================================================ */
window.Keys = (function () {
  'use strict';

  /* 动作定义：顺序即设置页展示顺序 */
  const ACTIONS = [
    { key: 'forward', label: '前进',      def: 'KeyW',          group: '移动' },
    { key: 'back',    label: '后退',      def: 'KeyS',          group: '移动' },
    { key: 'left',    label: '左移',      def: 'KeyA',          group: '移动' },
    { key: 'right',   label: '右移',      def: 'KeyD',          group: '移动' },
    { key: 'sprint',  label: '疾跑',      def: 'ShiftLeft',     group: '移动' },
    { key: 'fire',    label: '开火',      def: 'KeyF',          group: '战斗' },
    { key: 'reload',  label: '换弹',      def: 'KeyR',          group: '战斗' },
    { key: 'w1',      label: '武器 1',    def: 'Digit1',        group: '战斗' },
    { key: 'w2',      label: '武器 2',    def: 'Digit2',        group: '战斗' },
    { key: 'w3',      label: '武器 3',    def: 'Digit3',        group: '战斗' },
    { key: 'w4',      label: '武器 4',    def: 'Digit4',        group: '战斗' },
    { key: 'w5',      label: '武器 5',    def: 'Digit5',        group: '战斗' },
    { key: 'w6',      label: '武器 6',    def: 'Digit6',        group: '战斗' },
    { key: 'nade',    label: '手雷',      def: 'KeyG',          group: '战斗' },
    { key: 'interact',label: '交互/救援', def: 'KeyE',          group: '战斗' },
    { key: 'chat',    label: '聊天',      def: 'KeyT',          group: '社交' },
    { key: 'order',   label: '快捷指令',  def: 'KeyQ',          group: '社交' }
  ];

  /* 所有武器槽动作（w1~w6）：用于统一做 preventDefault 判定 */
  const WP_ACTIONS = ACTIONS.filter(a => /^w[1-9]$/.test(a.key)).map(a => a.key);

  /* 疾跑额外允许 ShiftRight，两键同义 */
  const ALIAS = { sprint: ['ShiftLeft', 'ShiftRight'] };

  const LS = 'zs_keys';
  let map = {};                                  // action → code
  const down = {};                               // action → bool

  /* ---------- 读取 / 保存 ---------- */
  function defaults() {
    const m = {};
    ACTIONS.forEach(a => { m[a.key] = a.def; });
    return m;
  }
  function load() {
    map = defaults();
    try {
      const raw = JSON.parse(localStorage.getItem(LS) || '{}');
      for (const k in raw) if (k in map && typeof raw[k] === 'string') map[k] = raw[k];
    } catch (_) {}
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(map)); } catch (_) {} }

  /* code → 该 code 对应的所有动作（含别名） */
  function actionsOfCode(code) {
    const out = [];
    for (const a of ACTIONS) {
      const codes = ALIAS[a.key] || [map[a.key]];
      if (codes.indexOf(code) >= 0) out.push(a.key);
    }
    return out;
  }

  /* ---------- 事件派发 ---------- */
  const handlers = [];                            // { action, type:'down'|'up', fn }
  function on(action, type, fn) { handlers.push({ action, type, fn }); }
  function fire(action, type, code) {
    for (let i = 0; i < handlers.length; i++) {
      const h = handlers[i];
      if (h.action === action && h.type === type) {
        try { h.fn(code); } catch (_) {}
      }
    }
  }

  function setDown(action, v, code) {
    if (down[action] === v) return;
    down[action] = v;
    fire(action, v ? 'down' : 'up', code);
  }

  /* 同一动作可能有多个 code（如 Shift 左右）；用引用计数避免松开一个就误判为抬起 */
  const held = Object.create(null);               // code → count
  const holdCount = Object.create(null);          // action → count

  /* ---------- 对外：按下状态 ---------- */
  function isDown(action) { return !!down[action]; }
  function anyDown() {
    for (const k in down) if (down[k]) return true;
    return false;
  }

  /* ---------- 对外：键位读写 ---------- */
  function code(action) { return map[action]; }
  function actionOf(c) { const a = actionsOfCode(c); return a.length ? a[0] : null; }
  function set(action, c) {
    if (!(action in map) || !c) return;
    map[action] = c; save();
  }
  function resetAll() { map = defaults(); save(); }
  function resetOne(action) { map[action] = defaults()[action]; save(); }

  /* 键名 → 展示文案（给设置页用） */
  function pretty(c) {
    if (!c) return '—';
    if (/^Key([A-Z])$/.test(c)) return c.slice(3);
    if (/^Digit(\d)$/.test(c)) return c.slice(5);
    if (/^Numpad(\d)$/.test(c)) return '小键盘' + c.slice(6);
    if (c === 'ShiftLeft') return '左 Shift';
    if (c === 'ShiftRight') return '右 Shift';
    if (c === 'Space') return '空格';
    if (c === 'ControlLeft') return '左 Ctrl';
    if (c === 'AltLeft') return '左 Alt';
    if (c === 'ArrowUp') return '↑';
    if (c === 'ArrowDown') return '↓';
    if (c === 'ArrowLeft') return '←';
    if (c === 'ArrowRight') return '→';
    return c;
  }

  /* 冲突检测：返回与该 code 冲突的其它动作 label 数组 */
  function conflicts(action, c) {
    const out = [];
    for (const a of ACTIONS) {
      if (a.key === action) continue;
      const codes = ALIAS[a.key] || [map[a.key]];
      if (codes.indexOf(c) >= 0) out.push(a.label);
    }
    return out;
  }

  /* ---------- 自动接线：地图页调用一次 ---------- */
  let inputBound = false;
  function bindInput(opts) {
    if (inputBound) return;
    inputBound = true;
    opts = opts || {};
    /* 忽略在输入框里的按键 */
    const typing = e => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };

    window.addEventListener('keydown', function (e) {
      if (typing(e)) return;
      const acts = actionsOfCode(e.code);
      if (!acts.length) return;
      held[e.code] = (held[e.code] || 0) + 1;
      acts.forEach(a => {
        holdCount[a] = (holdCount[a] || 0) + 1;
        setDown(a, true, e.code);
      });
      /* 阻止数字键换枪时的浏览器默认（部分环境会切标签）与空格滚动 */
      if (acts.some(a => WP_ACTIONS.indexOf(a) >= 0)) e.preventDefault();
    });

    window.addEventListener('keyup', function (e) {
      const acts = actionsOfCode(e.code);
      if (!acts.length) return;
      acts.forEach(a => {
        holdCount[a] = Math.max(0, (holdCount[a] || 1) - 1);
        if (holdCount[a] === 0) setDown(a, false, e.code);
      });
      held[e.code] = Math.max(0, (held[e.code] || 1) - 1);
    });

    /* 失焦时清空全部按下状态，避免"卡住" */
    window.addEventListener('blur', function () {
      for (const a in down) if (down[a]) setDown(a, false, null);
      for (const k in holdCount) holdCount[k] = 0;
    });
  }

  load();

  return {
    ACTIONS, defaults, load, save,
    code, actionOf, actionsOfCode, set, resetAll, resetOne,
    isDown, anyDown, pretty, conflicts,
    on, bindInput,
    /* 便捷：注册某动作按下时的回调 */
    onDown: (action, fn) => on(action, 'down', fn),
    onUp:   (action, fn) => on(action, 'up',   fn),
    WP_ACTIONS
  };
})();
