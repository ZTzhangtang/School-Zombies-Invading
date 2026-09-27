/* ============================================================
 * p2p.js v4 — 生化·校园突围 联机核心
 *
 * 相对 v3 的关键修复：
 *   1. 丧尸快照带稳定 id + 类型 + boss + dead 标记（不再用数组下标）
 *   2. 命中改按【丧尸稳定 id】上报结算，房主查表 → 不再打错目标
 *   3. 新增团队生命协议：dead / aliveMap / all-dead / restart
 *      · 单人阵亡 → 观战，不弹本机结算
 *      · 全员阵亡 → 房主广播 all-dead，统一定时 restart
 *   4. 玩家快照 ps 附带 alive，全员可见队友存活状态
 *
 * 依赖: peerjs 1.5.x（必须先于本文件引入）
 * ============================================================ */
const P2P = (() => {
  'use strict';
  const OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 1 };
  const TICK_MS   = 1000 / 20;  // 玩家状态 20Hz
  const ZB_EVERY  = 2;          // 每 2 个 tick 广播一次丧尸 → 10Hz
  const GS_EVERY  = 40;         // 全局状态（波次/击杀）每 40 tick → 0.5Hz
  const CODE_RE   = /^[A-Z0-9]{6}$/;
  const RESTART_DELAY = 3000;   // 全员阵亡 → 结算显示 3 秒后统一重开

  let phase = 'off'; // off | lobby | game
  let peer = null, hostConn = null;
  let isHost = false, code = '', myName = '玩家', myId = null;

  const conns = new Map();      // 房主: peerId → {conn,name,hp,alive}
  const remotes = new Map();    // peerId → 快照(渲染用)
  let local = null, timer = null, zbGet = null, gsGet = null, tickN = 0;

  /* ---- 团队生命（房主权威）---- */
  let localAlive = true;        // 自己是否存活
  let matchOver  = false;       // 本局是否已进入"全员阵亡"流程
  let restartAt  = 0;           // 房主计划重开的时间戳

  const handlers = {};
  const on   = (e, f) => (handlers[e] = handlers[e] || []).push(f);
  const emit = (e, d) => (handlers[e] || []).forEach(f => { try { f(d); } catch (_) {} });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function randCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += A[(Math.random() * A.length) | 0];
    return s;
  }
  function makePeer(id) {
    if (typeof Peer === 'undefined') throw { type: 'peerjs-missing' };
    return new Promise((res, rej) => {
      const p = id ? new Peer(id, OPTS) : new Peer(OPTS);
      const to = setTimeout(() => rej({ type: 'timeout' }), 15000);
      p.on('open', i => { clearTimeout(to); myId = i; res(p); });
      p.on('error', e => { if (!p.open) { clearTimeout(to); rej(e); } });
    });
  }
  function waitOpen(conn, timeout = 12000) {
    return new Promise((res, rej) => {
      if (conn.open) return res();
      const to = setTimeout(() => rej({ type: 'conn-timeout' }), timeout);
      conn.on('open',  () => { clearTimeout(to); res(); });
      conn.on('error', e => { clearTimeout(to); rej(e); });
    });
  }
  const bcast  = (m, except) => conns.forEach((c, id) => {
    if (id !== except && c.conn.open) try { c.conn.send(m); } catch (_) {}
  });
  const toHost = m => { if (hostConn && hostConn.open) try { hostConn.send(m); } catch (_) {} };

  /* ---------------- 大厅 ---------------- */
  const lobbyRoster = () => {
    const r = [{ id: myId, name: myName, isHost }];
    conns.forEach(c => r.push({ id: c.id, name: c.name || '…', isHost: false }));
    return r;
  };
  async function hostLobby(name) {
    if (phase !== 'off') await shutdown();
    myName = (name || '房主').slice(0, 8);
    isHost = true; phase = 'lobby';
    code = randCode();
    peer = await makePeer('zv' + code + 'L');
    peer.on('connection', conn => {
      conn.on('open', () => {
        conns.set(conn.peer, { conn, id: conn.peer, name: null, hp: 100, alive: true });
        conn.send({ t: 'lobby', code, players: lobbyRoster() });
        bcast({ t: 'lobby', code, players: lobbyRoster() }, conn.peer);
        emit('players', lobbyRoster());
      });
      conn.on('data', d => {
        if (d && d.t === 'hi') {
          const c = conns.get(conn.peer);
          if (c) c.name = (d.name || '玩家').slice(0, 8);
          bcast({ t: 'lobby', code, players: lobbyRoster() });
          emit('players', lobbyRoster());
        }
      });
      conn.on('close', () => {
        conns.delete(conn.peer);
        bcast({ t: 'lobby', code, players: lobbyRoster() });
        emit('players', lobbyRoster());
        emit('left', conn.peer);
      });
    });
    emit('players', lobbyRoster());
    return code;
  }
  async function joinLobby(codeIn, name) {
    const cd = (codeIn || '').trim().toUpperCase();
    if (!CODE_RE.test(cd)) throw { type: 'bad-code' };
    if (phase !== 'off') await shutdown();
    myName = (name || '玩家').slice(0, 8);
    isHost = false; phase = 'lobby'; code = cd;
    peer = await makePeer();
    hostConn = peer.connect('zv' + cd + 'L', { reliable: true });
    await waitOpen(hostConn);
    hostConn.send({ t: 'hi', name: myName });
    hostConn.on('data', d => {
      if (!d) return;
      if (d.t === 'lobby') emit('players', d.players);
      else if (d.t === 'start') emit('start', d);
    });
    hostConn.on('close', () => { if (phase === 'lobby') emit('kicked'); });
  }
  function startGame(map) {
    if (phase !== 'lobby' || !isHost) return;
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const msg = { t: 'start', code, seed, map: map.key, file: map.file };
    bcast(msg);
    setTimeout(() => emit('start', msg), 120);
  }

  /* ---------------- 对局 ---------------- */
  /* 队伍名册：含存活标记 */
  const gameRoster = () => {
    const r = [{
      id: myId, name: myName, isHost: true,
      hp: local ? local.hp : 100, alive: localAlive
    }];
    conns.forEach(c => r.push({
      id: c.id, name: c.name || '…', isHost: false,
      hp: c.hp == null ? 100 : c.hp, alive: c.alive !== false
    }));
    return r;
  };
  const aliveCount = () => {
    let n = localAlive ? 1 : 0;
    conns.forEach(c => { if (c.alive !== false) n++; });
    return n;
  };
  const totalCount = () => 1 + conns.size;

  /* 房主：检查是否全员阵亡 */
  function checkAllDead() {
    if (!isHost || phase !== 'game' || matchOver) return;
    if (aliveCount() > 0) return;
    matchOver = true;
    restartAt = performance.now() + RESTART_DELAY;
    emit('all-dead', { wave: null });
    bcast({ t: 'all-dead' });
  }

  async function enterGame(o) {
    if (phase !== 'off') await shutdown();
    phase = 'game';
    isHost = !!o.isHost;
    code = (o.code || '').toUpperCase();
    myName = (o.name || '玩家').slice(0, 8);
    localAlive = true; matchOver = false; restartAt = 0;
    if (isHost) {
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        try { peer = await makePeer('zv' + code + 'G'); ok = true; }
        catch (e) { if (i === 5) throw e; await sleep(900); }
      }
      peer.on('connection', conn => {
        conn.on('open', () => {
          conns.set(conn.peer, { conn, id: conn.peer, name: '…', hp: 100, alive: true });
          conn.send({ t: 'you', id: conn.peer });
          conn.send({ t: 'team', roster: gameRoster() });
          emit('players', gameRoster());
        });
        conn.on('data', d => hostRecv(conn, d));
        conn.on('close', () => {
          conns.delete(conn.peer);
          remotes.delete(conn.peer);
          bcast({ t: 'left', id: conn.peer });
          emit('players', gameRoster());
          checkAllDead();
        });
      });
    } else {
      peer = await makePeer();
      hostConn = await connectRetry('zv' + code + 'G');
      hostConn.on('data', clientRecv);
      hostConn.on('close', () => emit('host-lost'));
      hostConn.send({ t: 'hi', name: myName });
    }
    timer = setInterval(netTick, TICK_MS);
    emit('game-enter', { code, isHost });
  }
  async function connectRetry(id, tries = 25) {
    for (let i = 0; i < tries; i++) {
      try {
        const c = peer.connect(id, { reliable: true });
        await waitOpen(c, 4000);
        return c;
      } catch (_) { await sleep(1000); }
    }
    throw { type: 'host-not-found' };
  }

  /* ---------------- 消息分发 ---------------- */
  function hostRecv(conn, d) {
    if (!d) return;
    switch (d.t) {
      case 'hi': {
        const c = conns.get(conn.peer);
        if (c) { c.name = (d.name || '玩家').slice(0, 8); emit('players', gameRoster()); }
        break;
      }
      case 'ps': {
        remotes.set(conn.peer, Object.assign({}, d.s, { id: conn.peer, t: performance.now() }));
        const c = conns.get(conn.peer);
        if (c && d.s) c.hp = d.s.hp;
        bcast({ t: 'ps', id: conn.peer, s: d.s }, conn.peer);
        break;
      }
      case 'shot':
        bcast({ t: 'shot', id: conn.peer, s: d.s }, conn.peer);
        emit('shot', { id: conn.peer, s: d.s });
        break;
      case 'hs':
        // 客户端命中丧尸（按稳定 id）→ 房主结算；结果随下一帧 zb 快照广播给全员
        emit('hit-zombie', d);
        break;
      case 'dead': {
        const c = conns.get(conn.peer);
        if (c && c.alive !== false) {
          c.alive = false;
          emit('players', gameRoster());
          /* 立刻通知其他客户端刷新存活显示 */
          bcast({ t: 'team', roster: gameRoster() }, conn.peer);
          checkAllDead();
        }
        break;
      }
      case 'client-restart-req':
        // 客户端在全员阵亡后请求重开（兜底，正常由房主定时广播）
        if (matchOver) doRestart();
        break;
    }
  }
  function clientRecv(d) {
    if (!d) return;
    switch (d.t) {
      case 'you': myId = d.id; break;
      case 'ps': remotes.set(d.id, Object.assign({}, d.s, { id: d.id, t: performance.now() })); break;
      case 'left': remotes.delete(d.id); break;
      case 'shot': emit('shot', d); break;
      case 'zb': emit('zombies', d.z); break;
      case 'gs': emit('game-state', d.s); break;
      case 'team': emit('players', d.roster); break;
      case 'all-dead':
        matchOver = true;
        emit('all-dead', {});
        break;
      case 'restart':
        matchOver = false; localAlive = true;
        emit('restart', d);
        break;
    }
  }

  function netTick() {
    if (phase !== 'game') return;
    tickN++;
    if (isHost) {
      if (local) bcast({ t: 'ps', id: myId, s: Object.assign({}, local, { alive: localAlive }) });
      if (zbGet && tickN % ZB_EVERY === 0) {
        const z = zbGet();
        if (z && z.list) bcast({ t: 'zb', z });
      }
      if (gsGet && tickN % GS_EVERY === 0) {
        const s = gsGet();
        if (s) bcast({ t: 'gs', s });
      }
      /* 全员阵亡 → 定时统一重开 */
      if (matchOver && restartAt && performance.now() >= restartAt) doRestart();
    } else if (local) {
      toHost({ t: 'ps', s: Object.assign({}, local, { alive: localAlive }) });
    }
  }

  /* 房主：执行统一重开并广播 */
  function doRestart() {
    if (!isHost || !matchOver) return;
    matchOver = false; restartAt = 0;
    localAlive = true;
    conns.forEach(c => { c.alive = true; c.hp = 100; });
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const msg = { t: 'restart', seed };
    bcast(msg);
    emit('restart', msg);
    emit('players', gameRoster());
  }

  /* 本地阵亡：上报 + 更新存活 */
  function reportDeath() {
    if (!localAlive) return;
    localAlive = false;
    if (!isHost) toHost({ t: 'dead' });
    else checkAllDead();
    emit('local-dead', {});
  }

  async function shutdown() {
    phase = 'off';
    if (timer) { clearInterval(timer); timer = null; }
    conns.forEach(c => { try { c.conn.close(); } catch (_) {} });
    conns.clear();
    try { hostConn && hostConn.close(); } catch (_) {}
    hostConn = null;
    remotes.clear(); local = null; zbGet = null; gsGet = null;
    localAlive = true; matchOver = false; restartAt = 0;
    try { peer && peer.destroy(); } catch (_) {}
    peer = null;
  }
  window.addEventListener('beforeunload', () => { try { shutdown(); } catch (_) {} });

  return {
    on, hostLobby, joinLobby, startGame, enterGame,
    leaveLobby: shutdown, shutdown,
    setLocal: s => { local = s; },
    eachRemote: fn => remotes.forEach(fn),
    remoteCount: () => remotes.size,

    /* 命中：按丧尸稳定 id 上报（房主自行结算） */
    sendHitZombie: (id, dmg) => { if (!isHost) toHost({ t: 'hs', i: id, dmg }); },
    sendShot: s => { isHost ? bcast({ t: 'shot', s, id: myId }) : toHost({ t: 'shot', s }); },

    hostZombies:   fn => { zbGet = fn; },
    hostGameState: fn => { gsGet = fn; },

    /* 团队生命 */
    reportDeath,
    forceRestartRequest: () => { if (!isHost && matchOver) toHost({ t: 'client-restart-req' }); },
    aliveCount, totalCount,
    isAlive: () => localAlive,
    matchOver: () => matchOver,
    roster: () => gameRoster(),

    isHost: () => isHost,
    inGame: () => phase === 'game',
    info: () => ({ phase, isHost, code, name: myName, id: myId })
  };
})();
window.P2P = P2P;
