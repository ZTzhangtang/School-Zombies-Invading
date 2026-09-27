/* ============================================================
 * model.js — School Zombies Invading · P2P 联机完整版
 * 架构: 房主权威模拟僵尸 + 各端模拟自己玩家 + 20Hz状态同步
 * 依赖: PeerJS 1.5.x (需在 index.html 中先引入)
 * ============================================================ */
'use strict';

/* ================= 配置区 ================= */
const CFG = {
    TICK_RATE: 20,              // 网络同步频率
    PLAYER_SPEED: 3.2,
    PLAYER_RADIUS: 16,
    PLAYER_MAX_HP: 100,
    ZOMBIE_SPEED: 1.4,
    ZOMBIE_SPEED_VARIANCE: 0.6,
    ZOMBIE_RADIUS: 14,
    ZOMBIE_DMG: 8,
    ZOMBIE_ATK_CD: 30,          // 僵尸攻击间隔(帧)
    BULLET_SPEED: 11,
    BULLET_DMG: 25,
    FIRE_CD: 12,                // 射击冷却(帧)
    WAVE_INTERVAL: 240,         // 波次间隔(帧)
    MAP_W: 1600,
    MAP_H: 900,
    ZOMBIES_PER_WAVE_BASE: 5,
    MAX_REMOTE_INTERP: 100      // 远程插值缓冲(ms)
};

const WEAPONS = {
    pistol:  { name: '手枪', dmg: 25, cd: 12, speed: 11, spread: 0.03, ammo: Infinity },
    shotgun: { name: '霰弹', dmg: 12, cd: 35, speed: 9,  spread: 0.25, pellets: 5, ammo: 40 },
    smg:     { name: '冲锋枪', dmg: 10, cd: 5,  speed: 13, spread: 0.08, ammo: 120 }
};

/* ================= 工具 ================= */
const rand  = (a, b) => a + Math.random() * (b - a);
const dist  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t) => a + (b - a) * t;

/* ============================================================
 * 第一部分: P2P 网络层
 * ============================================================ */
