// server.ts — Final integration (Fixes /api/binance/config 404)
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import axios from 'axios';
import path from 'path';
import { WebSocketServer } from 'ws';
import * as AutonomousDemoBotModule from './server/autonomousDemoBot.js';

// ─── Constants ────────────────────────────────────────────
const BINANCE_REST = 'https://demo-fapi.binance.com';
const DEFAULT_RECV_WINDOW = 5000;
const PORT = Number(process.env.PORT ?? 3000);

// ─── Demo request signer ──────────────────────────────────
const createBinanceRequest = () => async (
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params: Record<string, any> = {},
  signed = false,
  credentials?: { apiKey: string; apiSecret: string },
) => {
  const config: any = {
    method,
    url: `${BINANCE_REST}${endpoint}`,
    headers: { 'X-MBX-APIKEY': credentials?.apiKey ?? '' },
  };
  const payload = { ...params };
  if (signed) {
    if (!credentials) throw new Error('Signed request requires credentials');
    payload.timestamp = Date.now();
    payload.recvWindow = payload.recvWindow ?? DEFAULT_RECV_WINDOW;
    payload.signature = crypto
      .createHmac('sha256', credentials.apiSecret)
      .update(new URLSearchParams(payload).toString())
      .digest('hex');
  }
  if (method === 'GET' || method === 'DELETE') config.params = payload;
  else {
    config.data = new URLSearchParams(payload).toString();
    config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return (await axios(config)).data;
};

// ─── Inline bot deps ──────────────────────────────────────
async function getSignals(): Promise<any[]> {
  try {
    const resp = await axios.get(`http://127.0.0.1:${PORT}/api/quant/scan`, { timeout: 15_000 });
    const d = resp.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.signals)) return d.signals;
    if (Array.isArray(d?.data)) return d.data;
    return [];
  } catch (err: any) {
    return [];
  }
}

async function calculateDemoOrder(input: any) {
  const price = Number(input?.price) || 0;
  const leverage = Math.max(1, Number(input?.leverage) || 1);
  const notional = Math.min(Number(input?.maxNotionalUsd) || 50, 50);
  const qty = price > 0 ? (notional * leverage) / price : 0;
  const side: 'BUY' | 'SELL' = input?.direction === 'BUY' ? 'BUY' : 'SELL';
  return { symbol: String(input?.symbol ?? ''), side, leverage, quantity: qty.toFixed(6), price, notionalUsd: notional };
}

// ─── App Setup ────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
app.use(express.json());

// ─── Dashboard Aliases ────────────────────────────────────
const BOT_ALIASES: Record<string, string> = {
  '/api/quant/bot/state':  '/api/autonomous-demo-bot/status',
  '/api/quant/bot/status': '/api/autonomous-demo-bot/status',
  '/api/quant/bot/start':  '/api/autonomous-demo-bot/start',
  '/api/quant/bot/stop':   '/api/autonomous-demo-bot/stop',
  '/api/quant/bot/pause':  '/api/autonomous-demo-bot/pause',
  '/api/quant/bot/resume': '/api/autonomous-demo-bot/start',
  '/api/quant/bot/trades': '/api/autonomous-demo-bot/status',
  '/api/quant/bot/logs':   '/api/autonomous-demo-bot/status',
  '/api/quant/bot/config': '/api/autonomous-demo-bot/status',
};
app.use((req, _res, next) => {
  const [path, qs] = req.url.split('?');
  const target = BOT_ALIASES[path];
  if (target) req.url = target + (qs ? '?' + qs : '');
  next();
});

// ─── Health ───────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// ─── Binance Connection & Data Routes ─────────────────────

// Helper to extract credentials from headers or env
const getCreds = (req: express.Request) => ({
  apiKey: req.header('X-DEMO-API-KEY') ?? process.env.BINANCE_DEMO_API_KEY ?? '',
  apiSecret: req.header('X-DEMO-API-SECRET') ?? process.env.BINANCE_DEMO_API_SECRET ?? '',
});

// 🔽 NEW: Fixes the GET /api/binance/config 404
app.get('/api/binance/config', (req, res) => {
  const creds = getCreds(req);
  res.json({
    success: true,
    configured: Boolean(creds.apiKey && creds.apiSecret),
    environment: 'USD_M_FUTURES_DEMO',
    maxLeverage: Number(process.env.TURBOSCALP_MAX_LEVERAGE ?? 5),
    maxOrderUsd: Number(process.env.TURBOSCALP_MAX_ORDER_USD ?? 100),
  });
});

