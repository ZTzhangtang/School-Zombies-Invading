/* ============================================================
 * bgm.js —— 生化·校园突围 背景音乐（随机轮播版）
 *
 * 与 settings.js / profile.js 并列的「三图共用」模块。
 * 播放 sounds/ 下的三首曲目，随机选曲、一首播完自动换下一首，
 * 全程淡入淡出避免爆音。
 *
 * 曲目来源（在下方 TRACKS 数组里增删，改成更多首都不用动其他逻辑）：
 *   sounds/bgm0.mp3
 *   sounds/bgm1.mp3
 *   ...
 * 换成你自己的音频时，保持 sounds/ 目录、bgmN.mp3 命名，直接覆盖即可。
 *
 * 对外 API（与既有调用方完全兼容）：
 *   BGM.attach(() => AudioContext)  可选：复用地图页 / 菜单页的音频上下文
 *   BGM.set('calm'|'combat'|...)     场景层标记（用于调整音量倾向）
 *   BGM.on() / off() / toggle()      开关
 *   BGM.setVolume(0..1)              音量，与设置页滑杆联动
 *   BGM.next()                        手动切到下一首（随机挑）
 *
 * 持久化：localStorage.zs_bgm = { on:boolean, vol:number }
 *
 * 说明：为了让音量能挂到页面已有的 AudioContext 上，内部用
 * HTMLAudioElement + MediaElementAudioSourceNode 播放，并通过
 * 自己的 gain 节点做淡入淡出。若页面尚未提供上下文（例如菜单页
 * 还没点过任何按钮），会先挂起，等首次 attach / 用户交互后再启动。
 * ============================================================ */