const Net = (() => {
    const PEER_OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 1 };
    const TICK_MS = 1000 / CFG.TICK_RATE;

    let peer = null, isHost = false, myId = null;
    let conns = new Map();          // peerId -> {conn, name}
    let started = false;
    let timer = null;
    let localState = null;          // 本地玩家快照
    let remoteStates = new Map();   // peerId -> {x,y,angle,hp,weapon,t}
    let zombieSnapshot = null;      // 房主广播的僵尸快照
    let handlers = {};
    let zombiesGetter = null;       // 房主注册的僵尸序列化函数

    const on = (e, fn) => (handlers[e] = handlers[e] || []).push(fn);
    const emit = (e, d) => (handlers[e] || []).forEach(f => { try { f(d); } catch (_) {} });
    const broadcast = d => conns.forEach(c => { if (c.conn.open) try { c.conn.send(d); } catch (_) {} });
    const toHost = d => conns.forEach(c => { if (c.conn.open) try { c.conn.send(d); } catch (_) {} });

    function makePeer(id) {
        return new Promise((res, rej) => {
            const p = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
            p.on('open', () => res(p));
            p.on('error', rej);
        });
    }

    /* ---------- 大厅 UI ---------- */
    function buildLobby() {
        if (document.getElementById('lz-lobby')) return;
        const css = document.createElement('style');
        css.textContent = `
        #lz-lobby{position:fixed;inset:0;background:rgba(8,10,16,.92);z-index:99999;
          display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#eee}
        #lz-box{background:#141824;border:2px solid #d62828;border-radius:14px;padding:28px 36px;
          text-align:center;box-shadow:0 0 60px rgba(214,40,40,.35);min-width:330px}
        #lz-box h1{margin:0 0 4px;color:#d62828;font-size:24px}
        #lz-box .sub{font-size:12px;color:#889;margin-bottom:18px}
        .lz-btn{padding:11px 26px;font-size:15px;font-weight:700;border:none;border-radius:8px;
          cursor:pointer;margin:5px;transition:.15s}
        .lz-btn:hover{transform:translateY(-2px)}
        .lz-host{background:#d62828;color:#fff}.lz-join{background:#2a4d8f;color:#fff}
        .lz-start{background:#2ec27e;color:#04120b}.lz-quit{background:#333;color:#ddd}
        #lz-code{font-size:30px;font-weight:900;letter-spacing:5px;color:#2ec27e;margin:10px 0;user-select:all}
        #lz-input{padding:10px;font-size:16px;text-align:center;border-radius:8px;border:none;
          background:#0d1220;color:#fff;width:210px;letter-spacing:3px;text-transform:uppercase}
        #lz-players{margin:12px 0;font-size:14px}
        #lz-players div{background:#0d1220;border-radius:6px;padding:5px;margin:3px 0}
        #lz-status{font-size:12px;color:#778;margin-top:12px;min-height:16px}
        .lz-row{margin:8px 0}`;
        document.head.appendChild(css);

        const el = document.createElement('div');
        el.id = 'lz-lobby';
        el.innerHTML = `
        <div id="lz-box">
          <h1>🧟 学校僵尸入侵</h1><div class="sub">P2P 联机模式</div>
          <div id="lz-menu">
            <button class="lz-btn lz-host" id="lz-b-host">🖥️ 创建房间</button>
            <div class="lz-row"><input id="lz-input" maxlength="10" placeholder="房间码"></div>
            <button class="lz-btn lz-join" id="lz-b-join">🔗 加入房间</button>
          </div>
          <div id="lz-room" style="display:none">
            <div class="sub" style="margin-bottom:0">房间码（发给好友）</div>
            <div id="lz-code"></div>
            <div id="lz-players"></div>
            <button class="lz-btn lz-start" id="lz-b-start" style="display:none">▶ 开始游戏</button>
            <button class="lz-btn lz-quit" id="lz-b-quit">退出</button>
          </div>
          <div id="lz-status"></div>
        </div>`;
        document.body.appendChild(el);

        document.getElementById('lz-b-host').onclick = host;
        document.getElementById('lz-b-join').onclick = join;
        document.getElementById('lz-b-start').onclick = startGame;
        document.getElementById('lz-b-quit').onclick = leave;
    }

    const setStatus = m => { const e = document.getElementById('lz-status'); if (e) e.textContent = m; console.log('[Net]', m); };

    function showRoom(code) {
        document.getElementById('lz-menu').style.display = 'none';
        document.getElementById('lz-room').style.display = 'block';
        document.getElementById('lz-code').textContent = code;
        if (isHost) document.getElementById('lz-b-start').style.display = 'inline-block';
        renderList();
    }

    function renderList() {
        const box = document.getElementById('lz-players');
        if (!box) return;
        let h = `<div>👤 我 (${isHost ? '房主' : '玩家'})</div>`;
        conns.forEach(c => { h += `<div>👤 ${c.name || '玩家…'}</div>`; });
        box.innerHTML = h;
    }

    /* ---------- 房主 ---------- */
    async function host() {
        setStatus('创建房间…');
        try {
            peer = await makePeer();
            myId = peer.id; isHost = true;
            showRoom(myId.slice(0, 8).toUpperCase());
            setStatus('等待玩家加入…');
            peer.on('connection', conn => {
                conn.on('open', () => {
                    conns.set(conn.peer, { conn, name: null });
                    conn.send({ t: 'welcome', hostName: '房主' });
                    renderList();
                });
                conn.on('data', d => onData(conn, d));
                conn.on('close', () => {
                    conns.delete(conn.peer);
                    remoteStates.delete(conn.peer);
                    renderList();
                    emit('playerLeft', conn.peer);
                });
            });
        } catch (e) { setStatus('创建失败: ' + (e.type || e.message)); }
    }

    /* ---------- 加入 ---------- */
    async function join() {
        const code = (document.getElementById('lz-input').value || '').trim().toLowerCase();
        if (!code) { setStatus('请输入房间码'); return; }
        setStatus('连接中…');
        try {
            peer = await makePeer();
            myId = peer.id; isHost = false;
            const conn = peer.connect(code, { reliable: true });
            conn.on('open', () => {
                conns.set(code, { conn, name: '房主' });
                conn.send({ t: 'hi', id: myId });
                showRoom(code.toUpperCase());
                setStatus('已加入，等待房主开始…');
            });
            conn.on('data', d => onData(conn, d));
            conn.on('close', () => { setStatus('与房主断开'); leave(); });
            peer.on('error', e => setStatus('错误: ' + e.type));
        } catch (e) { setStatus('连接失败: ' + (e.type || e.message)); }
    }

    /* ---------- 消息分发 ---------- */
    function onData(conn, d) {
        switch (d.t) {
            case 'welcome': renderList(); break;
            case 'hi':
                if (conns.has(d.id)) { conns.get(d.id).name = '玩家'; renderList(); }
                break;
            case 'start':
                if (!isHost) begin(d.seed);
                break;
            case 'ps': // player state
                remoteStates.set(d.id, { ...d.s, t: performance.now() });
                break;
            case 'zb': // zombies (host authoritative)
                if (!isHost) { zombieSnapshot = d.z; emit('zombieSync', d.z); }
                break;
            case 'sh': // shot fx
                emit('remoteShot', d.s);
                break;
            case 'hs': // client hit zombie -> host applies dmg
                if (isHost && zombiesGetter) zombiesGetter().applyHit(d.zid, d.dmg);
                break;
            case 'leave':
                conns.delete(d.id); remoteStates.delete(d.id);
                emit('playerLeft', d.id); renderList();
                break;
        }
    }

    /* ---------- 开始 / 同步循环 ---------- */
    function startGame() {
        if (!isHost) return;
        const seed = Date.now();
        broadcast({ t: 'start', seed });
        begin(seed);
    }

    function begin(seed) {
        started = true;
        const lb = document.getElementById('lz-lobby');
        if (lb) lb.style.display = 'none';
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            if (!started || !localState) return;
            if (isHost) {
                broadcast({ t: 'ps', id: myId, s: localState });
                if (zombiesGetter) broadcast({ t: 'zb', z: zombiesGetter().serialize() });
            } else {
                toHost({ t: 'ps', id: myId, s: localState });
            }
        }, TICK_MS);
        emit('gameStart', { seed, isHost });
    }

    /* ---------- 游戏层调用 ---------- */
    function pushLocal(s) { localState = s; }
    function getRemote(id) { return remoteStates.get(id); }
    function eachRemote(fn) { remoteStates.forEach((s, id) => fn(s, id)); }
    function getZombieSnapshot() { return zombieSnapshot; }
    function registerZombies(getter) { zombiesGetter = getter; }
    function sendShot(s) { isHost ? broadcast({ t: 'sh', s }) : toHost({ t: 'sh', s }); }
    function sendHitZombie(zid, dmg) { if (!isHost) toHost({ t: 'hs', zid, dmg }); }
    function isNetHost() { return isHost; }
    function active() { return started; }

    function leave() {
        if (started) broadcast({ t: 'leave', id: myId });
        started = false;
        if (timer) { clearInterval(timer); timer = null; }
        conns.forEach(c => { try { c.conn.close(); } catch (_) {} });
        conns.clear(); remoteStates.clear();
        try { peer && peer.destroy(); } catch (_) {}
        peer = null;
        const lb = document.getElementById('lz-lobby');
        if (lb) {
            lb.style.display = 'flex';
            document.getElementById('lz-menu').style.display = 'block';
            document.getElementById('lz-room').style.display = 'none';
        }
    }

    return { on, emit, host, join, leave, pushLocal, getRemote, eachRemote,
             getZombieSnapshot, registerZombies, sendShot, sendHitZombie,
             isNetHost, active, buildLobby };
})();

