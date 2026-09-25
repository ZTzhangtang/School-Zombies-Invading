/* =========================================================================
 * 雨后 · 校园操场 —— Three.js 实时渲染
 * 400m 塑胶跑道 / 足球场 / 篮球场 / 看台 / 教学楼
 * 核心：自研「湿地平面反射」着色器（投影纹理采样 + 程序化水洼 + 涟漪）
 * ★ 联机版：接入 zsync.js / mp-bridge.js / p2p.js
 * ========================================================================= */
(function () {
'use strict';

if (!window.THREE) {
  document.getElementById('fail').style.display = 'flex';
  document.getElementById('loader').style.display = 'none';
  return;
}

/* ★ 联机：全局丧尸数组（zsync.js 读这个做序列化广播/快照对齐） */
window.__zombies = window.__zombies || [];

/* ================= 基础常量 ================= */
var TRACK_L = 84.39;          // 直道长度 (m)
var TRACK_R = 36.5;           // 第 1 道内沿半径
var LANE_W = 1.22;            // 分道宽
var LANES = 8;
var TRACK_OUT = TRACK_R + LANES * LANE_W;   // 46.26
var COMPOUND = { x0: -102, x1: 144, z0: -78, z1: 68 };   // 围栏范围
var SUN_DIR = new THREE.Vector3(-0.52, 0.40, 0.34).normalize();

/* ================= 碰撞体系统（AABB，供玩家/丧尸共用） ================= */
var COLLIDERS = [];
function addCollider(x0, x1, z0, z1) {
  COLLIDERS.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
}
/* 圆(r) vs AABB 推出：返回修正后的 [x, z] */
function collideXZ(px, pz, r) {
  for (var i = 0; i < COLLIDERS.length; i++) {
    var c = COLLIDERS[i];
    var nx = Math.max(c.x0, Math.min(px, c.x1));
    var nz = Math.max(c.z0, Math.min(pz, c.z1));
    var dx = px - nx, dz = pz - nz;
    var d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-6) {
        var d = Math.sqrt(d2);
        px = nx + dx / d * r;
        pz = nz + dz / d * r;
      } else {
        var lx = Math.min(px - c.x0, c.x1 - px);
        var lz = Math.min(pz - c.z0, c.z1 - pz);
        if (lx < lz) px = (px - c.x0 < c.x1 - px) ? c.x0 - r : c.x1 + r;
        else pz = (pz - c.z0 < c.z1 - pz) ? c.z0 - r : c.z1 + r;
      }
    }
  }
  return [px, pz];
}
function insideAnyCollider(px, pz, pad) {
  for (var i = 0; i < COLLIDERS.length; i++) {
    var c = COLLIDERS[i];
    if (px > c.x0 - pad && px < c.x1 + pad && pz > c.z0 - pad && pz < c.z1 + pad) return true;
  }
  return false;
}

var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* ================= 确定性随机 ================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rng = mulberry32(20260823);

/* ================= 渲染器 ================= */
var container = document.getElementById('app');
var renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) { renderer = null; }
if (!renderer || !renderer.getContext()) {
  document.getElementById('fail').style.display = 'flex';
  document.getElementById('loader').style.display = 'none';
  return;
}
var MAX_PR = Math.min(window.devicePixelRatio || 1, isMobile ? 1.6 : 2);
renderer.setPixelRatio(MAX_PR);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.94;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

function invalidateShadows() {
  renderer.shadowMap.needsUpdate = true;
}

container.appendChild(renderer.domElement);
var MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

/* ================= 场景 / 相机 / 灯光 ================= */
var scene = new THREE.Scene();
scene.background = new THREE.Color(0xa7b5a9);
scene.fog = new THREE.Fog(0xa7b5a9, 120, 640);

var camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2600);
camera.position.set(120, 40, 150);

var sun = new THREE.DirectionalLight(0xffe3ba, 2.3);
sun.position.copy(SUN_DIR).multiplyScalar(240);
sun.castShadow = true;
var SHADOW_RES = isMobile ? 1024 : 4096;
sun.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
sun.shadow.camera.near = 40; sun.shadow.camera.far = 560;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.7;
scene.add(sun);
scene.add(sun.target);

scene.add(new THREE.HemisphereLight(0xbdd3ec, 0x46524a, 0.62));
scene.add(new THREE.AmbientLight(0x5a6b60, 0.38));

/* ================= 程序化纹理 ================= */
function makeCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function toTexture(canvas, srgb) {
  var t = new THREE.CanvasTexture(canvas);
  if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* --- 沥青地面 --- */
function texAsphalt() {
  var c = makeCanvas(512, 512), x = c.getContext('2d');
  x.fillStyle = '#3c4147'; x.fillRect(0, 0, 512, 512);
  var i, px, py, v;
  for (i = 0; i < 260; i++) {
    px = rng() * 512; py = rng() * 512;
    var r = 20 + rng() * 60;
    var g = x.createRadialGradient(px, py, 0, px, py, r);
    var d = rng() * 0.09;
    g.addColorStop(0, 'rgba(20,22,26,' + d + ')');
    g.addColorStop(1, 'rgba(20,22,26,0)');
    x.fillStyle = g; x.fillRect(px - r, py - r, r * 2, r * 2);
  }
  for (i = 0; i < 14000; i++) {
    px = rng() * 512; py = rng() * 512;
    v = 52 + rng() * 66;
    x.fillStyle = 'rgba(' + (v | 0) + ',' + ((v + 3) | 0) + ',' + ((v + 8) | 0) + ',' + (0.16 + rng() * 0.3) + ')';
    x.fillRect(px, py, 1 + rng() * 1.6, 1 + rng() * 1.6);
  }
  for (i = 0; i < 60; i++) {
    px = rng() * 512; py = rng() * 512;
    x.strokeStyle = 'rgba(16,18,21,' + (0.1 + rng() * 0.12) + ')';
    x.lineWidth = 0.7;
    x.beginPath(); x.moveTo(px, py);
    for (var j = 0; j < 5; j++) { px += (rng() - 0.5) * 26; py += (rng() - 0.5) * 26; x.lineTo(px, py); }
    x.stroke();
  }
  return toTexture(c);
}

/* --- 草皮（含修剪条纹） --- */
function texGrass() {
  var c = makeCanvas(512, 512), x = c.getContext('2d');
  x.fillStyle = '#3a7440'; x.fillRect(0, 0, 512, 512);
  x.fillStyle = 'rgba(255,255,255,0.055)'; x.fillRect(0, 0, 256, 512);
  x.fillStyle = 'rgba(0,0,0,0.06)'; x.fillRect(256, 0, 256, 512);
  var i, px, py;
  for (i = 0; i < 16000; i++) {
    px = rng() * 512; py = rng() * 512;
    var g = 88 + rng() * 52;
    x.fillStyle = 'rgba(' + ((g * 0.55) | 0) + ',' + (g | 0) + ',' + ((g * 0.5) | 0) + ',' + (0.1 + rng() * 0.25) + ')';
    x.fillRect(px, py, 1 + rng() * 2, 1 + rng() * 2.5);
  }
  for (i = 0; i < 40; i++) {
    px = rng() * 512; py = rng() * 512;
    x.fillStyle = 'rgba(18,42,22,' + (0.08 + rng() * 0.1) + ')';
    x.beginPath(); x.ellipse(px, py, 4 + rng() * 10, 3 + rng() * 6, rng() * 3, 0, 6.29); x.fill();
  }
  return toTexture(c);
}

/* --- 塑胶跑道面层 --- */
function texTrack() {
  var c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = '#ad434c'; x.fillRect(0, 0, 256, 256);
  var i, px, py;
  for (i = 0; i < 5200; i++) {
    px = rng() * 256; py = rng() * 256;
    var v = rng();
    if (v < 0.5) x.fillStyle = 'rgba(196,92,100,' + (0.12 + rng() * 0.2) + ')';
    else if (v < 0.85) x.fillStyle = 'rgba(130,42,50,' + (0.12 + rng() * 0.2) + ')';
    else x.fillStyle = 'rgba(235,190,190,' + (0.06 + rng() * 0.1) + ')';
    x.fillRect(px, py, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }
  for (i = 0; i < 26; i++) {
    py = rng() * 256;
    x.strokeStyle = 'rgba(120,36,44,' + (0.05 + rng() * 0.07) + ')';
    x.lineWidth = 1 + rng() * 3;
    x.beginPath(); x.moveTo(0, py); x.lineTo(256, py + (rng() - 0.5) * 8); x.stroke();
  }
  return toTexture(c);
}

/* --- 篮球场丙烯酸面层 --- */
function texCourt() {
  var c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = '#2f6fb4'; x.fillRect(0, 0, 256, 256);
  var i, px, py;
  for (i = 0; i < 3600; i++) {
    px = rng() * 256; py = rng() * 256;
    x.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,' + (0.02 + rng() * 0.05) + ')' : 'rgba(10,30,60,' + (0.03 + rng() * 0.06) + ')';
    x.fillRect(px, py, 1 + rng() * 2, 1 + rng() * 2);
  }
  return toTexture(c);
}

/* --- 篮球场看台混凝土 --- */
function texConcrete() {
  var c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = '#a9adb4'; x.fillRect(0, 0, 256, 256);
  var i, px, py;
  for (i = 0; i < 4000; i++) {
    px = rng() * 256; py = rng() * 256;
    var v = 150 + rng() * 50;
    x.fillStyle = 'rgba(' + (v | 0) + ',' + (v | 0) + ',' + ((v + 4) | 0) + ',' + (0.1 + rng() * 0.2) + ')';
    x.fillRect(px, py, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }
  x.strokeStyle = 'rgba(90,94,100,0.25)'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, 128); x.lineTo(256, 128); x.moveTo(128, 0); x.lineTo(128, 256); x.stroke();
  return toTexture(c);
}

/* --- 铁丝网 --- */
function texChainlink() {
  var c = makeCanvas(128, 128), x = c.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(168,178,190,0.95)';
  x.lineWidth = 2.2;
  var s = 16, i;
  for (i = -128; i <= 256; i += s) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 128, 128); x.stroke();
    x.beginPath(); x.moveTo(i + 128, 0); x.lineTo(i, 128); x.stroke();
  }
  var t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* --- 球门网 --- */
function texNet() {
  var c = makeCanvas(64, 64), x = c.getContext('2d');
  x.clearRect(0, 0, 64, 64);
  x.strokeStyle = 'rgba(240,244,248,0.85)';
  x.lineWidth = 1.6;
  var s = 8, i;
  for (i = 0; i <= 64; i += s) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke();
  }
  return toTexture(c);
}

/* --- 楼房立面（玻璃幕墙网格） --- */
function texFacade(baseColor, glassA, glassB, litChance) {
  var c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = baseColor; x.fillRect(0, 0, 256, 256);
  var cols = 4, rows = 3;
  var mw = 256 / cols, mh = 256 / rows;
  var cw = mw * 0.68, ch = mh * 0.62;
  for (var r = 0; r < rows; r++) {
    for (var q = 0; q < cols; q++) {
      var px = q * mw + (mw - cw) / 2;
      var py = r * mh + (mh - ch) / 2;
      if (rng() < litChance) x.fillStyle = '#f4d9a4';
      else if (rng() < 0.5) x.fillStyle = glassA;
      else x.fillStyle = glassB;
      x.fillRect(px, py, cw, ch);
      x.fillStyle = 'rgba(255,255,255,0.16)';
      x.fillRect(px, py, cw, ch * 0.32);
      x.fillStyle = 'rgba(8,12,18,0.35)';
      x.fillRect(px, py + ch - 3, cw, 3);
    }
  }
  x.fillStyle = 'rgba(0,0,0,0.14)';
  for (r = 0; r <= rows; r++) x.fillRect(0, r * mh - 2, 256, 3);
  return toTexture(c);
}