window.BGM = (function () {
  'use strict';

  const LS = 'zs_bgm';
  const DIR = 'sounds/';
  const FADE = 1.1;          // 淡入淡出时长（秒）
  const GAP  = 0.35;         // 换曲间隔（秒），让切换有呼吸感
  const BASE = {             // 各场景层的基础音量
    calm: 0.42, combat: 0.50, horde: 0.58, down: 0.44
  };

  /* ---------- 持久化 ---------- */
  let enabled = true, vol = 0.7;
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || '{}');
    if (typeof raw.on === 'boolean') enabled = raw.on;
    if (typeof raw.vol === 'number') vol = Math.max(0, Math.min(1, raw.vol));
  } catch (_) {}

  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ on: enabled, vol: vol })); } catch (_) {}
  }

  /* ---------- 曲目清单 ----------
     在此数组里增删即可，加入更多曲目不需要改其他逻辑。
     缺失的文件会在加载时报错并被自动剔除，不会让整个轮播卡死。 */
  const TRACKS = [];
  for (let i = 0; i < 6; i++) TRACKS.push({ n: i, src: DIR + 'bgm' + i + '.mp3' });

  let cursor = -1;            // 当前曲目下标
  let layer = 'calm';         // 当前场景层
  let AC = null;
  let userCtxGetter = null;
  let gain = null;            // 淡入淡出用的 gain 节点
  let el = null;              // HTMLAudioElement
  let src = null;             // MediaElementAudioSourceNode
  let userPaused = false;     // 浏览器自动播放拦截时的等待标记
  let ready = false;          // 是否已具备播放条件
  let token = 0;              // 切歌令牌，防止过期的异步回调改写 el.src
  let manual = false;       // 下一次 next() 是否跳过 GAP（首启/手动切歌用）

  /* ---------- 音频上下文 ---------- */
  function ctx() {
    if (!AC) {
      try {
        if (userCtxGetter) AC = userCtxGetter() || null;
      } catch (_) {}
      if (!AC) {
        try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
      }
    }
    if (AC && AC.state === 'suspended') { try { AC.resume(); } catch (_) {} }
    return AC;
  }

  /* ---------- 构建播放链 ---------- */
  function build() {
    if (ready) return ready;
    const a = ctx();
    if (!a) return false;
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      el.loop = false;                 // 关键：播完由 ended 事件驱动换曲
      el.crossOrigin = 'anonymous';
      el.addEventListener('ended', onEnded);
      el.addEventListener('error', onError);
      // 部分浏览器（Safari）需要 inline 播放才不拦截，交给 play() 的 catch 处理
      try { el.volume = 1; } catch (_) {}
    }
    if (!gain) {
      gain = a.createGain();
      gain.gain.value = 0;
      try {
        src = a.createMediaElementSource(el);
        src.connect(gain);
      } catch (_) {
        /* createMediaElementSource 对同一个元素只能调一次，失败则退回元素自身音量 */
        src = null;
      }
      gain.connect(a.destination);
    }
    ready = true;
    return true;
  }

  function targetVol() {
    return (enabled ? vol : 0) * (BASE[layer] || BASE.calm);
  }

  /* ---------- 换曲 ---------- */
  function pickNext() {
    if (!TRACKS.length) return -1;
    /* 纯随机：在剩余曲目里等概率取一首 */
    let i = Math.floor(Math.random() * TRACKS.length);
    if (i === cursor && TRACKS.length > 1) {
      i = Math.floor(Math.random() * (TRACKS.length - 1));
      if (i >= cursor) i++;
    }
    return i;
  }

  function onEnded() {
    if (!enabled) return;
    /* 间隔由 next() 内部的 fadeOut + GAP 统一控制，这里直接切 */
    next();
  }

  function onError() {
    /* 单个文件缺失/解码失败时跳过它，避免整个轮播卡死 */
    if (!el) return;
    /* el.src 已是绝对 URL，用 href 与 TRACKS 的相对 src 对齐比较 */
    const badHref = el.src;
    const i = TRACKS.findIndex(t => {
      try { return new URL(t.src, location.href).href === badHref; } catch (_) { return false; }
    });
    if (i >= 0) TRACKS.splice(i, 1);
    if (i === cursor) cursor = -1;
    if (!TRACKS.length) { stop(); return; }
    next();
  }

  function next() {
    if (!enabled) return;
    if (!build()) return;
    const i = pickNext();
    if (i < 0) return;
    cursor = i;
    const t = TRACKS[i];

    /* 令牌机制：丢弃过期的回调，避免快速连点导致多个回调同时改 src */
    const my = ++token;

    /* 节奏 = 淡出(FADE) + 间隔(GAP)。手动切歌/首启不额外等待 GAP。 */
    const wait = manual ? 0 : GAP * 1000;
    manual = false;                     // 用完即复位，后续自动续播恢复间隔
    fadeOut(() => {
      if (my !== token) return;         // 已有更新的切歌请求，放弃本次
      el.src = t.src;
      const p = el.play();
      if (p && p.catch) {
        p.catch(() => {
          /* 自动播放被拦截：等用户第一次交互再试 */
          userPaused = true;
          armUnlock();
        });
      } else {
        userPaused = false;
      }
      fadeIn();
    }, wait);
  }

  /* ---------- 淡入淡出 ---------- */
  function fadeIn() {
    if (!gain) return;
    const a = ctx(); if (!a) return;
    const t = a.currentTime;
    const tv = targetVol();
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(tv, t + FADE);
    } catch (_) {}
  }

  function fadeOut(done, extraMs) {
    if (!gain) { if (done) setTimeout(done, extraMs || 0); return; }
    const a = ctx();
    if (!a) { if (done) setTimeout(done, extraMs || 0); return; }
    const t = a.currentTime;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + FADE);
    } catch (_) {}
    if (done) setTimeout(done, FADE * 1000 + (extraMs || 0));
  }

  /* ---------- 自动播放解锁 ----------
     浏览器的自动播放策略会拦掉无手势的 play()。此时挂起，
     等用户第一次交互（点击/触摸/按键）后再重试。 */
  let unlockArmed = false;
  let unlockHandler = null;

  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    unlockHandler = function () {
      disarmUnlock();
      if (!enabled) return;
      if (!build()) return;
      if (!el || !el.src) return;
      const p = el.play();
      if (p && p.then) {
        p.then(() => { userPaused = false; fadeIn(); }).catch(() => {});
      } else {
        userPaused = false; fadeIn();
      }
    };
    ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
      document.addEventListener(ev, unlockHandler, { passive: true }));
  }

  function disarmUnlock() {
    if (!unlockArmed || !unlockHandler) return;
    unlockArmed = false;
    ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
      document.removeEventListener(ev, unlockHandler));
    unlockHandler = null;
  }

  /* ---------- 对外接口 ---------- */
  function on() {
    enabled = true; save();
    if (!ready) { manual = true; next(); return; }
    if (el && el.src && el.paused) {
      const p = el.play();
      if (p && p.catch) p.catch(() => { userPaused = true; armUnlock(); });
    } else if (!el || !el.src || el.ended) {
      manual = true; next();
    } else {
      fadeIn();
    }
  }

  function off() {
    enabled = false; save();
    ++token;                        // 作废进行中的切歌回调
    manual = true;
    disarmUnlock();
    fadeOut(() => { try { if (el) el.pause(); } catch (_) {} });
  }

  function toggle() { enabled ? off() : on(); return enabled; }

  function stop() {
    ++token;
    disarmUnlock();
    manual = true;
    /* 先淡出再彻底释放；并复位 ready/gain，保证下次 on() 能重建播放链 */
    fadeOut(() => {
      releaseEl();
      ready = false; gain = null; src = null; el = null;
    });
  }

  function set(name) {
    const n = (name === 'combat' || name === 'horde' || name === 'down') ? name : 'calm';
    /* 游戏主循环每帧都会调用，这里必须幂等：同层不重复触发淡入斜坡 */
    if (n === layer) return;
    layer = n;
    if (enabled && ready) fadeIn();
  }

  function setVolume(v) {
    const nv = Math.max(0, Math.min(1, +v || 0));
    if (Math.abs(nv - vol) < 0.001) return;   // 幂等：避免重复淡入
    vol = nv;
    save();
    if (enabled && ready) fadeIn();
  }

  function attach(getter) {
    if (typeof getter === 'function') {
      userCtxGetter = getter;
      /* 上下文换了 → 重建链路。先释放旧元素，避免监听器泄漏 */
      releaseEl();
      ready = false; gain = null; src = null; el = null;
      userPaused = false;
      manual = true;                  // 首次启动立即播，不等间隔
    }
    if (!ctx()) return false;
    if (enabled && build()) { next(); return true; }
    return ready;
  }

  /* 解除旧音频元素的监听器并停止播放 */
  function releaseEl() {
    if (!el) return;
    try {
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch (_) {}
  }

  /* 手动切歌：立即跳到下一首（不叠加自动续播的间隔） */
  function nextManual() {
    manual = true;
    next();
  }

  /* 提供 list 供调试 / 后续 UI 展示曲库 */
  function list() { return TRACKS.map(t => t.src); }

  return {
    LS: LS,
    LAYERS: ['calm', 'combat', 'horde', 'down'],
    VOL: BASE,
    attach: attach,
    set: set,
    on: on, off: off, toggle: toggle,
    isOn: () => enabled,
    volume: () => vol,
    setVolume: setVolume,
    current: () => (cursor >= 0 ? TRACKS[cursor] : null),
    currentIndex: () => cursor,
    tracks: list,
    next: nextManual,
    nextManual: nextManual,
    stop: stop,
    _ctx: () => AC,
    _gain: () => gain,
    _el: () => el,
    _token: () => token
  };
})();