app.post('/api/binance/connect', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ success: false, error: 'Missing API Key or Secret' });
    
    await createBinanceRequest()('GET', '/fapi/v2/account', {}, true, { apiKey, apiSecret });
    return res.json({ success: true, message: 'Connected to Binance Demo successfully' });
  } catch (error: any) {
    if (error?.response?.status === 401 || error?.response?.data?.code === -2015 || error?.response?.data?.code === -1109) {
      return res.status(401).json({ success: false, error: 'Invalid API Keys. Make sure they are created on the Futures Demo portal.' });
    }
    return res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message });
  }
});

app.get('/api/binance/account', async (req, res) => {
  const creds = getCreds(req);
  if (!creds.apiKey) return res.json({ success: false, error: 'Missing credentials' });
  try {
    const account = await createBinanceRequest()('GET', '/fapi/v3/account', {}, true, creds);
    res.json({ success: true, account });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message });
  }
});

app.get('/api/binance/positions', async (req, res) => {
  const creds = getCreds(req);
  if (!creds.apiKey) return res.json({ success: false, error: 'Missing credentials', positions: [] });
  try {
    const positions = await createBinanceRequest()('GET', '/fapi/v2/positionRisk', {}, true, creds);
    const activePositions = Array.isArray(positions) ? positions.filter((p: any) => Number(p.positionAmt) !== 0) : [];
    res.json({ success: true, positions: activePositions });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message, positions: [] });
  }
});

app.get('/api/binance/open-orders', async (req, res) => {
  const creds = getCreds(req);
  if (!creds.apiKey) return res.json({ success: false, error: 'Missing credentials', orders: [] });
  try {
    const orders = await createBinanceRequest()('GET', '/fapi/v1/openOrders', {}, true, creds);
    res.json({ success: true, orders: Array.isArray(orders) ? orders : [] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message, orders: [] });
  }
});

// ─── Boot sequence ────────────────────────────────────────
async function boot(): Promise<void> {
  try {
    const mod: any = await import('./server/quantRoutes.js');
    if (typeof mod.registerQuantRoutes === 'function') mod.registerQuantRoutes(app);
    else if (typeof mod.default === 'function') mod.default(app);
    else if (mod.router) app.use('/api/quant', mod.router);
  } catch (err: any) { console.warn('[quant] not mounted:', err?.message); }

  const registerBot = (AutonomousDemoBotModule as any).registerAutonomousDemoBotRoutes;
  if (typeof registerBot === 'function') {
    registerBot(app, {
      getCredentials: getCreds,
      binanceRequest: createBinanceRequest(),
      calculateDemoOrder,
      getSignals,
      maxOrderUsd: Number(process.env.TURBOSCALP_MAX_ORDER_USD ?? 100),
      maxLeverage: Number(process.env.TURBOSCALP_MAX_LEVERAGE ?? 5),
    });
  }
}
void boot().catch((err) => console.error('[boot] FATAL:', err));

// ─── WebSocket Server for /ws/market ──────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected to /ws/market');
  ws.send(JSON.stringify({ type: 'connected', message: 'Market stream active' }));
  
  const interval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ticker', symbol: 'BTCUSDT', price: 67000, time: Date.now() }));
    }
  }, 5000);

  ws.on('close', () => clearInterval(interval));
});

httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws/market') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Static Frontend Serving ──────────────────────────────
const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend build not found. Run `npm run build` first.');
  });
});

// ─── Start Server ─────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Server started on port ${PORT}.`);
});

// ─── Graceful Shutdown ────────────────────────────────────
const shutdownHooks = [
  (AutonomousDemoBotModule as any).pauseAllAutonomousDemoBots,
  (AutonomousDemoBotModule as any).shutdownAutonomousDemoBot,
  (AutonomousDemoBotModule as any).stopAllAutonomousDemoBots,
  (AutonomousDemoBotModule as any).shutdownAutonomousDemoBots,
];
const runShutdown = () => {
  for (const fn of shutdownHooks) {
    if (typeof fn === 'function') { try { fn(); } catch {} }
  }
};
process.on('SIGTERM', () => { runShutdown(); httpServer.close(() => process.exit(0)); });
process.on('SIGINT',  () => { runShutdown(); httpServer.close(() => process.exit(0)); });