/* --- 篮板 --- */
function texBackboard() {
  var c = makeCanvas(256, 160), x = c.getContext('2d');
  x.fillStyle = '#eef3f8'; x.fillRect(0, 0, 256, 160);
  x.strokeStyle = '#d8402e'; x.lineWidth = 10;
  x.strokeRect(6, 6, 244, 148);
  x.lineWidth = 6;
  x.strokeRect(103, 88, 50, 62);
  var t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* --- 道次号码 --- */
function texLaneNumber(n) {
  var c = makeCanvas(128, 128), x = c.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  x.font = '900 92px Outfit, Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(245,248,250,0.96)';
  x.fillText(String(n), 64, 70);
  var t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* --- 彩虹渐变 --- */
function texRainbow() {
  var c = makeCanvas(256, 8), x = c.getContext('2d');
  var bands = ['#ff5a4d', '#ffa24d', '#ffe066', '#7ddb6f', '#5bc8e8', '#7a8de8', '#b57ee8'];
  for (var i = 0; i < 256; i++) {
    var f = i / 255;
    var idx = Math.min(bands.length - 1, Math.floor(f * bands.length));
    var alpha = Math.pow(Math.sin(f * Math.PI), 0.8) * 0.85;
    x.fillStyle = bands[idx];
    x.globalAlpha = alpha;
    x.fillRect(i, 0, 1, 8);
  }
  var t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* ================= 天空（雨后渐变 + 碎积云 + 日晕） ================= */
var skyUniforms = {
  uSunDir: { value: SUN_DIR.clone() },
  uTime: { value: 0 }
};
var sky = new THREE.Mesh(
  new THREE.SphereGeometry(1100, 40, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: [
      'varying vec3 vWorld;',
      'void main() {',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vWorld = wp.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vWorld;',
      'uniform vec3 uSunDir;',
      'uniform float uTime;',
      'float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
      'float vnoise21(vec2 p) {',
      '  vec2 i = floor(p); vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),',
      '             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);',
      '}',
      'float fbm4(vec2 p) {',
      '  float v = 0.0; float a = 0.5;',
      '  for (int i = 0; i < 4; i++) { v += a * vnoise21(p); p = p * 2.03 + 17.7; a *= 0.5; }',
      '  return v;',
      '}',
      'void main() {',
      '  vec3 d = normalize(vWorld - cameraPosition);',
      '  float h = d.y;',
      '  vec3 zen = vec3(0.34, 0.49, 0.67);',
      '  vec3 hor = vec3(0.80, 0.85, 0.89);',
      '  vec3 col = mix(hor, zen, smoothstep(0.0, 0.52, h));',
      '  col = mix(vec3(0.78, 0.82, 0.86), col, smoothstep(-0.10, 0.02, h));',
      '  float sd = max(dot(d, uSunDir), 0.0);',
      '  vec3 sunCol = vec3(1.0, 0.87, 0.65);',
      '  col += sunCol * pow(sd, 900.0) * 4.0;',
      '  col += sunCol * pow(sd, 14.0) * 0.20;',
      '  col += vec3(1.0, 0.78, 0.55) * pow(sd, 3.5) * 0.08;',
      '  if (h > 0.005) {',
      '    vec2 cuv = d.xz / (h + 0.14);',
      '    float cl = fbm4(cuv * 0.85 + vec2(uTime * 0.005, uTime * 0.0018));',
      '    float cov = smoothstep(0.48, 0.80, cl) * smoothstep(0.015, 0.16, h);',
      '    vec3 cloud = mix(vec3(0.70, 0.75, 0.81), vec3(0.96, 0.96, 0.98), smoothstep(0.5, 0.92, cl));',
      '    cloud += sunCol * pow(sd, 6.0) * 0.35;',
      '    col = mix(col, cloud, cov * 0.82);',
      '  }',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  })
);
sky.frustumCulled = false;
scene.add(sky);

/* ================= 湿地平面反射系统 ================= */
var REFL_SCALE = isMobile ? 0.4 : 0.5;
var reflectionRT = new THREE.WebGLRenderTarget(2, 2, {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter
});
var reflCam = new THREE.PerspectiveCamera();

var sharedU = {
  uReflTex: { value: reflectionRT.texture },
  uTexMatrix: { value: new THREE.Matrix4() },
  uTime: { value: 0 },
  uSunDir: { value: SUN_DIR.clone() },
  uSunColor: { value: new THREE.Color(1.0, 0.87, 0.65) },
  uRain: { value: 0 }
};

var GLSL_NOISE = [
  'float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
  'float wNoise(vec2 p) {',
  '  vec2 i = floor(p); vec2 f = fract(p);',
  '  vec2 u = f * f * (3.0 - 2.0 * f);',
  '  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),',
  '             mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);',
  '}',
  'float wFbm(vec2 p) {',
  '  float v = 0.0; float a = 0.5;',
  '  for (int i = 0; i < 4; i++) { v += a * wNoise(p); p = p * 2.07 + 11.3; a *= 0.5; }',
  '  return v;',
  '}'
].join('\n');

var WET_FRAG = [
  '#include <opaque_fragment>',
  '{',
  '  vec2 wxz = vWP.xz;',
  '  float pn = wFbm(wxz * 0.052);',
  '  float pud = smoothstep(0.42, 0.62, pn) * uPuddle;',
  '  float wet = clamp(uWet + pud + uRain * 0.45, 0.0, 1.0);',
  '  float reflMask = clamp(pud * 1.9 + uWet * 0.18 + uRain * 0.30, 0.0, 1.0);',
  '  gl_FragColor.rgb *= mix(1.0, 0.68, wet);',
  '  vec2 ripple = vec2(wNoise(wxz * 2.7 + uTime * 0.42) - 0.5,',
  '                 wNoise(wxz * 2.7 + 7.7 - uTime * 0.36) - 0.5);',
  '  vec2 rippleHF = vec2(wNoise(wxz * 13.0 + uTime * 0.85) - 0.5,',
  '                   wNoise(wxz * 13.0 + 5.1 - uTime * 0.70) - 0.5);',
  '  float amp = pud * 0.85 + wet * 0.05 + uRain * pud * 0.3;',
  '  vec3 V = normalize(cameraPosition - vWP);',
  '  vec4 prj = uTexMatrix * vec4(vWP, 1.0);',
  '  float rk = step(0.0001, prj.w);',
  '  vec2 suv = prj.xy / max(prj.w, 0.0001);',
  '  suv.x = 1.0 - suv.x;',
  '  vec2 roff = ripple * (pud * 0.030 + uRain * pud * 0.03)',
  '            + rippleHF * (pud * 0.015 + uRain * 0.008);',
  '  roff.x = -roff.x;',
  '  vec3 refl = texture2D(uReflTex, suv + roff).rgb;',
  '  float fres = pow(1.0 - clamp(V.y, 0.12, 1.0), 3.0);',
  '  float k = reflMask * (uReflMin + (1.0 - uReflMin) * fres) * 0.55 * rk;',
  '  gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, clamp(k, 0.0, 0.65));',
  '  vec3 N = normalize(vec3(ripple.x * amp * 1.7, 1.0, ripple.y * amp * 1.7));',
  '  vec3 H = normalize(uSunDir + V);',
  '  float spec = pow(max(dot(N, H), 0.0), 130.0);',
  '  gl_FragColor.rgb += uSunColor * spec * (pud * 0.7 + wet * 0.06);',
  '}'
].join('\n');

function wetMaterial(opts) {
  opts = opts || {};
  var m = new THREE.MeshStandardMaterial({
    map: opts.map || null,
    color: opts.color !== undefined ? opts.color : 0xffffff,
    roughness: opts.roughness !== undefined ? opts.roughness : 0.92,
    metalness: 0.0,
    side: opts.side || THREE.FrontSide
  });
  var wet = opts.wetness !== undefined ? opts.wetness : 0.45;
  var pud = opts.puddle !== undefined ? opts.puddle : 0.45;
  var rmin = opts.reflMin !== undefined ? opts.reflMin : 0.3;
  m.onBeforeCompile = function (shader) {
    shader.uniforms.uReflTex = sharedU.uReflTex;
    shader.uniforms.uTexMatrix = sharedU.uTexMatrix;
    shader.uniforms.uTime = sharedU.uTime;
    shader.uniforms.uSunDir = sharedU.uSunDir;
    shader.uniforms.uSunColor = sharedU.uSunColor;
    shader.uniforms.uRain = sharedU.uRain;
    shader.uniforms.uWet = { value: wet };
    shader.uniforms.uPuddle = { value: pud };
    shader.uniforms.uReflMin = { value: rmin };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vWP;\n' +
        'uniform sampler2D uReflTex;\nuniform mat4 uTexMatrix;\nuniform float uTime;\n' +
        'uniform float uWet;\nuniform float uPuddle;\nuniform float uReflMin;\nuniform float uRain;\n' +
        'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\n' + GLSL_NOISE)
      .replace('#include <opaque_fragment>', WET_FRAG);
  };
  m.customProgramCacheKey = function () { return 'wetmat'; };
  return m;
}

var groundGroup = new THREE.Group();
scene.add(groundGroup);

var _vTmp1 = new THREE.Vector3();
var _vTmp2 = new THREE.Vector3();
var _vTmp3 = new THREE.Vector3();
var _mRot = new THREE.Matrix4();
var _texBias = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1
);
function renderReflection() {
  camera.updateMatrixWorld();
  if (camera.position.y <= 0.05) return;
  groundGroup.visible = false;
  if (typeof gunGrp !== 'undefined') gunGrp.visible = false;
  reflCam.position.set(camera.position.x, -camera.position.y, camera.position.z);
  _mRot.extractRotation(camera.matrixWorld);
  _vTmp2.set(0, 0, -1).applyMatrix4(_mRot).add(camera.position);
  _vTmp3.copy(_vTmp2);
  _vTmp3.y = -_vTmp3.y;
  reflCam.up.set(0, 1, 0).applyMatrix4(_mRot);
  reflCam.up.y = -reflCam.up.y;
  reflCam.lookAt(_vTmp3);
  reflCam.near = camera.near;
  reflCam.far = camera.far;
  reflCam.fov = camera.fov;
  reflCam.aspect = camera.aspect;
  reflCam.updateProjectionMatrix();
  reflCam.updateMatrixWorld();
  sharedU.uTexMatrix.value
    .copy(reflCam.projectionMatrix)
    .multiply(reflCam.matrixWorldInverse)
    .premultiply(_texBias);
  renderer.setRenderTarget(reflectionRT);
  renderer.render(scene, reflCam);
  renderer.setRenderTarget(null);
  groundGroup.visible = true;
  if (typeof gunGrp !== 'undefined') gunGrp.visible = true;
}

function resizeReflection() {
  var w = Math.max(2, Math.floor(window.innerWidth * MAX_PR * REFL_SCALE));
  var h = Math.max(2, Math.floor(window.innerHeight * MAX_PR * REFL_SCALE));
  reflectionRT.setSize(w, h);
  var el = document.getElementById('refl');
  if (el) el.textContent = w + 'px';
}

/* ================= 几何批量构建工具 ================= */
function GeoBatch() {
  this.pos = []; this.nor = []; this.uv = []; this.idx = []; this.vc = 0;
}
GeoBatch.prototype.quad = function (p0, p1, p2, p3, n, uvs) {
  var b = this;
  b.pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  for (var i = 0; i < 4; i++) b.nor.push(n[0], n[1], n[2]);
  if (uvs) b.uv.push(uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5], uvs[6], uvs[7]);
  else b.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
  b.idx.push(b.vc, b.vc + 1, b.vc + 2, b.vc, b.vc + 2, b.vc + 3);
  b.vc += 4;
};
GeoBatch.prototype.mesh = function (material) {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
  g.setIndex(this.idx);
  return new THREE.Mesh(g, material);
};

function batchLine(b, x0, z0, x1, z1, w, y) {
  var dx = x1 - x0, dz = z1 - z0;
  var len = Math.hypot(dx, dz) || 1;
  var px = -dz / len * w / 2, pz = dx / len * w / 2;
  b.quad(
    [x0 + px, y, z0 + pz], [x1 + px, y, z1 + pz],
    [x1 - px, y, z1 - pz], [x0 - px, y, z0 - pz],
    [0, 1, 0]
  );
}

