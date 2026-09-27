/* ============================================================
 * settings.js — 生化·校园突围 跨地图统一设置
 *
 * index.html 写入的设置此前只有主菜单自己用，进图后全部失效。
 * 本模块让每张地图启动时调用 Settings.apply(gameCtx) 真正生效。
 *
 * 存储在 localStorage.zs_cfg（与 index.html 同一份）：
 *   { quality:'auto|low|mid|high', sens:1, vol:70, refl:true, fps:false }
 *
 * 地图页模板：
 *   Settings.apply({
 *     applyQuality:(level)=>{...},   // 可选：自定义画质应用
 *     getSens:()=>baseSens,          // 可选：返回基准灵敏度系数
 *     setSens:(v)=>{...},            // 可选：写回灵敏度
 *     getAudio:()=>AudioCtx,         // 可选：返回 AudioContext（用于音量）
 *     setRefl:(on)=>{...},           // 可选：开关湿地反射
 *     setFps:(on)=>{...}             // 可选：开关 FPS 显示
 *   });
 * ============================================================ */
window.Settings = (function () {
  'use strict';

  const LS = 'zs_cfg';
  const DEF = { map: 'map1', quality: 'auto', sens: 1, vol: 70, refl: true, fps: false };

  let cfg = Object.assign({}, DEF);

  function load() {
    try { cfg = Object.assign({}, DEF, JSON.parse(localStorage.getItem(LS) || '{}')); }
    catch (_) { cfg = Object.assign({}, DEF); }
    return cfg;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (_) {} }
  function get() { return cfg; }
  function set(k, v) { cfg[k] = v; save(); }

  /* 画质档 → 数值等级（低=0 中=1 高=2）；auto 交给地图自身的动态降质 */
  function qualityLevel() {
    switch (cfg.quality) {
      case 'low':  return 0;
      case 'mid':  return 1;
      case 'high': return 2;
      default:     return -1;            // auto
    }
  }

  /* 音量：0~100 → 0~1 */
  function volume() { return Math.max(0, Math.min(1, (+cfg.vol || 0) / 100)); }

  /* 灵敏度：设置值直接作为倍率 */
  function sens() { return Math.max(0.1, +cfg.sens || 1); }

  /* 把设置应用到当前地图。ctx 为可选回调集合 */
  function apply(ctx) {
    ctx = ctx || {};
    load();

    /* ① 画质 */
    const lv = qualityLevel();
    if (typeof ctx.applyQuality === 'function') {
      try { ctx.applyQuality(lv, cfg.quality); } catch (_) {}
    } else if (lv >= 0 && typeof window.applyQuality === 'function') {
      try { window.applyQuality(lv); } catch (_) {}
    }
    if (lv >= 0) window.__cfgQuality = lv; else window.__cfgQuality = null;

    /* ② 鼠标灵敏度 */
    window.__cfgSens = sens();
    if (typeof ctx.setSens === 'function') { try { ctx.setSens(sens()); } catch (_) {} }

    /* ③ 音量 */
    if (typeof ctx.getAudio === 'function') {
      try {
        const ac = ctx.getAudio();
        if (ac) window.__cfgGain = installGain(ac);
      } catch (_) {}
    }

    /* ④ 湿地反射 */
    if (typeof ctx.setRefl === 'function') { try { ctx.setRefl(!!cfg.refl); } catch (_) {} }
    window.__cfgRefl = !!cfg.refl;

    /* ⑤ FPS 显示 */
    if (typeof ctx.setFps === 'function') { try { ctx.setFps(!!cfg.fps); } catch (_) {} }
    window.__cfgFps = !!cfg.fps;
    applyFpsVisibility(!!cfg.fps);

    return cfg;
  }

  /* ---------- 音量：在 AudioContext 上装一个 master gain ---------- */
  function installGain(ac) {
    if (!ac || ac.__cfgGain) return ac && ac.__cfgGain;
    try {
      const g = ac.createGain();
      g.gain.value = volume();
      g.connect(ac.destination);
      /* 之后所有 source 都改接 g（地图代码里多为 source.connect(AC.destination)），
         这里无法拦截既有连接，故同时暴露 gain，由地图侧在创建时使用 */
      ac.__cfgGain = g;
    } catch (_) {}
    return ac && ac.__cfgGain;
  }

  /* ---------- FPS 显示 ---------- */
  function applyFpsVisibility(on) {
    const ids = ['fps', 'footer', 'fpsBox'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = on ? '' : 'none';
    });
  }

  /* 监听 index 设置页变更（同源同窗口不会触发，跨窗口会） */
  window.addEventListener('storage', e => {
    if (e.key === LS) { load(); if (window.__cfgLiveApply) try { window.__cfgLiveApply(cfg); } catch (_) {} }
  });

  load();

  return {
    DEF, load, save, get, set, apply,
    qualityLevel, volume, sens,
    applyFpsVisibility, installGain,
    refresh: load
  };
})();
