/* ============================================================
 * p2p.js v3 — 生化·校园突围 联机核心（完整版）
 * 新增：
 *   1. 丧尸快照广播 zb（房主 → 全员，10Hz，节省带宽）
 *   2. 客户端命中上报 hs → 房主结算，下一帧快照广播回全体
 *   3. 全局状态 gs（波次/击杀）广播，客户端 HUD 对齐
 *   4. 玩家 HP 已随 ps 通道同步（v2 已有，此版保持）
 * 依赖: peerjs 1.5.x（必须先于本文件引入）
 * ============================================================ */
const P2P = (() => {
  'use strict';
  const OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 1 };
  const TICK_MS   = 1000 / 20;  // 玩家状态 20Hz
  const ZB_EVERY  = 2;          // 每 2 个 tick 广播一次丧尸 → 10Hz
  const GS_EVERY  = 40;         // 全局状态（波次/击杀）每 40 tick → 0.5Hz
  const CODE_RE = /^[A-Z0-9]{6}$/;

  let phase = 'off'; // off | lobby | game
  let peer = null, hostConn = null;
  let isHost = false, code = '', myName = '玩家', myId = null;

  const conns = new Map();      // 房主: peerId → {conn,name,hp}
  const remotes = new Map();    // peerId → 快照(渲染用)
  let local = null, timer = null, zbGet = null, gsGet = null, tickN = 0;

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
        conns.set(conn.peer, { conn, id: conn.peer, name: null, hp: 100 });
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
  const gameRoster = () => {
    const r = [{ id: myId, name: myName, isHost: true, hp: local ? local.hp : 100 }];
    conns.forEach(c => r.push({ id: c.id, name: c.name || '…', isHost: false, hp: c.hp == null ? 100 : c.hp }));
    return r;
  };
  async function enterGame(o) {
    if (phase !== 'off') await shutdown();
    phase = 'game';
    isHost = !!o.isHost;
    code = (o.code || '').toUpperCase();
    myName = (o.name || '玩家').slice(0, 8);
    if (isHost) {
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        try { peer = await makePeer('zv' + code + 'G'); ok = true; }
        catch (e) { if (i === 5) throw e; await sleep(900); }
      }
      peer.on('connection', conn => {
        conn.on('open', () => {
          conns.set(conn.peer, { conn, id: conn.peer, name: '…', hp: 100 });
          conn.send({ t: 'you', id: conn.peer });
          emit('players', gameRoster());
        });
        conn.on('data', d => hostRecv(conn, d));
        conn.on('close', () => {
          conns.delete(conn.peer);
          remotes.delete(conn.peer);
          bcast({ t: 'left', id: conn.peer });
          emit('players', gameRoster());
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
        // 客户端命中丧尸 → 房主结算；结算结果随下一帧 zb 快照广播给全员
        emit('hit-zombie', d);
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
      case 'zb': emit('zombies', d.z); break;          // ✅ 已激活
      case 'gs': emit('game-state', d.s); break;       // ✅ 已激活
    }
  }

  function netTick() {
    if (phase !== 'game') return;
    tickN++;
    if (isHost) {
      if (local) bcast({ t: 'ps', id: myId, s: local });
      if (zbGet && tickN % ZB_EVERY === 0) {
        const z = zbGet();
        if (z && z.list) bcast({ t: 'zb', z });
      }
      if (gsGet && tickN % GS_EVERY === 0) {
        const s = gsGet();
        if (s) bcast({ t: 'gs', s });
      }
    } else if (local) {
      toHost({ t: 'ps', s: local });
    }
  }

  async function shutdown() {
    phase = 'off';
    if (timer) { clearInterval(timer); timer = null; }
    conns.forEach(c => { try { c.conn.close(); } catch (_) {} });
    conns.clear();
    try { hostConn && hostConn.close(); } catch (_) {}
    hostConn = null;
    remotes.clear(); local = null; zbGet = null; gsGet = null;
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
    sendShot: s => { isHost ? bcast({ t: 'shot', s, id: myId }) : toHost({ t: 'shot', s }); },
    sendHitZombie: (i, dmg) => { if (!isHost) toHost({ t: 'hs', i, dmg }); },
    hostZombies:   fn => { zbGet = fn; },     // ✅ 房主注册丧尸序列化器
    hostGameState: fn => { gsGet = fn; },     // ✅ 房主注册全局状态（波次/击杀）
    isHost: () => isHost,
    inGame: () => phase === 'game',
    info: () => ({ phase, isHost, code, name: myName, id: myId })
  };
})();
window.P2P = P2P;