function batchArc(b, cx, cz, r, a0, a1, w, y, nseg) {
  nseg = nseg || 24;
  for (var i = 0; i < nseg; i++) {
    var t0 = a0 + (a1 - a0) * i / nseg;
    var t1 = a0 + (a1 - a0) * (i + 1) / nseg;
    var ri = r - w / 2, ro = r + w / 2;
    var c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    b.quad(
      [cx + ri * c0, y, cz + ri * s0], [cx + ro * c0, y, cz + ro * s0],
      [cx + ro * c1, y, cz + ro * s1], [cx + ri * c1, y, cz + ri * s1],
      [0, 1, 0],
      [0, i / nseg, 1, i / nseg, 1, (i + 1) / nseg, 0, (i + 1) / nseg]
    );
  }
}

function stadiumSegPoint(L, r, seg, u) {
  if (seg === 0) {
    var a = -Math.PI / 2 - Math.PI * u;
    return { x: -L / 2 + r * Math.cos(a), z: r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) };
  } else if (seg === 1) {
    return { x: -L / 2 + u * L, z: r, nx: 0, nz: 1 };
  } else if (seg === 2) {
    var a2 = Math.PI / 2 - Math.PI * u;
    return { x: L / 2 + r * Math.cos(a2), z: r * Math.sin(a2), nx: Math.cos(a2), nz: Math.sin(a2) };
  }
  return { x: L / 2 - u * L, z: -r, nx: 0, nz: -1 };
}

function batchStadiumStrip(b, L, rIn, rOut, y, uM, vM) {
  var counts = [44, 36, 44, 36];
  var samples = [];
  for (var sg = 0; sg < 4; sg++)
    for (var i = 0; i < counts[sg]; i++) samples.push({ sg: sg, u: i / counts[sg] });
  var total = samples.length;
  var width = rOut - rIn;
  var sAcc = 0;
  for (var k = 0; k < total; k++) {
    var s0 = samples[k], s1 = samples[(k + 1) % total];
    var pA0 = stadiumSegPoint(L, rIn, s0.sg, s0.u);
    var pB0 = stadiumSegPoint(L, rOut, s0.sg, s0.u);
    var pA1 = stadiumSegPoint(L, rIn, s1.sg, s1.u);
    var pB1 = stadiumSegPoint(L, rOut, s1.sg, s1.u);
    var u0 = sAcc / uM, u1 = (sAcc + Math.hypot(pA1.x - pA0.x, pA1.z - pA0.z)) / uM;
    var v1 = vM > 0 ? width / vM : 1;
    b.quad(
      [pA0.x, y, pA0.z], [pB0.x, y, pB0.z],
      [pB1.x, y, pB1.z], [pA1.x, y, pA1.z],
      [0, 1, 0],
      [u0, 0, u1, 0, u1, v1, u0, v1]
    );
    sAcc += Math.hypot(pA1.x - pA0.x, pA1.z - pA0.z);
  }
}

function batchStadiumBand(b, L, r, y0, y1, uM) {
  var counts = [44, 36, 44, 36];
  var samples = [];
  for (var sg = 0; sg < 4; sg++)
    for (var i = 0; i < counts[sg]; i++) samples.push({ sg: sg, u: i / counts[sg] });
  var total = samples.length;
  var sAcc = 0;
  for (var k = 0; k < total; k++) {
    var s0 = samples[k], s1 = samples[(k + 1) % total];
    var p0 = stadiumSegPoint(L, r, s0.sg, s0.u);
    var p1 = stadiumSegPoint(L, r, s1.sg, s1.u);
    var u0 = sAcc / uM, u1 = (sAcc + Math.hypot(p1.x - p0.x, p1.z - p0.z)) / uM;
    var n = [p0.nx, 0, p0.nz];
    b.quad(
      [p0.x, y0, p0.z], [p0.x, y1, p0.z],
      [p1.x, y1, p1.z], [p1.x, y0, p1.z],
      n, [u0, 0, u0, 1, u1, 1, u1, 0]
    );
    sAcc += Math.hypot(p1.x - p0.x, p1.z - p0.z);
  }
}

function cylinderBetween(p0, p1, r, mat) {
  var d = new THREE.Vector3().subVectors(p1, p0);
  var len = d.length();
  var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.copy(p0).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

/* ================= 纹理实例 ================= */
var asphaltTex = texAsphalt();
asphaltTex.repeat.set(560 / 6, 440 / 6);
var grassTex = texGrass();
grassTex.repeat.set(1 / 8, 1 / 8);
var trackTex = texTrack();
var courtTex = texCourt();
courtTex.repeat.set(17 / 4, 31 / 4);
var concreteTex = texConcrete();
concreteTex.repeat.set(6, 1);
var chainTex = texChainlink();
var netTex = texNet();
var facadeA = texFacade('#5c6774', '#8fa6ba', '#7492ac', 0.10);
var facadeB = texFacade('#6a7076', '#9db4c6', '#7fa0b6', 0.06);
var facadeC = texFacade('#7d7469', '#a8bcc8', '#8ea9ba', 0.03);
var backboardTex = texBackboard();
var rainbowTex = texRainbow();

/* ================= 1. 沥青地坪 ================= */
(function buildAsphalt() {
  var mat = wetMaterial({ map: asphaltTex, roughness: 0.94, wetness: 0.62, puddle: 0.9, reflMin: 0.3 });
  var g = new THREE.PlaneGeometry(560, 440);
  g.rotateX(-Math.PI / 2);
  var m = new THREE.Mesh(g, mat);
  m.position.set(21, 0, -5);
  m.receiveShadow = true;
  groundGroup.add(m);
})();

/* ================= 2. 塑胶跑道 ================= */
(function buildTrack() {
  var mat = wetMaterial({ map: trackTex, roughness: 0.88, wetness: 0.5, puddle: 0.85, reflMin: 0.3, side: THREE.DoubleSide });
  var b = new GeoBatch();
  batchStadiumStrip(b, TRACK_L, TRACK_R - 0.15, TRACK_OUT + 0.55, 0.012, 2, 2);
  var mesh = b.mesh(mat);
  mesh.receiveShadow = true;
  groundGroup.add(mesh);

  var lb = new GeoBatch();
  for (var i = 0; i <= LANES; i++) {
    var r = TRACK_R + i * LANE_W;
    batchStadiumStrip(lb, TRACK_L, r - 0.03, r + 0.03, 0.024, 4, 0);
  }
  var lineMat = wetMaterial({ color: 0xf2f5f8, roughness: 0.7, wetness: 0.42, puddle: 0.12, reflMin: 0.22, side: THREE.DoubleSide });
  var lm = lb.mesh(lineMat);
  lm.receiveShadow = true;
  groundGroup.add(lm);

  var kb = new GeoBatch();
  batchStadiumBand(kb, TRACK_L, TRACK_R - 0.15, 0, 0.09, 3);
  var kerbMat = wetMaterial({ color: 0xe8edf2, roughness: 0.55, wetness: 0.5, puddle: 0.05, reflMin: 0.25, side: THREE.DoubleSide });
  var km = kb.mesh(kerbMat);
  km.receiveShadow = true; km.castShadow = true;
  groundGroup.add(km);
  var kt = new GeoBatch();
  batchStadiumStrip(kt, TRACK_L, TRACK_R - 0.55, TRACK_R - 0.15, 0.09, 3, 0);
  var ktm = kt.mesh(kerbMat);
  ktm.receiveShadow = true;
  groundGroup.add(ktm);

  var sb = new GeoBatch();
  batchLine(sb, 10, -(TRACK_R - 0.35), 10, -(TRACK_OUT + 0.35), 0.1, 0.026);
  batchLine(sb, 9.6, -(TRACK_R - 0.35), 9.6, -(TRACK_OUT + 0.35), 0.05, 0.026);
  var sm = sb.mesh(lineMat);
  groundGroup.add(sm);
  for (i = 1; i <= LANES; i++) {
    var numTex = texLaneNumber(i);
    var pg = new THREE.PlaneGeometry(1.15, 1.0);
    pg.rotateX(-Math.PI / 2);
    pg.rotateY(Math.PI / 2);
    var pm = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({
      map: numTex, transparent: true, roughness: 0.75,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1
    }));
    pm.position.set(7.6, 0.026, -(TRACK_R + (i - 0.5) * LANE_W));
    groundGroup.add(pm);
  }
})();

/* ================= 3. 草皮 infield + 足球标线 ================= */
(function buildTurf() {
  var pts = [];
  var counts = [60, 40, 60, 40], N = 200;
  var idx = 0;
  for (var sg = 0; sg < 4; sg++) {
    for (var i = 0; i < counts[sg]; i++) {
      var u = i / counts[sg];
      var p = stadiumSegPoint(TRACK_L, TRACK_R - 0.55, sg, u);
      pts.push(new THREE.Vector2(p.x, -p.z));
    }
    idx += counts[sg];
  }
  var shape = new THREE.Shape(pts);
  var g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  var mat = wetMaterial({ map: grassTex, roughness: 0.96, wetness: 0.28, puddle: 0.1, reflMin: 0.16, side: THREE.DoubleSide });
  var m = new THREE.Mesh(g, mat);
  m.position.y = 0.006;
  m.receiveShadow = true;
  groundGroup.add(m);

  var fb = new GeoBatch();
  var W = 52.5, H = 34, y = 0.03, lw = 0.12;
  batchLine(fb, -W, -H, W, -H, lw, y); batchLine(fb, -W, H, W, H, lw, y);
  batchLine(fb, -W, -H, -W, H, lw, y); batchLine(fb, W, -H, W, H, lw, y);
  batchLine(fb, 0, -H, 0, H, lw, y);
  batchArc(fb, 0, 0, 9.15, 0, Math.PI * 2, lw, y, 48);
  batchArc(fb, 0, 0, 0.28, 0, Math.PI * 2, 0.56, y, 12);
  [-1, 1].forEach(function (s) {
    var gx = s * W;
    batchLine(fb, gx, -20.16, gx - s * 16.5, -20.16, lw, y);
    batchLine(fb, gx, 20.16, gx - s * 16.5, 20.16, lw, y);
    batchLine(fb, gx - s * 16.5, -20.16, gx - s * 16.5, 20.16, lw, y);
    batchLine(fb, gx, -9.16, gx - s * 5.5, -9.16, lw, y);
    batchLine(fb, gx, 9.16, gx - s * 5.5, 9.16, lw, y);
    batchLine(fb, gx - s * 5.5, -9.16, gx - s * 5.5, 9.16, lw, y);
    batchArc(fb, s * 41.5, 0, 0.22, 0, Math.PI * 2, 0.44, y, 10);
    var a = Math.acos(5.5 / 9.15);
    if (s < 0) batchArc(fb, -41.5, 0, 9.15, -a, a, lw, y, 28);
    else batchArc(fb, 41.5, 0, 9.15, Math.PI - a, Math.PI + a, lw, y, 28);
  });
  batchArc(fb, -W, H, 1, -Math.PI / 2, 0, lw, y, 8);
  batchArc(fb, W, H, 1, Math.PI, Math.PI * 1.5, lw, y, 8);
  batchArc(fb, W, -H, 1, Math.PI / 2, Math.PI, lw, y, 8);
  batchArc(fb, -W, -H, 1, 0, Math.PI / 2, lw, y, 8);
  var fbMat = wetMaterial({ color: 0xf4f7fa, roughness: 0.72, wetness: 0.4, puddle: 0.08, reflMin: 0.2, side: THREE.DoubleSide });
  var fm = fb.mesh(fbMat);
  fm.receiveShadow = true;
  groundGroup.add(fm);
})();

