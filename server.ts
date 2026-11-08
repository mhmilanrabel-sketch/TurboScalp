// server.ts — Complete, crash-proof version with AWS Proxy and /setup page
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import axios from 'axios';
import path from 'path';
import { WebSocketServer } from 'ws';
import * as AutonomousDemoBotModule from './server/autonomousDemoBot.js';

// ─── Catch Global Errors (Prevents silent crashes) ────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Prevented crash:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] Prevented crash:', err);
});

// ─── Constants ────────────────────────────────────────────
const BINANCE_REST = 'https://demo-fapi.binance.com';
const DEFAULT_RECV_WINDOW = 5000;
const PORT = Number(process.env.PORT ?? 3000);

// ─── NATIVE AXIOS PROXY (No extra packages needed) ────────
const PROXY_URL = process.env.AWS_PROXY_URL; 
let proxyConfig: any = undefined;

if (PROXY_URL) {
  try {
    const url = new URL(PROXY_URL);
    proxyConfig = {
      host: url.hostname,
      port: Number(url.port) || 3128,
      protocol: url.protocol.replace(':', ''),
    };
    console.log(`[proxy] Native Axios proxy active: ${url.hostname}:${url.port}`);
  } catch (e) { 
    console.warn(`[proxy] Invalid AWS_PROXY_URL format`); 
  }
} else { 
  console.warn('[proxy] AWS_PROXY_URL not set. Requests will bypass proxy.'); 
}

// ─── Memory Store for Manual Keys ─────────────────────────
let runtimeCredentials = {
  apiKey: process.env.BINANCE_DEMO_API_KEY || '',
  apiSecret: process.env.BINANCE_DEMO_API_SECRET || ''
};

// ─── Demo Request Signer ──────────────────────────────────
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

  if (proxyConfig) config.proxy = proxyConfig; 

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

// ─── Inline Bot Helpers ───────────────────────────────────
async function getSignals(): Promise<any[]> {
  try {
    const resp = await axios.get(`http://127.0.0.1:${PORT}/api/quant/scan`, { timeout: 15_000 });
    const d = resp.data;
    return Array.isArray(d) ? d : (Array.isArray(d?.signals) ? d.signals : []);
  } catch (err: any) { return []; }
}

async function calculateDemoOrder(input: any) {
  const price = Number(input?.price) || 0;
  const leverage = Math.max(1, Number(input?.leverage) || 1);
  const notional = Math.min(Number(input?.maxNotionalUsd) || 50, 50);
  const qty = price > 0 ? (notional * leverage) / price : 0;
  return { 
    symbol: String(input?.symbol ?? ''), 
    side: input?.direction === 'BUY' ? 'BUY' : 'SELL', 
    leverage, 
    quantity: qty.toFixed(6), 
    price, 
    notionalUsd: notional 
  };
}

// ─── App Setup ────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
app.use(express.json());

// ─── Dashboard Aliases (Fix 404s) ─────────────────────────
const BOT_ALIASES: Record<string, string> = {
  '/api/quant/bot/state':  '/api/autonomous-demo-bot/status',
  '/api/quant/bot/start':  '/api/autonomous-demo-bot/start',
  '/api/quant/bot/stop':   '/api/autonomous-demo-bot/stop',
};
app.use((req, _res, next) => {
  const [path, qs] = req.url.split('?');
  if (BOT_ALIASES[path]) req.url = BOT_ALIASES[path] + (qs ? '?' + qs : '');
  next();
});

// ─── Credential Extractor ─────────────────────────────────
const getCreds = (req: express.Request) => {
  const hKey = req.header('X-DEMO-API-KEY');
  const hSec = req.header('X-DEMO-API-SECRET');
  if (hKey && hSec) return { apiKey: hKey, apiSecret: hSec };
  return runtimeCredentials;
};

// ─── Health ───────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// ─── 🔽 MANUAL SETUP PAGE 🔽 ──────────────────────────────
app.get('/setup', (_req, res) => {
  res.send(`
    <html><head><title>Manual API Setup</title>
    <style>
      body{background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
      .box{background:#1e293b;padding:40px;border-radius:10px;width:400px;text-align:center}
      input{width:90%;padding:10px;margin:10px 0;border-radius:5px;border:1px solid #334155;background:#0f172a;color:white}
      button{width:100%;padding:10px;background:#3b82f6;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;margin-top:10px}
      .success{color:#10b981;display:none;margin-top:15px}
      .error{color:#ef4444;display:none;margin-top:15px}
    </style></head>
    <body><div class="box"><h2>Manual Demo Setup</h2>
    <p style="font-size:12px;color:#94a3b8;">Bypasses UI bugs. Saves to server memory.</p>
    <form id="f"><input type="text" id="k" placeholder="API Key" required><input type="password" id="s" placeholder="API Secret" required><button type="submit" id="b">Verify & Save</button></form>
    <div id="sm" class="success">Keys saved! Redirecting...</div><div id="em" class="error"></div></div>
    <script>
      document.getElementById('f').addEventListener('submit',async(e)=>{
        e.preventDefault();const b=document.getElementById('b');b.innerText='Verifying...';
        const res=await fetch('/api/binance/manual-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:document.getElementById('k').value,apiSecret:document.getElementById('s').value})});
        const d=await res.json();
        if(d.success){document.getElementById('sm').style.display='block';document.getElementById('em').style.display='none';setTimeout(()=>window.location.href='/',1500)}
        else{b.innerText='Verify & Save';document.getElementById('em').innerText=d.error;document.getElementById('em').style.display='block'}
      });
    </script></body></html>
  `);
});

