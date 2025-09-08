const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

const withCORS = (resp) => {
  const headers = new Headers(resp.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(resp.body, { ...resp, headers });
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname !== '/ws') return withCORS(new Response('not found', { status: 404 }));
    if (req.method !== 'GET' || req.headers.get('Upgrade') !== 'websocket') return withCORS(new Response('method not allowed', { status: 405 }));
    return env.CHATSUNE_DURABLE_OBJECT.get(env.CHATSUNE_DURABLE_OBJECT.idFromName("global")).fetch(req);
  }
};

export class ChatsuneDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    this.rateLimiter = new Map();
    this.state.blockConcurrencyWhile(async () => this.messages = await this.state.storage.get('messages') || []);
  }

  broadcast(message) { this.sockets.forEach(s => s.readyState === WebSocket.OPEN && s.send(JSON.stringify(message))); }

  broadcastConnectionCount() { this.broadcast({ type: 'CONNECTION_COUNT', payload: { count: this.sockets.size } }); }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sockets.add(server);
    server.ip = req.headers.get('cf-connecting-ip');

    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'USER_JOINED': {
            server.username = data.payload.name || `anon-${crypto.randomUUID().slice(0, 8)}`;
            server.send(JSON.stringify({ type: 'HISTORY', payload: this.messages }));
            this.broadcast({ type: 'NEW_MESSAGE', payload: { author: { name: 'system' }, text: `${server.username} has joined.`, timestamp: new Date().toISOString() } });
            this.broadcastConnectionCount();
            break;
          }
          case 'NEW_MESSAGE': {
            if (!server.username) return;
            const now = Date.now(), timestamps = (this.rateLimiter.get(server.ip) || []).filter(t => now - t < 10000);
            if (timestamps.length >= 5) return server.send(JSON.stringify({ type: 'ERROR', payload: 'Rate limit exceeded.' }));
            this.rateLimiter.set(server.ip, [...timestamps, now]);

            const modRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${this.env.GOOGLE_KEY}`, { method: 'POST', body: JSON.stringify({ contents: [{ parts: [{ text: `if this message is appropiate respond only with yes, if its not respond with anything but yes. message: ${data.payload.text}` }] }] }) });
            const modData = await modRes.json();
            if (modData.candidates?.[0]?.content?.parts?.[0]?.text.trim().toLowerCase() !== 'yes') return server.send(JSON.stringify({ type: 'ERROR', payload: 'Message rejected by moderator.' }));
            
            const messagePayload = { author: { name: server.username }, text: data.payload.text, timestamp: new Date().toISOString() };
            this.messages.push(messagePayload);
            this.messages = this.messages.slice(-4);
            this.broadcast({ type: 'NEW_MESSAGE', payload: messagePayload });
            await this.state.storage.put('messages', this.messages);
            break;
          }
        }
      } catch (e) { /* Ignore invalid JSON */ }
    });

    server.addEventListener('close', () => {
      this.sockets.delete(server);
      if (server.username) this.broadcast({ type: 'NEW_MESSAGE', payload: { author: { name: 'system' }, text: `${server.username} has left.`, timestamp: new Date().toISOString() } });
      this.broadcastConnectionCount();
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