/* ================= 4. 篮球场 ×2 ================= */
(function buildCourts() {
  var baseMat = wetMaterial({ map: courtTex, roughness: 0.82, wetness: 0.6, puddle: 0.5, reflMin: 0.3, side: THREE.DoubleSide });
  var lineMat = wetMaterial({ color: 0xf2f5f8, roughness: 0.7, wetness: 0.42, puddle: 0.15, reflMin: 0.22, side: THREE.DoubleSide });
  var lb = new GeoBatch();
  [-16, 16].forEach(function (cz) {
    var g = new THREE.PlaneGeometry(17, 31);
    g.rotateX(-Math.PI / 2);
    var m = new THREE.Mesh(g, baseMat);
    m.position.set(110, 0.008, cz);
    m.receiveShadow = true;
    groundGroup.add(m);

    var y = 0.028, lw = 0.09, cx = 110, hw = 7.5, hl = 14;
    batchLine(lb, cx - hw, cz - hl, cx + hw, cz - hl, lw, y);
    batchLine(lb, cx - hw, cz + hl, cx + hw, cz + hl, lw, y);
    batchLine(lb, cx - hw, cz - hl, cx - hw, cz + hl, lw, y);
    batchLine(lb, cx + hw, cz - hl, cx + hw, cz + hl, lw, y);
    batchLine(lb, cx - hw, cz, cx + hw, cz, lw, y);
    batchArc(lb, cx, cz, 1.8, 0, Math.PI * 2, lw, y, 24);
    [-1, 1].forEach(function (s) {
      var rz = cz + s * hl;
      batchLine(lb, cx - 2.45, rz, cx - 2.45, rz - s * 5.8, lw, y);
      batchLine(lb, cx + 2.45, rz, cx + 2.45, rz - s * 5.8, lw, y);
      batchLine(lb, cx - 2.45, rz - s * 5.8, cx + 2.45, rz - s * 5.8, lw, y);
      batchArc(lb, cx, rz - s * 5.8, 1.8, 0, Math.PI * 2, lw, y, 24);
      var rimZ = cz + s * 15.2;
      var a = Math.asin(6.6 / 6.75);
      var base = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      batchArc(lb, cx, rimZ, 6.75, base - a, base + a, lw, y, 30);
      var zMeet = s * (Math.abs(rimZ - cz) - Math.sqrt(6.75 * 6.75 - 6.6 * 6.6)) + cz;
      batchLine(lb, cx - 6.6, rz, cx - 6.6, zMeet, lw, y);
      batchLine(lb, cx + 6.6, rz, cx + 6.6, zMeet, lw, y);
    });
  });
  var lm = lb.mesh(lineMat);
  lm.receiveShadow = true;
  groundGroup.add(lm);

  var poleMat = new THREE.MeshStandardMaterial({ color: 0x4a5259, roughness: 0.5, metalness: 0.6 });
  var boardMat = new THREE.MeshStandardMaterial({ map: backboardTex, roughness: 0.35, metalness: 0.05 });
  var rimMat = new THREE.MeshStandardMaterial({ color: 0xe8622c, roughness: 0.4, metalness: 0.5 });
  var netMat = new THREE.MeshStandardMaterial({
    map: netTex, transparent: true, alphaTest: 0.25, side: THREE.DoubleSide,
    color: 0xffffff, roughness: 0.9
  });
  [-16, 16].forEach(function (cz) {
    [-1, 1].forEach(function (s) {
      var grp = new THREE.Group();
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 3.9, 12), poleMat);
      pole.position.set(0, 1.95, s * 16.6);
      pole.castShadow = true;
      grp.add(pole);
      var arm = cylinderBetween(
        new THREE.Vector3(0, 3.45, s * 16.6),
        new THREE.Vector3(0, 3.45, s * 15.65), 0.05, poleMat);
      grp.add(arm);
      var board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.05), boardMat);
      board.position.set(0, 3.35, s * 15.62);
      board.castShadow = true;
      grp.add(board);
      var rim = new THREE.Mesh(new THREE.TorusGeometry(0.228, 0.018, 10, 24), rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0, 3.05, s * 15.2);
      grp.add(rim);
      var net = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.1, 0.42, 12, 1, true), netMat);
      net.position.set(0, 2.84, s * 15.2);
      grp.add(net);
      grp.position.x = 110;
      scene.add(grp);
    });
  });
})();

/* ================= 5. 足球门 ×2 ================= */
(function buildGoals() {
  var postMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.35, metalness: 0.25 });
  var netMat = new THREE.MeshStandardMaterial({
    map: netTex, transparent: true, alphaTest: 0.25, side: THREE.DoubleSide,
    color: 0xeef2f6, roughness: 0.9
  });
  [-1, 1].forEach(function (s) {
    var gx = s * 52.5;
    var grp = new THREE.Group();
    [-3.66, 3.66].forEach(function (z) {
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.44, 10), postMat);
      post.position.set(gx, 1.22, z);
      post.castShadow = true;
      grp.add(post);
      grp.add(cylinderBetween(
        new THREE.Vector3(gx, 2.44, z),
        new THREE.Vector3(gx + s * 1.7, 0, z), 0.04, postMat));
    });
    var bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7.44, 10), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(gx, 2.44, 0);
    bar.castShadow = true;
    grp.add(bar);
    var nb = new THREE.Mesh(new THREE.PlaneGeometry(7.44, 2.1), netMat);
    nb.position.set(gx + s * 1.7, 1.05, 0);
    nb.rotation.y = Math.PI / 2;
    grp.add(nb);
    var nt = new THREE.Mesh(new THREE.PlaneGeometry(7.44, 1.75), netMat);
    nt.position.set(gx + s * 0.85, 1.6, 0);
    nt.rotation.y = Math.PI / 2;
    nt.rotation.x = s * 0.65;
    grp.add(nt);
    [-3.66, 3.66].forEach(function (z) {
      var ns = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 1.9), netMat);
      ns.position.set(gx + s * 0.85, 0.95, z);
      grp.add(ns);
    });
    scene.add(grp);
  });
})();

/* ================= 6. 围栏 ================= */
(function buildFence() {
  var chainMat = new THREE.MeshStandardMaterial({
    map: chainTex, transparent: true, alphaTest: 0.35,
    side: THREE.DoubleSide, color: 0xb9c3cd, roughness: 0.55, metalness: 0.35
  });
  var postMat = new THREE.MeshStandardMaterial({ color: 0x59626b, roughness: 0.5, metalness: 0.5 });
  var sides = [
    { x0: COMPOUND.x0, z0: COMPOUND.z0, x1: COMPOUND.x0, z1: -3.5 },
    { x0: COMPOUND.x0, z0: 3.5, x1: COMPOUND.x0, z1: COMPOUND.z1 },
    { x0: COMPOUND.x1, z0: COMPOUND.z0, x1: COMPOUND.x1, z1: COMPOUND.z1 },
    { x0: COMPOUND.x0, z0: COMPOUND.z0, x1: COMPOUND.x1, z1: COMPOUND.z0 },
    { x0: COMPOUND.x0, z0: COMPOUND.z1, x1: COMPOUND.x1, z1: COMPOUND.z1 }
  ];
  addCollider(COMPOUND.x0 - 0.3, COMPOUND.x0 + 0.3, COMPOUND.z0, -3.5);
  addCollider(COMPOUND.x0 - 0.3, COMPOUND.x0 + 0.3, 3.5, COMPOUND.z1);
  addCollider(COMPOUND.x1 - 0.3, COMPOUND.x1 + 0.3, COMPOUND.z0, COMPOUND.z1);
  addCollider(COMPOUND.x0, COMPOUND.x1, COMPOUND.z0 - 0.3, COMPOUND.z0 + 0.3);
  addCollider(COMPOUND.x0, COMPOUND.x1, COMPOUND.z1 - 0.3, COMPOUND.z1 + 0.3);
  var warnMat = new THREE.MeshStandardMaterial({ color: 0x66121c, emissive: 0xd42a3c, emissiveIntensity: 1.6, roughness: 0.4 });
  [-4.1, 4.1].forEach(function (gz) {
    var gw = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.6, 0.3), postMat);
    gw.position.set(COMPOUND.x0, 1.8, gz);
    gw.castShadow = true;
    scene.add(gw);
    var wl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 0.36), warnMat);
    wl.position.set(COMPOUND.x0, 3.9, gz);
    scene.add(wl);
  });
  var postMats = [];
  sides.forEach(function (sd) {
    var len = Math.hypot(sd.x1 - sd.x0, sd.z1 - sd.z0);
    var g = new THREE.PlaneGeometry(len, 3);
    var t = chainTex.clone();
    t.needsUpdate = true;
    t.repeat.set(len / 3, 1);
    var m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: t, transparent: true, alphaTest: 0.35,
      side: THREE.DoubleSide, color: 0xb9c3cd, roughness: 0.55, metalness: 0.35
    }));
    m.position.set((sd.x0 + sd.x1) / 2, 1.5, (sd.z0 + sd.z1) / 2);
    m.rotation.y = Math.atan2(-(sd.z1 - sd.z0), sd.x1 - sd.x0);
    scene.add(m);
    var rail = cylinderBetween(
      new THREE.Vector3(sd.x0, 3.02, sd.z0),
      new THREE.Vector3(sd.x1, 3.02, sd.z1), 0.035, postMat);
    rail.castShadow = true;
    scene.add(rail);
    var n = Math.max(2, Math.round(len / 6));
    for (var i = 0; i <= n; i++) {
      var t2 = i / n;
      postMats.push([
        sd.x0 + (sd.x1 - sd.x0) * t2, 1.6, sd.z0 + (sd.z1 - sd.z0) * t2
      ]);
    }
  });
  var posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.05, 3.2, 8), postMat, postMats.length);
  var mtx = new THREE.Matrix4();
  postMats.forEach(function (p, i) {
    mtx.makeTranslation(p[0], p[1], p[2]);
    posts.setMatrixAt(i, mtx);
  });
  posts.castShadow = true;
  scene.add(posts);
})();

/* ================= 7. 照明灯塔 ×4 ================= */
(function buildFloodlights() {
  var poleMat = new THREE.MeshStandardMaterial({ color: 0x8b939c, roughness: 0.55, metalness: 0.6 });
  var baseMat = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xb9bdc4, roughness: 0.9 });
  var lampMat = new THREE.MeshStandardMaterial({
    color: 0xd9d4c6, emissive: 0xfff3d9, emissiveIntensity: 1.5, roughness: 0.4
  });
  [[-95, -73], [137, -73], [-95, 63], [137, 63]].forEach(function (p) {
    var grp = new THREE.Group();
    var base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 1.6), baseMat);
    base.position.set(0, 0.35, 0);
    base.castShadow = true;
    grp.add(base);
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.32, 21, 12), poleMat);
    pole.position.set(0, 10.85, 0);
    pole.castShadow = true;
    grp.add(pole);
    var head = new THREE.Group();
    var frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 1.0), poleMat);
    head.add(frame);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 2; j++) {
        var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.08), lampMat);
        lamp.position.set(-0.9 + i * 0.6, 0.22 + j * 0.38, 0.1);
        head.add(lamp);
      }
    }
    head.position.set(0, 21.4, 0);
    grp.add(head);
    grp.position.set(p[0], 0, p[1]);
    grp.updateMatrixWorld(true);
    head.lookAt(new THREE.Vector3(0, 2, 0));
    scene.add(grp);
  });
})();

/* ================= 8. 看台 ================= */
(function buildStands() {
  var concMat = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xcdd1d7, roughness: 0.92 });
  var concDark = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0x9aa0a8, roughness: 0.92 });
  var seatColors = [0x3e7bc4, 0x4686cc, 0x4f91d4, 0x589cdb, 0x62a7e2];
  var grp = new THREE.Group();
  var rows = 10;
  for (var i = 0; i < rows; i++) {
    var h = (i + 1) * 0.5;
    var step = new THREE.Mesh(new THREE.BoxGeometry(68, h, 0.95), concMat);
    step.position.set(0, h / 2, -58.5 - i * 0.95);
    step.castShadow = true; step.receiveShadow = true;
    grp.add(step);
    var seat = new THREE.Mesh(
      new THREE.BoxGeometry(67, 0.06, 0.42),
      new THREE.MeshStandardMaterial({ color: seatColors[i % seatColors.length], roughness: 0.38 }));
    seat.position.set(0, h + 0.03, -58.5 - i * 0.95 + 0.26);
    grp.add(seat);
  }
  var back = new THREE.Mesh(new THREE.BoxGeometry(68, 8.6, 0.5), concDark);
  back.position.set(0, 4.3, -68.6);
  back.castShadow = true;
  grp.add(back);
  [-34.2, 34.2].forEach(function (x) {
    var wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8.6, 10.6), concDark);
    wall.position.set(x, 4.3, -63.6);
    wall.castShadow = true;
    grp.add(wall);
  });
  var roof = new THREE.Mesh(new THREE.BoxGeometry(69, 0.35, 10.5), concDark);
  roof.position.set(0, 8.9, -63.8);
  roof.rotation.x = 0.09;
  roof.castShadow = true;
  grp.add(roof);
  for (i = -2; i <= 2; i++) {
    var col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 8.9, 10), concDark);
    col.position.set(i * 16, 4.45, -68.2);
    col.castShadow = true;
    grp.add(col);
  }
  scene.add(grp);
  addCollider(-34.5, 34.5, -69.0, -57.8);
})();