app.post('/api/binance/manual-save', async (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ success: false, error: 'Missing keys' });
  try {
    await createBinanceRequest()('GET', '/fapi/v2/account', {}, true, { apiKey, apiSecret });
    runtimeCredentials = { apiKey, apiSecret };
    res.json({ success: true });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error?.response?.data?.msg || 'Invalid API Keys or Proxy failed' });
  }
});
// ─── 🔼 END MANUAL SETUP PAGE 🔼 ──────────────────────────

app.get('/api/binance/config', (req, res) => {
  const c = getCreds(req);
  res.json({ success: true, configured: Boolean(c.apiKey && c.apiSecret), environment: 'USD_M_FUTURES_DEMO', proxyActive: Boolean(PROXY_URL) });
});

app.post('/api/binance/connect', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ success: false, error: 'Missing API Key or Secret' });
    await createBinanceRequest()('GET', '/fapi/v2/account', {}, true, { apiKey, apiSecret });
    runtimeCredentials = { apiKey, apiSecret };
    return res.json({ success: true, message: 'Connected via AWS Proxy' });
  } catch (error: any) {
    return res.status(401).json({ success: false, error: error?.response?.data?.msg || 'Connection failed' });
  }
});

app.get('/api/binance/account', async (req, res) => {
  const c = getCreds(req);
  if (!c.apiKey) return res.json({ success: false, error: 'Missing credentials' });
  try {
    const account = await createBinanceRequest()('GET', '/fapi/v3/account', {}, true, c);
    res.json({ success: true, account });
  } catch (error: any) { res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message }); }
});

app.get('/api/binance/positions', async (req, res) => {
  const c = getCreds(req);
  if (!c.apiKey) return res.json({ success: false, error: 'Missing credentials', positions: [] });
  try {
    const pos = await createBinanceRequest()('GET', '/fapi/v2/positionRisk', {}, true, c);
    res.json({ success: true, positions: Array.isArray(pos) ? pos.filter((p: any) => Number(p.positionAmt) !== 0) : [] });
  } catch (error: any) { res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message, positions: [] }); }
});

app.get('/api/binance/open-orders', async (req, res) => {
  const c = getCreds(req);
  if (!c.apiKey) return res.json({ success: false, error: 'Missing credentials', orders: [] });
  try {
    const orders = await createBinanceRequest()('GET', '/fapi/v1/openOrders', {}, true, c);
    res.json({ success: true, orders: Array.isArray(orders) ? orders : [] });
  } catch (error: any) { res.status(500).json({ success: false, error: error?.response?.data?.msg || error.message, orders: [] }); }
});

// Catch-all to prevent 404s from React UI
app.all('/api/binance/*', (req, res) => res.json({ success: false, error: 'Not implemented', path: req.path }));

// ─── Boot Sequence ────────────────────────────────────────
async function boot() {
  try {
    const mod: any = await import('./server/quantRoutes.js');
    if (typeof mod.registerQuantRoutes === 'function') mod.registerQuantRoutes(app);
    else if (typeof mod.default === 'function') mod.default(app);
    else if (mod.router) app.use('/api/quant', mod.router);
  } catch (err: any) { console.warn('[quant] not mounted:', err?.message); }

  const reg = (AutonomousDemoBotModule as any).registerAutonomousDemoBotRoutes;
  if (typeof reg === 'function') {
    reg(app, { 
      getCredentials: getCreds, 
      binanceRequest: createBinanceRequest(), 
      calculateDemoOrder, 
      getSignals, 
      maxOrderUsd: 100, 
      maxLeverage: 5 
    });
  }
}
void boot().catch((err) => console.error('[boot] FATAL:', err));

// ─── WebSocket Server for /ws/market ──────────────────────
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  const i = setInterval(() => { 
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ticker', symbol: 'BTCUSDT', price: 67000, time: Date.now() })); 
  }, 5000);
  ws.on('close', () => clearInterval(i));
});
httpServer.on('upgrade', (req, sock, head) => {
  if (req.url === '/ws/market') wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
  else sock.destroy();
});

// ─── Static Frontend Serving ──────────────────────────────
const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/setup') return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => { if (err) res.status(404).send('Build missing.'); });
});

// ─── Start & Shutdown ─────────────────────────────────────
httpServer.listen(PORT, () => console.log(`Server started on port ${PORT}.`));
const runShutdown = () => { 
  [(AutonomousDemoBotModule as any).pauseAllAutonomousDemoBots, (AutonomousDemoBotModule as any).shutdownAutonomousDemoBot].forEach(fn => { 
    if (typeof fn === 'function') { try { fn(); } catch {} } 
  }); 
};
process.on('SIGTERM', () => { runShutdown(); httpServer.close(() => process.exit(0)); });
process.on('SIGINT',  () => { runShutdown(); httpServer.close(() => process.exit(0)); });