const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Enable CORS for school networks
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, './')));

// Health check endpoint for hosting platforms
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeSessions: activeSessions.size,
        uptime: process.uptime()
    });
});

// Keep track of active game sessions
const activeSessions = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch(data.type) {
            case 'host':
                // Create new game session
                const sessionId = Math.random().toString(36).substring(7);
                activeSessions.set(sessionId, {
                    host: ws,
                    name: data.name,
                    players: 1,
                    clients: new Set() // clients that joined via WebSocket relay
                });
                ws.sessionId = sessionId;
                ws.send(JSON.stringify({
                    type: 'hosted',
                    sessionId: sessionId
                }));
                
                // Broadcast updated session list to all clients
                broadcastSessions();
                break;
                
            case 'join':
                // Join existing session
                const session = activeSessions.get(data.sessionId);
                if (session) {
                    // Forward join request to host
                    session.host.send(JSON.stringify({
                        type: 'joinRequest',
                        peerId: data.peerId,
                        name: data.name
                    }));
                }
                break;

            // Relay-based join (clients that want to use central WebSocket relay instead of P2P)
            case 'join_relay': {
                const s = activeSessions.get(data.sessionId);
                if (s) {
                    // register this websocket as a client in the session
                    s.clients.add(ws);
                    ws.sessionId = data.sessionId;
                    ws.playerId = data.playerId || Math.random().toString(36).slice(2,9);
                    s.players = 1 + s.clients.size;
                    // notify everyone of updated sessions
                    broadcastSessions();
                    // notify host of new client (optional)
                    try {
                        s.host.send(JSON.stringify({ type: 'relay_joined', playerId: ws.playerId }));
                    } catch(e){}
                }
                break;
            }

            case 'leave_relay': {
                const s = activeSessions.get(data.sessionId);
                if (s && s.clients.has(ws)) {
                    s.clients.delete(ws);
                    s.players = 1 + s.clients.size;
                    ws.sessionId = null;
                    broadcastSessions();
                }
                break;
            }

            // Relay position or world updates via server
            case 'relay_position': {
                const s = activeSessions.get(data.sessionId);
                if (s) {
                    // broadcast to host and other clients
                    const payload = JSON.stringify({ type: 'relay_position', playerId: data.playerId, position: data.position });
                    // to host
                    if (s.host && s.host.readyState === WebSocket.OPEN && s.host !== ws) {
                        s.host.send(payload);
                    }
                    // to clients
                    s.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(payload);
                        }
                    });
                }
                break;
            }

            case 'relay_block': {
                const s = activeSessions.get(data.sessionId);
                if (s) {
                    const payload = JSON.stringify({ type: 'relay_block', playerId: data.playerId, x: data.x, y: data.y, z: data.z, action: data.action });
                    if (s.host && s.host.readyState === WebSocket.OPEN && s.host !== ws) s.host.send(payload);
                    s.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(payload);
                    });
                }
                break;
            }
                
            case 'offer':
            case 'answer':
            case 'ice':
                // Forward WebRTC signaling messages
                const targetSession = activeSessions.get(data.sessionId);
                if (targetSession) {
                    if (data.target === 'host') {
                        targetSession.host.send(message);
                    }
                }
                break;
        }
    });

    ws.on('close', () => {
        if (ws.sessionId) {
            activeSessions.delete(ws.sessionId);
            broadcastSessions();
        }
    });
    
    // Send initial session list
    sendSessionList(ws);
});

function broadcastSessions() {
    const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
        id,
        name: session.name,
        players: session.players
    }));
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'sessionList',
                sessions
            }));
        }
    });
}

function sendSessionList(ws) {
    const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
        id,
        name: session.name,
        players: session.players
    }));
    
    ws.send(JSON.stringify({
        type: 'sessionList',
        sessions
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Craft&Mine Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`🌐 Local: http://localhost:${PORT}`);
    if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.GLITCH) {
        console.log(`☁️  Cloud hosting detected - server is publicly accessible`);
    }
});