/* ================= 9. 教学楼群（镂空可进入） ================= */
function makeBuilding(w, h, d, x, z, tex, winRepeatX, winRepeatZ) {
  var grp = new THREE.Group();
  var T = 0.45;
  var doorW = 3.0, doorH = 3.2;
  var innerH = Math.min(h - 1.5, 6.0);

  var wallMat = new THREE.MeshStandardMaterial({ color: 0xb8b5a8, roughness: 0.92 });
  var inFloorMat = new THREE.MeshStandardMaterial({ color: 0x8f948c, roughness: 0.95 });
  var deskMat = new THREE.MeshStandardMaterial({ color: 0x7d6a52, roughness: 0.85 });
  var roofMat = new THREE.MeshStandardMaterial({ color: 0x6d747c, roughness: 0.95 });
  var lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
  var warnMat = new THREE.MeshStandardMaterial({ color: 0x66121c, emissive: 0xd42a3c, emissiveIntensity: 1.8, roughness: 0.4 });

  function skin(rx, ry) {
    var t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
  }
  function addBox(bw, bh, bd, px, py, pz, mat, collide) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    m.position.set(px, py, pz);
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
    if (collide) {
      addCollider(x + px - bw / 2 - 0.05, x + px + bw / 2 + 0.05,
        z + pz - bd / 2 - 0.05, z + pz + bd / 2 + 0.05);
    }
    return m;
  }
  function addSkin(bw, bh, px, py, pz, ry) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), skin(bw / 8, bh / 8));
    m.position.set(px, py, pz);
    m.rotation.y = ry;
    m.receiveShadow = true;
    grp.add(m);
    return m;
  }

  addBox(w, h, T, 0, h / 2, -d / 2 + T / 2, wallMat, true);
  addBox(w, h, T, 0, h / 2, d / 2 - T / 2, wallMat, true);
  addBox(T, h, d, -w / 2 + T / 2, h / 2, 0, wallMat, true);
  var segLen = (d - doorW) / 2;
  addBox(T, h, segLen, w / 2 - T / 2, h / 2, -(doorW / 2 + segLen / 2), wallMat, true);
  addBox(T, h, segLen, w / 2 - T / 2, h / 2, (doorW / 2 + segLen / 2), wallMat, true);
  addBox(T, h - doorH, doorW, w / 2 - T / 2, doorH + (h - doorH) / 2, 0, wallMat, false);

  addSkin(w, h, 0, h / 2, -d / 2 - 0.02, Math.PI);
  addSkin(w, h, 0, h / 2, d / 2 + 0.02, 0);
  addSkin(d, h, -w / 2 - 0.02, h / 2, 0, Math.PI / 2);
  addSkin(segLen, h, w / 2 + 0.02, h / 2, -(doorW / 2 + segLen / 2), -Math.PI / 2);
  addSkin(segLen, h, w / 2 + 0.02, h / 2, (doorW / 2 + segLen / 2), -Math.PI / 2);
  addSkin(doorW, h - doorH, w / 2 + 0.02, doorH + (h - doorH) / 2, 0, -Math.PI / 2);

  var fl = new THREE.Mesh(new THREE.BoxGeometry(w - 2 * T, 0.12, d - 2 * T), inFloorMat);
  fl.position.y = 0.06;
  fl.receiveShadow = true;
  grp.add(fl);
  var ceil = new THREE.Mesh(new THREE.BoxGeometry(w - 2 * T, 0.18, d - 2 * T), wallMat);
  ceil.position.y = innerH;
  grp.add(ceil);
  [-1, 1].forEach(function (sx) {
    var strip = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, d * 0.88), lampMat);
    strip.position.set(sx * w * 0.2, innerH - 0.12, 0);
    grp.add(strip);
  });
  var pl = new THREE.PointLight(0xffeecc, 44, Math.max(w, d) * 0.95, 1.6);
  pl.position.set(0, innerH - 0.7, 0);
  grp.add(pl);

  var rows = Math.max(2, Math.floor((d - 10) / 7));
  for (var r = 0; r < rows; r++) {
    var zOff = -d / 2 + 6 + r * ((d - 12) / Math.max(1, rows - 1));
    for (var cx = -1; cx <= 1; cx += 2) {
      addBox(1.5, 0.74, 0.8, cx * (w * 0.18), 0.37, zOff, deskMat, true);
    }
  }

  var dl = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.4, 0.25), warnMat);
  dl.position.set(w / 2 + 0.1, doorH + 0.35, 0);
  grp.add(dl);

  var roof = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.3, d - 0.3), roofMat);
  roof.position.y = h - 0.15;
  roof.castShadow = true;
  grp.add(roof);
  var parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.7, d + 0.6), roofMat);
  parapet.position.y = h + 0.3;
  grp.add(parapet);
  var tank = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 2.2, 14),
    new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.6, metalness: 0.3 }));
  tank.position.set(w * 0.25, h + 1.6, -d * 0.2);
  grp.add(tank);
  var ac = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x84898f, roughness: 0.8 }));
  ac.position.set(-w * 0.2, h + 0.8, d * 0.25);
  grp.add(ac);
  grp.position.set(x, 0, z);
  scene.add(grp);
  return grp;
}
makeBuilding(18, 22, 66, -136, -10, facadeA);
makeBuilding(16, 17, 44, -141, -60, facadeB);
makeBuilding(26, 13, 34, -132, 44, facadeC);

/* ================= 10. 树木（实例化） ================= */
(function buildTrees() {
  var buildingRects = [
    [-146, -127, -44, 24], [-149, -133, -83, -37], [-146, -119, 26, 62]
  ];
  var placed = [];
  var tries = 0;
  while (placed.length < 30 && tries < 900) {
    tries++;
    var x = -195 + rng() * 435;
    var z = -128 + rng() * 246;
    if (x > COMPOUND.x0 - 7 && x < COMPOUND.x1 + 7 && z > COMPOUND.z0 - 7 && z < COMPOUND.z1 + 7) continue;
    var inB = false;
    for (var i = 0; i < buildingRects.length; i++) {
      var r = buildingRects[i];
      if (x > r[0] - 4 && x < r[1] + 4 && z > r[2] - 4 && z < r[3] + 4) { inB = true; break; }
    }
    if (inB) continue;
    var ok = true;
    for (i = 0; i < placed.length; i++) {
      if (Math.hypot(placed[i][0] - x, placed[i][1] - z) < 8) { ok = false; break; }
    }
    if (!ok) continue;
    placed.push([x, z, 0.8 + rng() * 0.7, rng() * Math.PI * 2]);
  }
  var N = placed.length;
  var trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 2.6, 8);
  var trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4634, roughness: 0.95 });
  var trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
  var leafGeo = new THREE.IcosahedronGeometry(1.55, 1);
  var leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5d38, roughness: 0.72 });
  var leaves = new THREE.InstancedMesh(leafGeo, leafMat, N * 3);
  var m = new THREE.Matrix4();
  var q = new THREE.Quaternion();
  var sc = new THREE.Vector3();
  var pos = new THREE.Vector3();
  var li = 0;
  for (var k = 0; k < N; k++) {
    var t = placed[k];
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t[3]);
    pos.set(t[0], 1.3 * t[2], t[1]);
    sc.set(t[2], t[2], t[2]);
    m.compose(pos, q, sc);
    trunks.setMatrixAt(k, m);
    var blobs = [
      [0, 3.1, 0, 1.0], [0.85, 2.5, 0.45, 0.62], [-0.7, 2.7, -0.5, 0.55]
    ];
    for (var b = 0; b < 3; b++) {
      var bl = blobs[b];
      pos.set(t[0] + bl[0] * t[2], bl[1] * t[2], t[1] + bl[2] * t[2]);
      var bs = t[2] * bl[3] * (0.92 + rng() * 0.2);
      sc.set(bs, bs * 0.92, bs);
      m.compose(pos, q, sc);
      leaves.setMatrixAt(li++, m);
    }
  }
  trunks.castShadow = true;
  leaves.castShadow = true;
  scene.add(trunks);
  scene.add(leaves);
})();

/* ================= 11. 旗杆 ================= */
(function buildFlag() {
  var grp = new THREE.Group();
  var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 13, 10),
    new THREE.MeshStandardMaterial({ color: 0xc8ced6, roughness: 0.35, metalness: 0.7 }));
  pole.position.y = 6.5;
  pole.castShadow = true;
  grp.add(pole);
  var ball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xd8b45a, roughness: 0.3, metalness: 0.8 }));
  ball.position.y = 13.05;
  grp.add(ball);
  var flagMat = new THREE.MeshStandardMaterial({
    color: 0xd5342c, roughness: 0.8, side: THREE.DoubleSide
  });
  flagMat.onBeforeCompile = function (shader) {
    shader.uniforms.uTime = sharedU.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float fx = smoothstep(0.0, 3.4, position.x);',
        'transformed.z += sin(position.x * 1.9 + uTime * 4.2) * 0.28 * fx;',
        'transformed.y += sin(position.x * 1.3 + uTime * 3.1) * 0.09 * fx;'
      ].join('\n'));
  };
  flagMat.customProgramCacheKey = function () { return 'flag'; };
  var fg = new THREE.PlaneGeometry(3.4, 2.1, 22, 10);
  fg.translate(1.7, 0, 0);
  var flag = new THREE.Mesh(fg, flagMat);
  flag.position.y = 11.8;
  grp.add(flag);
  grp.position.set(-93, 0, 40);
  grp.rotation.y = 0.5;
  scene.add(grp);
})();

/* ================= 12. 远景天际线 ================= */
(function buildSkyline() {
  var N = 16;
  var geo = new THREE.BoxGeometry(1, 1, 1);
  var mat = new THREE.MeshStandardMaterial({ color: 0x93a1b2, roughness: 0.9 });
  var inst = new THREE.InstancedMesh(geo, mat, N);
  var m = new THREE.Matrix4();
  var q = new THREE.Quaternion();
  for (var i = 0; i < N; i++) {
    var a = rng() * Math.PI * 2;
    var r = 240 + rng() * 90;
    var w = 16 + rng() * 30;
    var h = 22 + rng() * 55;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
    m.compose(
      new THREE.Vector3(Math.cos(a) * r + 21, h / 2, Math.sin(a) * r - 5),
      q, new THREE.Vector3(w, h, w * (0.7 + rng() * 0.6)));
    inst.setMatrixAt(i, m);
  }
  scene.add(inst);
})();

/* ================= 13. 彩虹 ================= */
var rainbowMat = null;
(function buildRainbow() {
  var b = new GeoBatch();
  var r0 = 245, r1 = 318;
  var nseg = 56;
  for (var i = 0; i < nseg; i++) {
    var a0 = Math.PI * 0.12 + Math.PI * 0.76 * i / nseg;
    var a1 = Math.PI * 0.12 + Math.PI * 0.76 * (i + 1) / nseg;
    b.quad(
      [r0 * Math.cos(a0), r0 * Math.sin(a0), 0],
      [r1 * Math.cos(a0), r1 * Math.sin(a0), 0],
      [r1 * Math.cos(a1), r1 * Math.sin(a1), 0],
      [r0 * Math.cos(a1), r0 * Math.sin(a1), 0],
      [0, 0, 1],
      [0, i / nseg, 1, i / nseg, 1, (i + 1) / nseg, 0, (i + 1) / nseg]
    );
  }
  rainbowMat = new THREE.MeshBasicMaterial({
    map: rainbowTex, transparent: true, opacity: 0.34,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false, toneMapped: false
  });
  var mesh = b.mesh(rainbowMat);
  mesh.rotation.set(0, 2.147, 0);
  mesh.position.set(0, -92, 0);
  mesh.frustumCulled = false;
  scene.add(mesh);
})();