/* ============================================================
 * 第二部分: 实体
 * ============================================================ */
class Player {
    constructor(id, isLocal) {
        this.id = id; this.local = isLocal;
        this.x = CFG.MAP_W / 2; this.y = CFG.MAP_H / 2;
        this.angle = 0; this.hp = CFG.PLAYER_MAX_HP;
        this.weapon = 'pistol'; this.fireCd = 0;
        this.score = 0; this.kills = 0;
        this.hurtFlash = 0;
    }
    takeDamage(d) {
        this.hp -= d; this.hurtFlash = 10;
        if (this.hp <= 0) { this.hp = 0; return true; } // 死亡
        return false;
    }
    serialize() {
        return { x: +this.x.toFixed(1), y: +this.y.toFixed(1),
                 angle: +this.angle.toFixed(2), hp: this.hp,
                 weapon: this.weapon };
    }
}

class Zombie {
    constructor(x, y, speedMul = 1) {
        this.x = x; this.y = y;
        this.hp = 50 + Game.wave * 8;
        this.maxHp = this.hp;
        this.speed = (CFG.ZOMBIE_SPEED + rand(-.3, CFG.ZOMBIE_SPEED_VARIANCE)) * speedMul;
        this.radius = CFG.ZOMBIE_RADIUS;
        this.atkCd = 0;
        this.walkPhase = rand(0, Math.PI * 2);
        this.dead = false;
    }
    update(dt) {
        if (this.dead) return;
        // 追踪最近的玩家(本地或远程)
        let target = Game.player, best = dist(this, Game.player);
        Net.eachRemote(s => {
            const d = Math.hypot(this.x - s.x, this.y - s.y);
            if (d < best) { best = d; target = s; }
        });
        if (target) {
            const a = Math.atan2(target.y - this.y, target.x - this.x);
            this.x += Math.cos(a) * this.speed * dt;
            this.y += Math.sin(a) * this.speed * dt;
            this.angle = a;
            this.walkPhase += 0.2 * dt;
            // 攻击
            if (best < this.radius + CFG.PLAYER_RADIUS && this.atkCd <= 0) {
                this.atkCd = CFG.ZOMBIE_ATK_CD;
                if (target === Game.player) {
                    Game.onLocalHit(CFG.ZOMBIE_DMG);
                } else {
                    // 远程玩家受伤由其自身判定，此处仅视觉
                }
            }
            this.atkCd -= dt;
        }
    }
    serialize() {
        return { x: +this.x.toFixed(1), y: +this.y.toFixed(1),
                 hp: this.hp, dead: this.dead ? 1 : 0,
                 wp: +this.walkPhase.toFixed(2) };
    }
}

