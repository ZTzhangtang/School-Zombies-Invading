/* ============================================================
 * P2P 联机系统 (基于 PeerJS / WebRTC DataChannel)
 * 文件: p2p.js
 * 功能: 房主/客户机 架构, 状态同步, 输入同步, 大厅UI
 * 依赖: 在 index.html 中先引入 <script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
 * ============================================================ */

const P2P = (() => {
    'use strict';

    // ---------- 常量配置 ----------
    const TICK_RATE = 20;              // 同步频率 (每秒20次)
    const TICK_INTERVAL = 1000 / TICK_RATE;
    const PEER_OPTS = {
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 1 // 0=静默 1=仅错误 2=警告 3=全部
    };

    // ---------- 状态 ----------
    let peer = null;               // PeerJS 实例
    let isHost = false;
    let myId = null;
    let connections = new Map();   // connId -> {conn, name, lastState}
    let gameStarted = false;
    let syncTimer = null;
    let localPlayerState = null;   // 本地玩家最新状态
    let remotePlayers = new Map(); // playerId -> 最新状态(渲染用)
    let eventHandlers = {};        // 事件回调
    let inputQueue = [];           // 待发送输入

    // ---------- 大厅UI ----------
    function injectUI() {
        const css = `
        #p2p-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99999;
          display:flex;align-items:center;justify-content:center;font-family:system-ui;color:#fff}
        #p2p-panel{background:#1a1a2e;border:2px solid #e94560;border-radius:16px;
          padding:32px;min-width:340px;text-align:center;box-shadow:0 0 40px rgba(233,69,96,.4)}
        #p2p-panel h2{margin:0 0 8px;color:#e94560;font-size:22px}
        #p2p-panel input{padding:10px;font-size:16px;border-radius:8px;border:none;
          width:220px;margin:8px 0;background:#0f3460;color:#fff;text-align:center}
        #p2p-panel button{padding:10px 24px;font-size:15px;margin:6px;border:none;
          border-radius:8px;cursor:pointer;font-weight:600;transition:.2s}
        .p2p-btn-host{background:#e94560;color:#fff}
        .p2p-btn-join{background:#0f3460;color:#fff}
        .p2p-btn-start{background:#16c79a;color:#000}
        .p2p-btn-cancel{background:#444;color:#fff}
        #p2p-status{margin-top:12px;font-size:13px;color:#aaa;min-height:18px}
        #p2p-roomcode{font-size:28px;font-weight:800;letter-spacing:4px;
          color:#16c79a;margin:8px 0;user-select:all}
        #p2p-players{margin:10px 0;font-size:14px;text-align:left;max-height:150px;overflow:auto}
        #p2p-players div{padding:4px 8px;background:#0f3460;border-radius:6px;margin:3px 0}
        `;
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'p2p-overlay';
        overlay.innerHTML = `
          <div id="p2p-panel">
            <h2>🧟 僵尸入侵 · P2P联机</h2>
            <div id="p2p-menu">
              <button class="p2p-btn-host" onclick="P2P.host()">🖥️ 创建房间</button>
              <br>
              <input id="p2p-join-code" placeholder="输入房间码" maxlength="8">
              <br>
              <button class="p2p-btn-join" onclick="P2P.join()">🔗 加入房间</button>
            </div>
            <div id="p2p-lobby" style="display:none">
              <div style="font-size:13px;color:#aaa">房间码 (发给好友)</div>
              <div id="p2p-roomcode">--------</div>
              <div id="p2p-players"></div>
              <button class="p2p-btn-start" id="p2p-start-btn" onclick="P2P.startGame()" style="display:none">▶ 开始游戏</button>
              <button class="p2p-btn-cancel" onclick="P2P.leave()">退出</button>
            </div>
            <div id="p2p-status"></div>
          </div>`;
        document.body.appendChild(overlay);
    }

    function status(msg) {
        const el = document.getElementById('p2p-status');
        if (el) el.textContent = msg;
        console.log('[P2P]', msg);
    }

    function showLobby(roomCode) {
        document.getElementById('p2p-menu').style.display = 'none';
        document.getElementById('p2p-lobby').style.display = 'block';
        document.getElementById('p2p-roomcode').textContent = roomCode;
        if (isHost) {
            document.getElementById('p2p-start-btn').style.display = 'inline-block';
        }
        refreshPlayerList();
    }

    function refreshPlayerList() {
        const box = document.getElementById('p2p-players');
        if (!box) return;
        let html = '';
        connections.forEach(c => { html += `<div>👤 ${c.name || '玩家'}</div>`; });
        html += `<div>👤 ${localStorage.getItem('p2p_name') || '我'} ${isHost ? '(房主)' : ''}</div>`;
        box.innerHTML = html;
    }

    // ---------- 事件系统 ----------
    function on(evt, fn) { (eventHandlers[evt] = eventHandlers[evt] || []).push(fn); }
    function emit(evt, data) {
        (eventHandlers[evt] || []).forEach(fn => {
            try { fn(data); } catch (e) { console.error(e); }
        });
    }

    // ---------- 创建 Peer ----------
    function createPeer(myId = undefined) {
        return new Promise((resolve, reject) => {
            const p = new Peer(myId, PEER_OPTS);
            p.on('open', id => resolve(p));
            p.on('error', err => reject(err));
        });
    }

    // ---------- 房主逻辑 ----------
    async function host() {
        status('正在创建房间...');
        try {
            peer = await createPeer();
            myId = peer.id;
            isHost = true;
            const roomCode = peer.id.slice(0, 8).toUpperCase();
            showLobby(roomCode);
            status('✅ 房间已创建, 等待玩家加入...');

            peer.on('connection', conn => {
                console.log('[P2P] 新玩家连接:', conn.peer);
                conn.on('open', () => {
                    connections.set(conn.peer, { conn, name: null });
                    refreshPlayerList();
                    // 房主把当前玩家列表广播给新玩家
                    broadcast({ t: 'playerList', players: getPlayerList() });
                    conn.send({ t: 'welcome', yourId: conn.peer, hostId: myId });
                });
                conn.on('data', d => handleData(conn, d));
                conn.on('close', () => {
                    connections.delete(conn.peer);
                    remotePlayers.delete(conn.peer);
                    refreshPlayerList();
                    broadcast({ t: 'playerLeft', id: conn.peer });
                    emit('playerLeft', conn.peer);
                    status(`玩家 ${conn.peer} 已离开`);
                });
            });
        } catch (err) {
            status('❌ 创建失败: ' + err.type);
            console.error(err);
        }
    }

    function getPlayerList() {
        const list = [{ id: myId, name: localStorage.getItem('p2p_name') || '房主', isHost: true }];
        connections.forEach((c, id) => list.push({ id, name: c.name, isHost: false }));
        return list;
    }

    // ---------- 客户端逻辑 ----------
    async function join() {
        const code = (document.getElementById('p2p-join-code').value || '').trim().toUpperCase();
        if (!code) { status('⚠️ 请输入房间码'); return; }
        status('正在连接...');
        try {
            peer = await createPeer();
            myId = peer.id;
            isHost = false;
            const conn = peer.connect(code.toLowerCase(), { reliable: true });
            conn.on('open', () => {
                connections.set(code.toLowerCase(), { conn, name: '房主' });
                showLobby(code);
                status('✅ 已加入房间, 等待房主开始...');
            });
            conn.on('data', d => handleData(conn, d));
            conn.on('close', () => { status('❌ 与房主断开连接'); cleanup(); });
            peer.on('error', err => status('❌ ' + err.type));
        } catch (err) {
            status('❌ 连接失败: ' + err.type);
        }
    }

    // ---------- 消息处理 ----------
    function handleData(conn, data) {
        switch (data.t) {
            case 'welcome':
                refreshPlayerList();
                break;
            case 'playerList':
                if (!isHost) {
                    // 客户端根据列表补全连接 (Mesh / 星型由房主转发)
                    data.players.forEach(p => {
                        if (p.id !== myId && !connections.has(p.id)) {
                            const c = peer.connect(p.id, { reliable: true });
                            c.on('open', () => connections.set(p.id, { conn: c, name: p.name }));
                        } else if (connections.has(p.id)) {
                            connections.get(p.id).name = p.name;
                        }
                    });
                    refreshPlayerList();
                }
                break;
            case 'start':
                if (!isHost) beginGame(data.settings);
                break;
            case 'state':
                // 收到远程玩家状态 -> 更新远程玩家渲染数据
                remotePlayers.set(data.id, data.s);
                emit('remoteState', { id: data.id, s: data.s });
                break;
            case 'zombie':
                // 僵尸由房主权威同步
                if (!isHost) emit('remoteZombie', data.d);
                break;
            case 'hit':
                emit('remoteHit', data.d);
                break;
            case 'shot':
                emit('remoteShot', data.d);
                break;
            case 'playerLeft':
                remotePlayers.delete(data.id);
                emit('playerLeft', data.id);
                break;
            case 'chat':
                emit('chat', data.d);
                break;
        }
    }

    // ---------- 广播 / 发送 ----------
    function broadcast(data) {
        connections.forEach(c => {
            if (c.conn.open) { try { c.conn.send(data); } catch (e) {} }
        });
    }

    function sendToHost(data) {
        connections.forEach(c => {
            if (c.conn.open) { try { c.conn.send(data); } catch (e) {} }
        });
    }

    // ---------- 同步循环 ----------
    function beginSyncLoop() {
        if (syncTimer) return;
        syncTimer = setInterval(() => {
            if (!gameStarted) return;
            if (localPlayerState) {
                const msg = { t: 'state', id: myId, s: localPlayerState };
                isHost ? broadcast(msg) : sendToHost(msg);
                // 房主还需要广播僵尸状态 (权威同步)
                if (isHost && eventHandlers.hostZombies) {
                    const zd = eventHandlers.hostZombies();
                    if (zd) broadcast({ t: 'zombie', d: zd });
                }
            }
        }, TICK_INTERVAL);
    }

    // ---------- 开始游戏 ----------
    function startGame() {
        if (!isHost) return;
        const settings = { seed: Date.now(), wave: 1 };
        broadcast({ t: 'start', settings });
        beginGame(settings);
    }

    function beginGame(settings) {
        gameStarted = true;
        document.getElementById('p2p-overlay').style.display = 'none';
        beginSyncLoop();
        emit('gameStart', settings);
        status('🎮 游戏开始! (P2P模式)');
    }

    // ---------- 公开API: 游戏主循环调用 ----------
    function updateLocalPlayer(state) {
        // state 格式: {x, y, angle, hp, weapon, frame}
        localPlayerState = state;
    }

    function getRemotePlayers() {
        return remotePlayers; // 游戏渲染层遍历此 Map 绘制其他玩家
    }

    function sendShot(data) {
        const msg = { t: 'shot', d: { shooter: myId, ...data } };
        isHost ? broadcast(msg) : sendToHost(msg);
    }

    function sendHit(targetId, dmg) {
        const msg = { t: 'hit', d: { target: targetId, dmg, from: myId } };
        isHost ? broadcast(msg) : sendToHost(msg);
    }

    function hostSyncZombies(getter) {
        // 游戏注册一个函数, 返回所有僵尸的序列化状态
        eventHandlers.hostZombies = getter;
    }

    function sendChat(text) {
        const msg = { t: 'chat', d: { from: myId, text } };
        broadcast(msg);
    }

    // ---------- 退出 ----------
    function leave() {
        broadcast({ t: 'playerLeft', id: myId });
        cleanup();
    }

    function cleanup() {
        gameStarted = false;
        if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
        connections.forEach(c => { try { c.conn.close(); } catch (e) {} });
        connections.clear();
        remotePlayers.clear();
        if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
        const ov = document.getElementById('p2p-overlay');
        if (ov) ov.style.display = 'flex';
        document.getElementById('p2p-menu').style.display = 'block';
        document.getElementById('p2p-lobby').style.display = 'none';
    }

    // ---------- 初始化 ----------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }

    return {
        on, emit, host, join, leave,
        startGame, updateLocalPlayer,
        getRemotePlayers, sendShot, sendHit,
        hostSyncZombies, sendChat,
        isHost: () => isHost,
        myId: () => myId,
        connected: () => connections.size > 0
    };
})();

// 暴露到全局 (供按钮 onclick 调用)
window.P2P = P2P;