/* ================= 14. 雨滴粒子 ================= */
var rain = (function () {
  var N = isMobile ? 900 : 1800;
  var pos = new Float32Array(N * 3);
  var spd = new Float32Array(N);
  var off = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    pos[i * 3] = -140 + rng() * 300;
    pos[i * 3 + 1] = rng() * 62;
    pos[i * 3 + 2] = -125 + rng() * 235;
    spd[i] = 26 + rng() * 20;
    off[i] = rng() * 62;
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(spd, 1));
  g.setAttribute('aOff', new THREE.BufferAttribute(off, 1));
  var mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: sharedU.uTime,
      uOpacity: { value: 0 },
      uPR: { value: MAX_PR }
    },
    vertexShader: [
      'attribute float aSpeed;',
      'attribute float aOff;',
      'uniform float uTime;',
      'uniform float uPR;',
      'varying float vA;',
      'void main() {',
      '  vec3 p = position;',
      '  float fall = mod(uTime * aSpeed + aOff, 62.0);',
      '  p.y = 60.0 - fall;',
      '  p.x += sin(uTime * 0.4 + aOff) * 0.6;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  float ps = (300.0 / max(-mv.z, 1.0)) * uPR;',
      '  gl_PointSize = clamp(ps, 3.2, 30.0);',
      '  vA = clamp(ps / 7.0, 0.35, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'varying float vA;',
      'uniform float uOpacity;',
      'void main() {',
      '  vec2 pc = gl_PointCoord - 0.5;',
      '  float a = smoothstep(0.5, 0.05, abs(pc.x)) * smoothstep(0.5, 0.14, abs(pc.y)) * vA * uOpacity * 0.8;',
      '  gl_FragColor = vec4(0.66, 0.75, 0.88, a);',
      '}'
    ].join('\n')
  });
  var pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  return { mat: mat, obj: pts, anim: 0, target: 0 };
})();

/* ================= 15. 第一人称控制器 ================= */
var btnRain = document.getElementById('btnRain');
var btnReset = document.getElementById('btnReset');

var touchCapable = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
if (touchCapable) document.body.classList.add('has-touch');

var P_EYE = 1.7;
var P_WALK = 4.4;
var P_RUN = 9.5;
var P_BOUND = {
  x0: -150, x1: COMPOUND.x1 - 1.2,
  z0: COMPOUND.z0 - 8, z1: COMPOUND.z1 + 1.2
};
var SPAWN = { x: 0, z: -6, yaw: 0, pitch: -0.02 };

var player = {
  pos: new THREE.Vector3(SPAWN.x, P_EYE, SPAWN.z),
  yaw: SPAWN.yaw, pitch: SPAWN.pitch,
  bob: 0
};

var keys = {};
var MOVE_CODES = {
  KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
  ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1
};
window.addEventListener('keydown', function (e) {
  keys[e.code] = true;
  if (e.code === 'KeyR') weaponReload();
  if (e.code === 'KeyF') game.shooting = true;
});
window.addEventListener('keyup', function (e) {
  keys[e.code] = false;
  if (e.code === 'KeyF') game.shooting = false;
});

/* ---------- 移动端虚拟摇杆 ---------- */
var joyMove = { x: 0, y: 0, active: false };
var JOY_R = 56;
var joyEl = document.getElementById('joy-move');
var joyThumb = document.getElementById('joyMoveThumb');
var joyCenter = { x: 0, y: 0 };
var joyId = -1;

function joyStart(e) {
  var t = e.touches[0];
  joyId = t.identifier;
  var r = joyEl.getBoundingClientRect();
  joyCenter.x = r.left + r.width / 2;
  joyCenter.y = r.top + r.height / 2;
  e.preventDefault();
}
function joyTrack(e) {
  for (var i = 0; i < e.touches.length; i++) {
    if (e.touches[i].identifier !== joyId) continue;
    var t = e.touches[i];
    var dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
    var d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx = dx / d * JOY_R; dy = dy / d * JOY_R; d = JOY_R; }
    joyMove.x = dx / JOY_R;
    joyMove.y = dy / JOY_R;
    joyMove.active = d > 8;
    joyThumb.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    e.preventDefault();
    return;
  }
}
function joyEnd(e) {
  if (e.changedTouches && e.changedTouches[0].identifier === joyId) {
    joyId = -1;
    joyMove.x = 0; joyMove.y = 0; joyMove.active = false;
    joyThumb.style.transform = 'translate(0px,0px)';
  }
}
if (joyEl) {
  joyEl.addEventListener('touchstart', joyStart, { passive: false });
  joyEl.addEventListener('touchmove', joyTrack, { passive: false });
  joyEl.addEventListener('touchend', joyEnd);
  joyEl.addEventListener('touchcancel', joyEnd);
}

var dom = renderer.domElement;
dom.style.touchAction = 'none';
dom.addEventListener('contextmenu', function (e) { e.preventDefault(); });

var dragId = -1, lastPX = 0, lastPY = 0;
function rotateView(dx, dy) {
  player.yaw -= dx * 0.0052;
  player.pitch = clamp(player.pitch - dy * 0.0052, -1.45, 1.45);
}
dom.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (dragId !== -1) return;
  dragId = e.pointerId;
  lastPX = e.clientX; lastPY = e.clientY;
  if (dom.setPointerCapture) dom.setPointerCapture(e.pointerId);
});
dom.addEventListener('pointermove', function (e) {
  if (e.pointerId !== dragId) return;
  rotateView(e.clientX - lastPX, e.clientY - lastPY);
  lastPX = e.clientX; lastPY = e.clientY;
});
function endDrag(e) {
  if (e.pointerId === dragId) dragId = -1;
}
dom.addEventListener('pointerup', endDrag);
dom.addEventListener('pointercancel', endDrag);

dom.addEventListener('click', function () {
  if (!touchCapable && !game.dead && document.pointerLockElement !== dom && dom.requestPointerLock) {
    dom.requestPointerLock();
  }
});
document.addEventListener('pointerlockchange', function () {
  game.locked = document.pointerLockElement === dom;
});
document.addEventListener('mousemove', function (e) {
  if (game.locked) rotateView(e.movementX || 0, e.movementY || 0);
});
dom.addEventListener('mousedown', function (e) {
  if (game.locked && e.button === 0) game.shooting = true;
});
window.addEventListener('mouseup', function (e) {
  if (e.button === 0) game.shooting = false;
});

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

var _fwd = new THREE.Vector3();
var _rgt = new THREE.Vector3();
var _look = new THREE.Vector3();

function updateControls(dt) {
  _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _rgt.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));

  var mvx = 0, mvz = 0;
  if (keys.KeyW || keys.ArrowUp) mvz += 1;
  if (keys.KeyS || keys.ArrowDown) mvz -= 1;
  if (keys.KeyA || keys.ArrowLeft) mvx -= 1;
  if (keys.KeyD || keys.ArrowRight) mvx += 1;
  if (joyMove.active) { mvx += joyMove.x; mvz += -joyMove.y; }

  var wantSprint = !!(keys.ShiftLeft || keys.ShiftRight) || game.sprintToggle;
  var ml = Math.hypot(mvx, mvz);
  var moving = ml > 0.001 && !game.dead;

  game.sprinting = moving && wantSprint && game.stamina > 1.5;
  if (game.sprinting) game.stamina = Math.max(0, game.stamina - 26 * dt);
  else game.stamina = Math.min(100, game.stamina + 15 * dt);

  if (moving) {
    var inv = ml > 1 ? 1 / ml : 1;
    var sp = (game.sprinting ? P_RUN : P_WALK) * dt * inv;
    player.pos.x += (_fwd.x * mvz + _rgt.x * mvx) * sp;
    player.pos.z += (_fwd.z * mvz + _rgt.z * mvx) * sp;
    player.bob += dt * (game.sprinting ? 13.5 : 9);
  } else {
    player.bob *= Math.max(0, 1 - dt * 6);
  }

  var cr = collideXZ(player.pos.x, player.pos.z, 0.42);
  player.pos.x = clamp(cr[0], P_BOUND.x0, P_BOUND.x1);
  player.pos.z = clamp(cr[1], P_BOUND.z0, P_BOUND.z1);
  var bobY = Math.sin(player.bob) * (game.sprinting ? 0.075 : 0.045) * (moving ? 1 : 0);

  camera.fov += ((game.sprinting ? 66 : 55) - camera.fov) * Math.min(1, dt * 7);
  camera.updateProjectionMatrix();

  var cp = Math.cos(player.pitch);
  _look.set(cp * -Math.sin(player.yaw), Math.sin(player.pitch), cp * -Math.cos(player.yaw));
  camera.position.set(player.pos.x, P_EYE + bobY, player.pos.z);
  camera.lookAt(
    player.pos.x + _look.x,
    P_EYE + bobY + _look.y,
    player.pos.z + _look.z
  );
}

/* ================= 16. UI 交互 ================= */
if (btnRain) btnRain.addEventListener('click', function () {
  rain.target = rain.target ? 0 : 1;
  btnRain.classList.toggle('on', rain.target === 1);
});
if (btnReset) btnReset.addEventListener('click', function () {
  player.pos.set(SPAWN.x, P_EYE, SPAWN.z);
  player.yaw = SPAWN.yaw;
  player.pitch = SPAWN.pitch;
  player.bob = 0;
});

/* ================= 16.5 战斗系统 ================= */
var game = {
  hp: 100, maxHp: 100, stamina: 100,
  ammo: 30, magSize: 30, reloading: false, reloadT: 0,
  fireCd: 0, recoil: 0,
  shooting: false, locked: false, sprintToggle: false, sprinting: false,
  kills: 0, wave: 1, spawnT: 0, elapsed: 0,
  dead: false, hurtT: 0, noDmgT: 0, shake: 0, hitmarkT: 0
};

/* ---------- 枪械模型 ---------- */
var gunGrp = new THREE.Group();
(function buildGun() {
  var body = new THREE.MeshStandardMaterial({ color: 0x454c54, roughness: 0.42, metalness: 0.6 });
  var grip = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.85 });
  var acc = new THREE.MeshStandardMaterial({ color: 0x1f242b, roughness: 0.4, metalness: 0.6 });
  function part(w, h, d, x, y, z, mat) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || body);
    m.position.set(x, y, z);
    gunGrp.add(m);
    return m;
  }
  part(0.09, 0.11, 0.62, 0, 0, -0.18);
  part(0.07, 0.07, 0.34, 0, 0.015, -0.62);
  part(0.05, 0.09, 0.16, 0, -0.09, 0.02, grip);
  part(0.06, 0.13, 0.07, 0, -0.1, -0.28, grip);
  part(0.05, 0.05, 0.2, 0, 0.085, -0.3, acc);
  part(0.045, 0.05, 0.05, 0, 0.115, -0.34, acc);
  gunGrp.position.set(0.22, -0.18, -0.42);
  camera.add(gunGrp);
  scene.add(camera);
})();

var muzzle = new THREE.Mesh(
  new THREE.PlaneGeometry(0.46, 0.46),
  new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
);
muzzle.position.set(0, 0.015, -0.84);
gunGrp.add(muzzle);
var muzzleLight = new THREE.PointLight(0xffc477, 0, 10, 1.8);
muzzleLight.position.set(0, 0, -0.9);
gunGrp.add(muzzleLight);