class Bullet {
    constructor(x, y, angle, weaponKey, ownerLocal) {
        const w = WEAPONS[weaponKey];
        this.x = x; this.y = y;
        this.vx = Math.cos(angle) * w.speed;
        this.vy = Math.sin(angle) * w.speed;
        this.dmg = w.dmg;
        this.life = 80; this.dead = false;
        this.ownerLocal = ownerLocal;
        this.trail = [];
    }
    update(dt) {
        this.trail.push({ x: this.x, y: this.y });
        if (this.trail.length > 5) this.trail.shift();
        this.x += this.vx * dt; this.y += this.vy * dt;
        this.life -= dt;
        if (this.life <= 0 || this.x < 0 || this.y < 0 ||
            this.x > CFG.MAP_W || this.y > CFG.MAP_H) this.dead = true;
        // 碰僵尸
        for (const z of Game.zombies) {
            if (z.dead) continue;
            if (Math.hypot(this.x - z.x, this.y - z.y) < z.radius + 4) {
                this.dead = true;
                if (this.ownerLocal) {
                    if (Net.active() && !Net.isNetHost()) Net.sendHitZombie(Game.zombies.indexOf(z), this.dmg);
                    else z.hp -= this.dmg; // 单机或房主直接扣
                    if (z.hp <= 0 && !z.dead) {
                        z.dead = true;
                        Game.player.kills++;
                        Game.player.score += 10;
                    }
                }
                break;
            }
        }
    }
}

/* ============================================================
 * 第三部分: 游戏主控
 * ============================================================ */
