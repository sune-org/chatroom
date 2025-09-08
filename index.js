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
  }

  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('message', () => {});
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
}