/* ---------- 丧尸 ---------- */
var zombies = [];
var zSkins = [0x7d9161, 0x8a9a6a, 0x6f8558, 0x93a37b].map(function (c) {
  return new THREE.MeshStandardMaterial({
    color: c, roughness: 0.92,
    emissive: 0x1a3322, emissiveIntensity: 0.85
  });
});
var zCloths = [0x4a4a52, 0x3d4148, 0x53463b].map(function (c) {
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
});
var zEyeMat = new THREE.MeshStandardMaterial({
  color: 0x220000, emissive: 0xd42a3c, emissiveIntensity: 2.2, roughness: 0.3
});
var zShadowMat = new THREE.MeshBasicMaterial({ color: 0x0a1208, transparent: true, opacity: 0.34, depthWrite: false });
var zShadowGeo = new THREE.CircleGeometry(0.55, 18);

function makeZombie() {
  var grp = new THREE.Group();
  var skin = zSkins[Math.floor(Math.random() * zSkins.length)];
  var cloth = zCloths[Math.floor(Math.random() * zCloths.length)];
  function box(w, h, d, x, y, z, mat) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    grp.add(m);
    return m;
  }
  var torso = box(0.52, 0.62, 0.28, 0, 1.12, 0, cloth);
  torso.castShadow = false;
  var head = box(0.3, 0.32, 0.3, 0, 1.58, 0, skin);
  box(0.05, 0.045, 0.02, -0.07, 1.62, -0.16, zEyeMat);
  box(0.05, 0.045, 0.02, 0.07, 1.62, -0.16, zEyeMat);
  function limb(w, len, x, y, mat) {
    var g = new THREE.Group();
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat);
    m.position.y = -len / 2;
    g.add(m);
    g.position.set(x, y, 0);
    grp.add(g);
    return g;
  }
  var armL = limb(0.13, 0.52, -0.33, 1.36, skin);
  var armR = limb(0.13, 0.52, 0.33, 1.36, skin);
  armL.rotation.x = -1.4; armR.rotation.x = -1.4;
  var legL = limb(0.17, 0.62, -0.14, 0.78, cloth);
  var legR = limb(0.17, 0.62, 0.14, 0.78, cloth);
  var blob = new THREE.Mesh(zShadowGeo, zShadowMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  grp.add(blob);
  var sc = 0.9 + Math.random() * 0.22;
  grp.scale.set(sc, sc, sc);
  var runner = Math.random() < 0.1;
  var z = {
    grp: grp, r: 0.5,
    speed: runner ? 4.4 + Math.random() * 0.8 : 1.15 + Math.random() * 1.05,
    runner: runner, atkCd: 0, phase: Math.random() * 6.28,
    armL: armL, armR: armR, legL: legL, legR: legR,
    dead: false, deadT: 0
  };

  /* ★ 联机：把 hp 唯一数据源放在 grp.userData.hp，
     z.hp 通过 defineProperty 代理读写，与 zsync.js 自动同步 */
  grp.userData.hp = 100;
  grp.userData.isZombie = true;
  grp.userData.__zRef = z;
  Object.defineProperty(z, 'hp', {
    get: function () { return grp.userData.hp; },
    set: function (v) { grp.userData.hp = v; }
  });

  scene.add(grp);
  return z;
}

function spawnZombie() {
  /* ★ 联机：客户端不刷丧尸，由房主快照驱动（除非 __zombieSpawn 补怪） */
  if (window.ZS && window.ZS.isClient() && !window.__zombieSpawnMode) return;

  for (var t = 0; t < 24; t++) {
    var x = COMPOUND.x0 + 6 + Math.random() * (COMPOUND.x1 - COMPOUND.x0 - 12);
    var z = COMPOUND.z0 + 6 + Math.random() * (COMPOUND.z1 - COMPOUND.z0 - 12);
    if (Math.hypot(x - player.pos.x, z - player.pos.z) < 26) continue;
    if (insideAnyCollider(x, z, 0.8)) continue;
    var zb = makeZombie();
    zb.grp.position.set(x, 0, z);
    zombies.push(zb);
    /* ★ 联机：注册到全局数组，供 zsync 序列化广播 */
    if (!window.__zombieSpawnMode) {
      window.__zombies.push(zb.grp);
    }
    return;
  }
}

function damageZombie(z, dmg) {
  if (z.dead) return;
  z.hp -= dmg;
  var p = z.grp.position;
  bloodBurst(p.x, 1.1 + Math.random() * 0.5, p.z);
  if (z.hp <= 0) {
    z.dead = true;
    z.deadT = 0;
    game.kills++;
  }
}

/* ---------- 血液粒子（对象池） ---------- */
var bloodMat = new THREE.MeshBasicMaterial({ color: 0x7a1016 });
var bloodGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
var bloodPool = [];
for (var bi = 0; bi < 60; bi++) {
  var bm = new THREE.Mesh(bloodGeo, bloodMat);
  bm.visible = false;
  scene.add(bm);
  bloodPool.push({ m: bm, vx: 0, vy: 0, vz: 0, life: 0 });
}
function bloodBurst(x, y, z) {
  var n = 6;
  for (var i = 0; i < bloodPool.length && n > 0; i++) {
    var b = bloodPool[i];
    if (b.life > 0) continue;
    n--;
    b.life = 0.55 + Math.random() * 0.3;
    b.m.visible = true;
    b.m.position.set(x, y, z);
    b.vx = (Math.random() - 0.5) * 4.5;
    b.vy = 1.5 + Math.random() * 3.2;
    b.vz = (Math.random() - 0.5) * 4.5;
  }
}
function updateBlood(dt) {
  for (var i = 0; i < bloodPool.length; i++) {
    var b = bloodPool[i];
    if (b.life <= 0) continue;
    b.life -= dt;
    if (b.life <= 0) { b.m.visible = false; continue; }
    b.vy -= 11 * dt;
    b.m.position.x += b.vx * dt;
    b.m.position.y += b.vy * dt;
    b.m.position.z += b.vz * dt;
    if (b.m.position.y < 0.05) { b.m.position.y = 0.05; b.vy = 0; b.vx *= 0.6; b.vz *= 0.6; }
    var s = Math.max(0.25, b.life * 1.6);
    b.m.scale.set(s, s, s);
  }
}

/* ---------- 射击：射线 vs 丧尸头/身球体 ---------- */
var _rd = new THREE.Vector3();
var _va = new THREE.Vector3();
function fireRayHit() {
  camera.getWorldDirection(_rd);
  var o = camera.position;
  var best = null, bestT = 1e9;
  for (var i = 0; i < zombies.length; i++) {
    var z = zombies[i];
    if (z.dead) continue;
    for (var s = 0; s < 2; s++) {
      var sy = s === 0 ? 1.58 : 0.95;
      var sr = s === 0 ? 0.30 : 0.48;
      _va.set(z.grp.position.x, sy * z.grp.scale.y, z.grp.position.z).sub(o);
      var tca = _va.dot(_rd);
      if (tca < 0) continue;
      var d2 = _va.lengthSq() - tca * tca;
      if (d2 > sr * sr) continue;
      var t = tca - Math.sqrt(sr * sr - d2);
      if (t < bestT) {
        bestT = t;
        best = { z: z, hs: s === 0 };
      }
    }
  }
  return best;
}

function weaponFire() {
  if (game.dead || game.reloading || game.fireCd > 0) return;
  if (game.ammo <= 0) { weaponReload(); return; }
  game.ammo--;
  game.fireCd = 0.105;
  game.recoil = 1;
  muzzle.material.opacity = 1;
  muzzle.rotation.z = Math.random() * Math.PI;
  muzzleLight.intensity = 24;
  player.pitch = clamp(player.pitch + 0.012, -1.45, 1.45);
  var hit = fireRayHit();
  if (hit) {
    var isClient = !!(window.ZS && window.ZS.isClient());
    if (isClient && window.P2P) {
      /* ★ 联机：客户端把命中上报房主，由房主结算伤害 */
      var g = hit.z.grp;
      var idx = (window.__zombies || []).indexOf(g);
      if (idx >= 0) {
        window.P2P.sendHitZombie(idx, hit.hs ? 999 : 38);
      }
    } else {
      /* 房主 / 单机：本地结算 */
      damageZombie(hit.z, hit.hs ? 115 : 38);
    }
    game.hitmarkT = 0.14;
  }
}

function weaponReload() {
  if (game.reloading || game.ammo === game.magSize || game.dead) return;
  game.reloading = true;
  game.reloadT = 1.7;
}

function updateWeapon(dt) {
  game.fireCd = Math.max(0, game.fireCd - dt);
  if (game.shooting && !game.dead) weaponFire();
  if (game.reloading) {
    game.reloadT -= dt;
    if (game.reloadT <= 0) { game.reloading = false; game.ammo = game.magSize; }
  }
  game.recoil = Math.max(0, game.recoil - dt * 7);
  muzzle.material.opacity *= Math.pow(0.0001, dt);
  muzzleLight.intensity *= Math.pow(0.00001, dt);
  var wantRot = game.reloading ? 0.55 : 0;
  gunGrp.rotation.x += (wantRot + game.recoil * 0.1 - gunGrp.rotation.x) * Math.min(1, dt * 10);
  gunGrp.position.z = -0.42 + game.recoil * 0.055;
}

/* ---------- 丧尸 AI（★ 联机：客户端分支） ---------- */
function updateZombies(dt) {
  var isClient = !!(window.ZS && window.ZS.isClient());

  /* ★ 联机：房主 / 单机才推进波次和刷怪 */
  if (!isClient) {
    var target = Math.min(6 + Math.floor(game.elapsed / 22), 24);
    game.wave = 1 + Math.floor(game.elapsed / 30);
    game.spawnT -= dt;
    var alive = 0;
    for (var i = 0; i < zombies.length; i++) if (!zombies[i].dead) alive++;
    if (game.spawnT <= 0 && alive < target && !game.dead) {
      spawnZombie();
      game.spawnT = 0.7;
    }
  }

  for (var i = zombies.length - 1; i >= 0; i--) {
    var z = zombies[i];
    var p = z.grp.position;

    if (z.dead) {
      z.deadT += dt;
      z.grp.rotation.x = Math.min(1.5, z.deadT * 4.4);
      if (z.deadT > 0.75) p.y -= dt * 1.1;
      if (z.deadT > 1.7) {
        /* ★ 联机：出队时同步从 __zombies 移除 */
        if (z.grp.parent) z.grp.parent.remove(z.grp);
        else scene.remove(z.grp);
        var ix = (window.__zombies || []).indexOf(z.grp);
        if (ix >= 0) window.__zombies.splice(ix, 1);
        zombies.splice(i, 1);
      }
      continue;
    }

    /* ★ 联机：客户端僵尸位置由 zsync.js 的 rAF 插值控制；
       本函数只做攻击判定 + 位置动画同步 */
    if (isClient) {
      /* zsync 已经 parent.remove() 隐藏的僵尸：同步移除 */
      if (!z.grp.parent) {
        var ix2 = (window.__zombies || []).indexOf(z.grp);
        if (ix2 >= 0) window.__zombies.splice(ix2, 1);
        zombies.splice(i, 1);
        continue;
      }
      var dxC = player.pos.x - p.x, dzC = player.pos.z - p.z;
      var distC = Math.hypot(dxC, dzC);
      z.atkCd -= dt;
      if (distC <= 1.35 && !game.dead) {
        var swingC = Math.sin(Math.max(0, 0.55 - z.atkCd) * 9) * 0.5;
        z.armL.rotation.x = -1.4 - swingC;
        z.armR.rotation.x = -1.4 - swingC;
        if (z.atkCd <= 0) {
          z.atkCd = 0.95;
          hurtPlayer(8 + Math.random() * 9);
        }
      } else {
        /* 用位置变化速度驱动腿/手动画 */
        var lx = z.__lx != null ? z.__lx : p.x;
        var lz = z.__lz != null ? z.__lz : p.z;
        var mv = Math.hypot(p.x - lx, p.z - lz);
        z.__lx = p.x; z.__lz = p.z;
        z.phase += dt * (2.6 + mv * 30);
        var swC = Math.sin(z.phase) * 0.55;
        z.legL.rotation.x = swC;
        z.legR.rotation.x = -swC;
        z.armL.rotation.x = -1.4 + Math.sin(z.phase + 3.14) * 0.16;
        z.armR.rotation.x = -1.4 + Math.sin(z.phase) * 0.16;
      }
      /* 面向本地玩家（zsync 会覆盖 rotation.y，这里只在必要时补充） */
      continue;
    }

    /* ============ 房主 / 单机：原逻辑 ============ */
    var dx = player.pos.x - p.x, dz = player.pos.z - p.z;
    var dist = Math.hypot(dx, dz);
    var dxn = 0, dzn = 0;
    if (dist > 0.001) { dxn = dx / dist; dzn = dz / dist; }
    z.grp.rotation.y = Math.atan2(-dxn, -dzn);
    if (dist > 1.15 && !game.dead) {
      var sp = z.speed * (1 + game.wave * 0.02);
      var nx = p.x + dxn * sp * dt;
      var nz = p.z + dzn * sp * dt;
      for (var j = 0; j < zombies.length; j++) {
        if (j === i || zombies[j].dead) continue;
        var q = zombies[j].grp.position;
        var ox = nx - q.x, oz = nz - q.z;
        var od = Math.hypot(ox, oz);
        if (od < 0.85 && od > 0.001) {
          nx += ox / od * (0.85 - od) * 0.5;
          nz += oz / od * (0.85 - od) * 0.5;
        }
      }
      var cr = collideXZ(nx, nz, 0.5);
      p.x = cr[0];
      p.z = cr[1];
      z.phase += dt * (2.6 + z.speed * 1.6);
    } else if (dist <= 1.35) {
      z.atkCd -= dt;
      var swing = Math.sin(Math.max(0, 0.55 - z.atkCd) * 9) * 0.5;
      z.armL.rotation.x = -1.4 - swing;
      z.armR.rotation.x = -1.4 - swing;
      if (z.atkCd <= 0 && !game.dead) {
        z.atkCd = 0.95;
        hurtPlayer(8 + Math.random() * 9);
      }
    }
    var sw = Math.sin(z.phase) * 0.55;
    z.legL.rotation.x = sw;
    z.legR.rotation.x = -sw;
    if (dist > 1.35) {
      z.armL.rotation.x = -1.4 + Math.sin(z.phase + 3.14) * 0.16;
      z.armR.rotation.x = -1.4 + Math.sin(z.phase) * 0.16;
    }
  }
}