const Game = (() => {
    let canvas, ctx;
    let running = false;
    let waveTimer = 0, waveActive = false;
    let zombiesThisWave = 0, zombiesKilledThisWave = 0;
    const keys = {};
    const mouse = { x: 0, y: 0, down: false };

    const state = {
        player: null,
        zombies: [],
        bullets: [],
        particles: [],
        wave: 0,
        score: 0,
        frame: 0,
        gameOver: false
    };

    /* ---------- 画布初始化 ---------- */
    function initCanvas() {
        canvas = document.getElementById('game') ||
                 document.getElementById('gameCanvas') ||
                 document.querySelector('canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'game';
            document.body.style.margin = '0';
            document.body.style.overflow = 'hidden';
            document.body.appendChild(canvas);
        }
        ctx = canvas.getContext('2d');
        resize();
        window.addEventListener('resize', resize);
    }
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    /* ---------- 波次 ---------- */
    function spawnWave() {
        state.wave++;
        const n = CFG.ZOMBIES_PER_WAVE_BASE + state.wave * 2;
        zombiesThisWave = n;
        zombiesKilledThisWave = 0;
        for (let i = 0; i < n; i++) {
            // 从地图边缘刷
            const side = Math.floor(rand(0, 4));
            let x, y;
            if (side === 0) { x = rand(0, CFG.MAP_W); y = -30; }
            else if (side === 1) { x = CFG.MAP_W + 30; y = rand(0, CFG.MAP_H); }
            else if (side === 2) { x = rand(0, CFG.MAP_W); y = CFG.MAP_H + 30; }
            else { x = -30; y = rand(0, CFG.MAP_H); }
            // 波次越高效率越快
            state.zombies.push(new Zombie(x, y, 1 + state.wave * 0.06));
        }
        waveActive = true;
        // 武器补给: 每波给近战武器弹药
        if (state.wave % 3 === 0) state.player.weapon = 'shotgun';
        else if (state.wave % 5 === 0) state.player.weapon = 'smg';
    }

    /* ---------- 输入 ---------- */
    function bindInput() {
        window.addEventListener('keydown', e => {
            keys[e.key.toLowerCase()] = true;
            // 数字键切枪
            if (e.key === '1') state.player.weapon = 'pistol';
            if (e.key === '2') state.player.weapon = 'shotgun';
            if (e.key === '3') state.player.weapon = 'smg';
        });
        window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
        canvas.addEventListener('mousemove', e => {
            const r = canvas.getBoundingClientRect();
            mouse.x = e.clientX - r.left;
            mouse.y = e.clientY - r.top;
        });
        canvas.addEventListener('mousedown', () => mouse.down = true);
        window.addEventListener('mouseup', () => mouse.down = false);
        // 触屏支持
        canvas.addEventListener('touchstart', e => {
            const t = e.touches[0], r = canvas.getBoundingClientRect();
            mouse.x = t.clientX - r.left; mouse.y = t.clientY - r.top; mouse.down = true;
        });
        canvas.addEventListener('touchmove', e => {
            const t = e.touches[0], r = canvas.getBoundingClientRect();
            mouse.x = t.clientX - r.left; mouse.y = t.clientY - r.top;
        });
        canvas.addEventListener('touchend', () => mouse.down = false);
    }

    /* ---------- 本地玩家受伤 ---------- */
    function onLocalHit(dmg) {
        if (state.gameOver) return;
        if (state.player.takeDamage(dmg)) {
            state.gameOver = true;
            running = false;
        }
    }

    /* ---------- 射击 ---------- */
    function shoot() {
        const p = state.player;
        const w = WEAPONS[p.weapon];
        if (p.fireCd > 0) return;
        p.fireCd = w.cd;
        const pellets = w.pellets || 1;
        for (let i = 0; i < pellets; i++) {
            const a = p.angle + rand(-w.spread, w.spread);
            state.bullets.push(new Bullet(
                p.x + Math.cos(a) * 20,
                p.y + Math.sin(a) * 20,
                a, p.weapon, true
            ));
        }
        // 网络同步射击特效
        if (Net.active()) Net.sendShot({ x: p.x, y: p.y, a: p.angle, w: p.weapon });
        // 枪口粒子
        for (let i = 0; i < 3; i++) spawnParticle(
            p.x + Math.cos(p.angle) * 24,
            p.y + Math.sin(p.angle) * 24,
            '#ffd166', 4);
    }

    function spawnParticle(x, y, color, size) {
        state.particles.push({
            x, y, color, size,
            vx: rand(-2, 2), vy: rand(-2, 2), life: 20
        });
    }

    /* ---------- 僵尸序列化器(供网络层) ---------- */
    const zombieSync = {
        serialize() {
            return { w: state.wave,
                     list: state.zombies.map(z => z.serialize()) };
        },
        applyHit(idx, dmg) {
            const z = state.zombies[idx];
            if (!z || z.dead) return;
            z.hp -= dmg;
            if (z.hp <= 0 && !z.dead) {
                z.dead = true;
                state.player.kills++;
                zombiesKilledThisWave++;
            }
        }
    };

    /* ---------- 主更新 ---------- */
    function update(dt) {
        state.frame++;
        const p = state.player;

        // 玩家移动 (仅本地玩家自己模拟)
        let dx = 0, dy = 0;
        if (keys['w'] || keys['arrowup']) dy -= 1;
        if (keys['s'] || keys['arrowdown']) dy += 1;
        if (keys['a'] || keys['arrowleft']) dx -= 1;
        if (keys['d'] || keys['arrowright']) dx += 1;
        if (dx || dy) {
            const len = Math.hypot(dx, dy);
            p.x = clamp(p.x + (dx / len) * CFG.PLAYER_SPEED * dt, CFG.PLAYER_RADIUS, CFG.MAP_W - CFG.PLAYER_RADIUS);
            p.y = clamp(p.y + (dy / len) * CFG.PLAYER_SPEED * dt, CFG.PLAYER_RADIUS, CFG.MAP_H - CFG.PLAYER_RADIUS);
        }
        // 朝向鼠标
        p.angle = Math.atan2(mouse.y - p.y, mouse.x - p.x);
        if (p.fireCd > 0) p.fireCd -= dt;
        if (p.hurtFlash > 0) p.hurtFlash -= dt;
        if (mouse.down) shoot();

        // 僵尸更新: 房主模拟 / 单机模拟; 客户机用快照
        if (!Net.active() || Net.isNetHost()) {
            state.zombies.forEach(z => z.update(dt));
            // 清理死亡
            const before = state.zombies.length;
            state.zombies = state.zombies.filter(z => !z.dead);
            zombiesKilledThisWave += before - state.zombies.length - zombiesKilledThisWave >= 0 ? 0 : 0;
            // 波次推进
            if (waveActive && state.zombies.length === 0) {
                waveActive = false;
                waveTimer = CFG.WAVE_INTERVAL;
                p.score += 50;
            }
            if (!waveActive) {
                waveTimer -= dt;
                if (waveTimer <= 0) spawnWave();
            }
        } else {
            // 客户机: 从快照重建僵尸
            const snap = Net.getZombieSnapshot();
            if (snap && snap.list) {
                while (state.zombies.length < snap.list.length)
                    state.zombies.push(new Zombie(0, 0));
                state.zombies.length = snap.list.length;
                state.zombies.forEach((z, i) => {
                    const s = snap.list[i];
                    if (!s) return;
                    z.x = lerp(z.x, s.x, 0.3);
                    z.y = lerp(z.y, s.y, 0.3);
                    z.hp = s.hp; z.dead = !!s.dead;
                    z.walkPhase = s.wp;
                });
                state.wave = snap.w;
            }
        }

        // 子弹
        state.bullets.forEach(b => b.update(dt));
        state.bullets = state.bullets.filter(b => !b.dead);

        // 粒子
        state.particles.forEach(pt => {
            pt.x += pt.vx; pt.y += pt.vy; pt.life--;
        });
        state.particles = state.particles.filter(pt => pt.life > 0);

        // 同步本地状态给网络层
        if (Net.active()) Net.pushLocal(p.serialize());
    }

    /* ---------- 渲染 ---------- */
    function draw() {
        const W = canvas.width, H = canvas.height;
        // 背景(学校操场风格)
        ctx.fillStyle = '#2a3328';
        ctx.fillRect(0, 0, W, H);
        // 网格
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

        // 地图边界(教学楼墙)
        ctx.strokeStyle = '#5c4a3a';
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, CFG.MAP_W - 8, CFG.MAP_H - 8);

        // 远程玩家
        Net.eachRemote((s, id) => {
            drawPlayerShape(s.x, s.y, s.angle, '#4d96ff', s.hp / CFG.PLAYER_MAX_HP);
        });

        // 本地玩家
        const p = state.player;
        if (p) drawPlayerShape(p.x, p.y, p.angle, p.hurtFlash > 0 ? '#ff6b6b' : '#2ec27e', p.hp / CFG.PLAYER_MAX_HP);

        // 僵尸
        state.zombies.forEach(z => {
            if (z.dead) return;
            const bob = Math.sin(z.walkPhase) * 2;
            ctx.save();
            ctx.translate(z.x, z.y + bob);
            // 身体
            ctx.fillStyle = '#7a9e4f';
            ctx.beginPath(); ctx.arc(0, 0, z.radius, 0, Math.PI * 2); ctx.fill();
            // 眼睛
            ctx.fillStyle = '#d62828';
            const ea = z.angle || 0;
            ctx.beginPath(); ctx.arc(Math.cos(ea) * 6 - 4, Math.sin(ea) * 6, 3, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(Math.cos(ea) * 6 + 4, Math.sin(ea) * 6, 3, 0, Math.PI * 2); ctx.fill();
            // 血条
            const ratio = z.hp / z.maxHp;
            ctx.fillStyle = '#333';
            ctx.fillRect(-16, -z.radius - 10, 32, 4);
            ctx.fillStyle = ratio > .5 ? '#2ec27e' : ratio > .25 ? '#ffd166' : '#d62828';
            ctx.fillRect(-16, -z.radius - 10, 32 * ratio, 4);
            ctx.restore();
        });

        // 子弹(带拖尾)
        state.bullets.forEach(b => {
            ctx.strokeStyle = 'rgba(255,209,102,0.5)';
            ctx.lineWidth = 2;
            if (b.trail.length > 1) {
                ctx.beginPath();
                ctx.moveTo(b.trail[0].x, b.trail[0].y);
                b.trail.forEach(pt => ctx.lineTo(pt.x, pt.y));
                ctx.stroke();
            }
            ctx.fillStyle = '#ffd166';
            ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2); ctx.fill();
        });

        // 粒子
        state.particles.forEach(pt => {
            ctx.globalAlpha = pt.life / 20;
            ctx.fillStyle = pt.color;
            ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size * pt.life / 20, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = 1;

        // HUD
        drawHUD();

        // 死亡画面
        if (state.gameOver) {
            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#d62828';
            ctx.font = 'bold 56px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('你被僵尸吃掉了', W / 2, H / 2 - 20);
            ctx.fillStyle = '#fff';
            ctx.font = '22px system-ui';
            ctx.fillText(`波次 ${state.wave} · 击杀 ${p.kills} · 得分 ${p.score}`, W / 2, H / 2 + 30);
            ctx.font = '16px system-ui';
            ctx.fillStyle = '#889';
            ctx.fillText('按 R 重新开始', W / 2, H / 2 + 70);
        }
    }

    function drawPlayerShape(x, y, angle, color, hpRatio) {
        ctx.save();
        ctx.translate(x, y);
        // 血条
        ctx.fillStyle = '#222';
        ctx.fillRect(-18, -CFG.PLAYER_RADIUS - 12, 36, 5);
        ctx.fillStyle = color;
        ctx.fillRect(-18, -CFG.PLAYER_RADIUS - 12, 36 * clamp(hpRatio, 0, 1), 5);
        ctx.rotate(angle);
        // 身体
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(0, 0, CFG.PLAYER_RADIUS, 0, Math.PI * 2); ctx.fill();
        // 手持武器(枪管)
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(CFG.PLAYER_RADIUS - 4, -3, 18, 6);
        // 面部方向指示
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(8, 0, 4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    function drawHUD() {
        const p = state.player;
        if (!p) return;
        ctx.textAlign = 'left';
        // 血量
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(20, 20, 220, 30);
        ctx.fillStyle = '#d62828';
        ctx.fillRect(24, 24, 212 * (p.hp / CFG.PLAYER_MAX_HP), 22);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px system-ui';
        ctx.fillText(`❤ ${Math.ceil(p.hp)}`, 30, 40);

        // 分数/波次
        ctx.font = 'bold 18px system-ui';
        ctx.fillStyle = '#ffd166';
        ctx.fillText(`波次 ${state.wave}`, 20, 78);
        ctx.fillStyle = '#fff';
        ctx.fillText(`得分 ${p.score}`, 20, 102);
        ctx.fillText(`击杀 ${p.kills}`, 20, 126);

        // 武器
        ctx.fillStyle = '#2ec27e';
        ctx.fillText(`🔫 ${WEAPONS[p.weapon].name}`, 20, 150);

        // 联机状态
        if (Net.active()) {
            ctx.fillStyle = '#4d96ff';
            ctx.font = '13px system-ui';
            ctx.fillText(Net.isNetHost() ? '🌐 联机中 [房主]' : '🌐 联机中 [玩家]', 20, 172);
        }
    }

    /* ---------- 重开 ---------- */
    function restart() {
        state.player = new Player('local', true);
        state.zombies = []; state.bullets = []; state.particles = [];
        state.wave = 0; state.score = 0; state.gameOver = false;
        waveActive = false; waveTimer = 60;
        running = true;
    }

    /* ---------- 主循环 ---------- */
    let lastT = 0;
    function loop(t) {
        const dt = clamp((t - lastT) / (1000 / 60), 0, 3); // 归一化到60fps基准
        lastT = t;
        if (running && !state.gameOver) update(dt);
        if (state.player) draw();
        requestAnimationFrame(loop);
    }

    /* ---------- 启动 ---------- */
    function boot() {
        initCanvas();
        bindInput();
        Net.buildLobby();

        // P2P 事件
        Net.on('gameStart', () => {
            restart();
        });
        Net.on('remoteShot', s => {
            // 远程射击特效
            for (let i = 0; i < 2; i++) spawnParticle(
                s.x + Math.cos(s.a) * 24, s.y + Math.sin(s.a) * 24, '#4d96ff', 3);
            if (!Net.isNetHost()) {
                const w = WEAPONS[s.w];
                for (let i = 0; i < (w.pellets || 1); i++) {
                    const a = s.a + rand(-w.spread, w.spread);
                    state.bullets.push(new Bullet(
                        s.x + Math.cos(a) * 20, s.y + Math.sin(a) * 20,
                        a, s.w, false)); // 非本地子弹不参与伤害判定
                }
            }
        });
        Net.on('playerLeft', () => {});

        // 房主注册僵尸同步器
        Net.registerZombies(zombieSync);

        // R 重开
        window.addEventListener('keydown', e => {
            if (e.key.toLowerCase() === 'r' && state.gameOver) restart();
        });

        // 单机模式: 大厅也提供"直接单机"入口
        const soloBtn = document.createElement('button');
        soloBtn.className = 'lz-btn lz-quit';
        soloBtn.textContent = '🎮 单人模式';
        soloBtn.style.marginTop = '10px';
        soloBtn.onclick = () => {
            document.getElementById('lz-lobby').style.display = 'none';
            restart();
        };
        document.getElementById('lz-box').appendChild(soloBtn);

        requestAnimationFrame(t => { lastT = t; loop(t); });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return state; // 调试用
})();