/* ---------- 玩家受击 / 死亡 / 重开 ---------- */
function hurtPlayer(dmg) {
  if (game.dead) return;
  game.hp -= dmg;
  game.hurtT = 1;
  game.noDmgT = 0;
  game.shake = 0.4;
  /* ★ 联机：上报本地 HP，让队友血条实时更新 */
  if (window.MP) window.MP.setHP(Math.max(0, game.hp));
  if (game.hp <= 0) {
    game.hp = 0;
    playerDie();
  }
}
function playerDie() {
  game.dead = true;
  game.shooting = false;
  var ds = document.getElementById('deathScreen');
  if (ds) {
    document.getElementById('deathStats').textContent =
      '击杀 ' + game.kills + ' · 抵达第 ' + game.wave + ' 波';
    ds.style.display = 'flex';
  }
  if (document.exitPointerLock) document.exitPointerLock();
}
function restartGame() {
  for (var i = 0; i < zombies.length; i++) scene.remove(zombies[i].grp);
  zombies.length = 0;
  /* ★ 联机：清空全局数组 */
  if (window.__zombies) window.__zombies.length = 0;

  game.hp = game.maxHp;
  game.stamina = 100;
  game.ammo = game.magSize;
  game.reloading = false;
  game.kills = 0;
  game.wave = 1;
  game.elapsed = 0;
  game.dead = false;
  game.hurtT = 0;
  game.shake = 0;
  player.pos.set(SPAWN.x, P_EYE, SPAWN.z);
  player.yaw = SPAWN.yaw;
  player.pitch = SPAWN.pitch;
  player.bob = 0;
  var ds = document.getElementById('deathScreen');
  if (ds) ds.style.display = 'none';
}

/* ---------- HUD ---------- */
var elHpFill = document.getElementById('hpFill');
var elHpNum = document.getElementById('hpNum');
var elStFill = document.getElementById('stFill');
var elAmmo = document.getElementById('ammoNum');
var elKill = document.getElementById('killN');
var elWave = document.getElementById('waveN');
var elAlive = document.getElementById('aliveN');
var elVig = document.getElementById('vignette');
var elHit = document.getElementById('hitmark');
var hudT = 0;
function updateHUD(dt) {
  game.hurtT = Math.max(0, game.hurtT - dt * 1.1);
  game.hitmarkT = Math.max(0, game.hitmarkT - dt);
  game.noDmgT += dt;
  if (!game.dead && game.noDmgT > 6 && game.hp < game.maxHp) {
    game.hp = Math.min(game.maxHp, game.hp + 4 * dt);
  }
  hudT -= dt;
  if (hudT > 0) {
    if (elVig) elVig.style.opacity = Math.min(0.9, game.hurtT).toFixed(2);
    if (elHit) elHit.style.opacity = game.hitmarkT > 0 ? 1 : 0;
    return;
  }
  hudT = 0.12;
  if (elHpFill) {
    elHpFill.style.width = game.hp + '%';
    elHpFill.style.background = game.hp > 55 ? 'linear-gradient(90deg,#57d98a,#3cb96f)'
      : (game.hp > 25 ? 'linear-gradient(90deg,#e8c04a,#d99a2b)' : 'linear-gradient(90deg,#ef5350,#c62828)');
  }
  if (elHpNum) elHpNum.textContent = Math.ceil(game.hp);
  if (elStFill) elStFill.style.width = game.stamina + '%';
  if (elAmmo) elAmmo.textContent = game.reloading ? '装填' : game.ammo;
  if (elKill) elKill.textContent = game.kills;
  if (elWave) elWave.textContent = game.wave;
  if (elAlive) {
    var a = 0;
    for (var i = 0; i < zombies.length; i++) if (!zombies[i].dead) a++;
    elAlive.textContent = a;
  }
}

/* ---------- 移动端战斗按钮 ---------- */
var btnFire = document.getElementById('btnFire');
var btnReloadM = document.getElementById('btnReload');
var btnSprint = document.getElementById('btnSprint');
var btnRestart = document.getElementById('btnRestart');
if (btnFire) {
  btnFire.addEventListener('pointerdown', function (e) { e.preventDefault(); game.shooting = true; });
  btnFire.addEventListener('pointerup', function () { game.shooting = false; });
  btnFire.addEventListener('pointercancel', function () { game.shooting = false; });
  btnFire.addEventListener('pointerleave', function () { game.shooting = false; });
}
if (btnReloadM) btnReloadM.addEventListener('click', weaponReload);
if (btnSprint) btnSprint.addEventListener('click', function () {
  game.sprintToggle = !game.sprintToggle;
  btnSprint.classList.toggle('on', game.sprintToggle);
});
if (btnRestart) btnRestart.addEventListener('click', restartGame);

/* ================= 17. 主循环 ================= */
var clock = new THREE.Clock();
var perfT = 0;
var fpsFrames = 0, fpsAcc = 0, fpsEl = document.getElementById('fps');
var perfCheckT = 0, degraded = false;
var loaderHidden = false;
var loaderEl = document.getElementById('loader');

invalidateShadows();

function animate() {
  requestAnimationFrame(animate);
  var dt = Math.min(clock.getDelta(), 0.05);
  perfT += dt;
  sharedU.uTime.value = perfT;
  skyUniforms.uTime.value = perfT;

  rain.anim += (rain.target - rain.anim) * Math.min(1, dt * 1.1);
  if (rain.anim < 0.005 && rain.target === 0) rain.anim = 0;
  sharedU.uRain.value = rain.anim;
  rain.mat.uniforms.uOpacity.value = rain.anim;
  rain.obj.visible = rain.anim > 0.004;

  if (rainbowMat) rainbowMat.opacity = 0.34 * (1.0 - rain.anim * 0.92);
  renderer.toneMappingExposure = 0.94 - rain.anim * 0.15;
  scene.fog.near = 120 - rain.anim * 50;
  scene.fog.far = 640 - rain.anim * 210;

  sky.position.copy(camera.position);
  updateControls(dt);
  game.elapsed += dt;
  updateWeapon(dt);
  updateZombies(dt);
  updateBlood(dt);
  updateHUD(dt);
  if (game.shake > 0) {
    camera.position.x += (Math.random() - 0.5) * game.shake * 0.2;
    camera.position.y += (Math.random() - 0.5) * game.shake * 0.15;
    game.shake = Math.max(0, game.shake - dt * 1.7);
  }
  renderReflection();
  renderer.render(scene, camera);

  if (!loaderHidden) {
    loaderHidden = true;
    setTimeout(function () { if (loaderEl) loaderEl.classList.add('hide'); }, 250);
  }

  fpsFrames++; fpsAcc += dt;
  if (fpsAcc >= 0.6) {
    if (fpsEl) fpsEl.textContent = Math.round(fpsFrames / fpsAcc);
    fpsFrames = 0; fpsAcc = 0;
  }
  if (!degraded) {
    perfCheckT += dt;
    if (perfCheckT > 7 && fpsFrames / Math.max(fpsAcc, 0.001) < 24) {
      degraded = true;
      REFL_SCALE = 0.32;
      renderer.setPixelRatio(1);
      renderer.setSize(window.innerWidth, window.innerHeight);
      resizeReflection();
    }
  }
}

window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeReflection();
});

resizeReflection();
animate();

/* ============================================================
   ★ 联机桥接 API —— zsync.js 会调用
   ============================================================ */

/* 客户端补怪：让 zsync 在快照比本地多时调用 */
window.__zombieSpawn = function (s) {
  var lenBefore = zombies.length;
  window.__zombieSpawnMode = true;
  try { spawnZombie(); } finally { window.__zombieSpawnMode = false; }
  if (zombies.length <= lenBefore) return null;   // 生成失败
  var z = zombies[zombies.length - 1];
  z.grp.position.set(s.x, s.y || 0, s.z);
  z.hp = s.hp;
  z.grp.userData.hp = s.hp;
  z.grp.userData.__zRef = z;
  return z.grp;   // zsync 会自己 push 到 window.__zombies
};

/* 房主：客户端命中上报后由 zsync 调用 → 走本地 damageZombie 结算 */
window.__onZombieKilled = function (g) {
  var z = g && g.userData && g.userData.__zRef;
  if (z && !z.dead) {
    z.dead = true;
    z.deadT = 0;
    game.kills++;
  }
};

/* 客户端：HUD 数值从房主同步 */
window.__waveSet = function (w) {
  game.wave = w;
  var el = document.getElementById('waveN'); if (el) el.textContent = w;
};
window.__killsSet = function (k) {
  game.kills = k;
  var el = document.getElementById('killN'); if (el) el.textContent = k;
};

/* ★ 覆盖 zsync.js 的 __hitZombie，走本地 damageZombie（血粒子/音效/击杀）
   注意：app.js 在 zsync.js 之前加载，用 load 事件确保覆盖时机正确 */
function installHitBridge() {
  window.__hitZombie = function (d) {
    if (!d || !window.__zombies) return;
    var g = window.__zombies[d.i];
    if (!g || !g.parent) return;
    var z = g.userData.__zRef;
    if (z && !z.dead) damageZombie(z, d.dmg || 0);
  };
}
if (document.readyState === 'complete') installHitBridge();
else window.addEventListener('load', installHitBridge);

/* 调试接口 */
window.__pg = {
  camera: camera,
  player: player,
  game: game,
  zombies: zombies,
  weaponFire: weaponFire,
  weaponReload: weaponReload,
  restartGame: restartGame,
  hurtPlayer: hurtPlayer,
  spawnZombie: spawnZombie,
  reflCam: reflCam,
  uTexMatrix: sharedU.uTexMatrix,
  renderReflection: renderReflection,
  scene: scene,
  renderer: renderer,
  rt: reflectionRT,
  sharedU: sharedU
};

})();