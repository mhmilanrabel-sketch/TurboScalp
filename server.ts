// server.ts
// ─────────────────────────────────────────────────────────────
// TurboScalp server entry point.
// ALL Binance calls route to https://demo-fapi.binance.com
// ─────────────────────────────────────────────────────────────
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import axios from 'axios';
import {
  registerAutonomousDemoBotRoutes,
  pauseAllAutonomousDemoBots,
  shutdownAutonomousDemoBot,
} from './server/autonomousDemoBot.js';

// ─── Binance Demo Constants ───────────────────────────────
const BINANCE_REST = 'https://demo-fapi.binance.com';
const DEFAULT_RECV_WINDOW = 5000;
const PORT = Number(process.env.PORT ?? 3000);

// ─── Binance Demo Request Signer ──────────────────────────
const createBinanceRequest = () => {
  return async (
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

    if (method === 'GET' || method === 'DELETE') {
      config.params = payload;
    } else {
      config.data = new URLSearchParams(payload).toString();
      config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    return (await axios(config)).data;
  };
};

// ─── Bot Dependencies (inline, no external imports) ───────
async function getSignals(): Promise<any[]> {
  try {
    const resp = await axios.get(
      `http://127.0.0.1:${PORT}/api/quant/scan`,
      { timeout: 15_000 },
    );
    const d = resp.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.signals)) return d.signals;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.results)) return d.results;
    return [];
  } catch (err: any) {
    console.warn('[bot] getSignals failed:', err?.message);
    return [];
  }
}

async function calculateDemoOrder(input: any) {
  const price = Number(input?.price) || 0;
  const leverage = Math.max(1, Number(input?.leverage) || 1);
  const notional = Math.min(Number(input?.maxNotionalUsd) || 50, 50);
  const qty = price > 0 ? (notional * leverage) / price : 0;
  const side: 'BUY' | 'SELL' = input?.direction === 'BUY' ? 'BUY' : 'SELL';
  return {
    symbol: String(input?.symbol ?? ''),
    side,
    leverage,
    quantity: qty.toFixed(6),
    price,
    notionalUsd: notional,
  };
}

// ─── App Setup ────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
app.use(express.json());

// ─── 1. Dashboard Compatibility Aliases (fixes 404s) ──────
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
  if (target) {
    req.url = target + (qs ? '?' + qs : '');
    console.log(`[alias] ${path} → ${req.url}`);
  }
  next();
});

// ─── 2. Best-Effort Mount of Existing quantRoutes ─────────
// Tries to keep /api/quant/scan (and any other quant endpoints)
// alive by mounting whatever server/quantRoutes.ts exports.
try {
  const mod: any = await import('./server/quantRoutes.js');
  if (typeof mod.registerQuantRoutes === 'function') {
    mod.registerQuantRoutes(app);
    console.log('[quant] routes mounted via registerQuantRoutes()');
  } else if (typeof mod.default === 'function') {
    mod.default(app);
    console.log('[quant] routes mounted via default export');
  } else if (mod.router) {
    app.use('/api/quant', mod.router);
    console.log('[quant] router mounted at /api/quant');
  } else {
    console.warn('[quant] no mountable export found');
  }
} catch (err: any) {
  console.warn('[quant] not mounted:', err?.message);
}

// ─── 3. Autonomous Demo Bot Routes ────────────────────────
registerAutonomousDemoBotRoutes(app, {
  getCredentials: (req) => ({
    apiKey:
      req.header('X-DEMO-API-KEY') ??
      process.env.BINANCE_DEMO_API_KEY ??
      '',
    apiSecret:
      req.header('X-DEMO-API-SECRET') ??
      process.env.BINANCE_DEMO_API_SECRET ??
      '',
  }),
  binanceRequest: createBinanceRequest(),
  calculateDemoOrder,
  getSignals,
  maxOrderUsd: Number(process.env.TURBOSCALP_MAX_ORDER_USD ?? 100),
  maxLeverage: Number(process.env.TURBOSCALP_MAX_LEVERAGE ?? 5),
});

// ─── 4. Health ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// ─── 5. Graceful Shutdown ─────────────────────────────────
process.on('SIGTERM', () => {
  try { pauseAllAutonomousDemoBots(); } catch {}
  try { shutdownAutonomousDemoBot(); } catch {}
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  try { pauseAllAutonomousDemoBots(); } catch {}
  try { shutdownAutonomousDemoBot(); } catch {}
  httpServer.close(() => process.exit(0));
});

// ─── 6. Start ─────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Server started on port ${PORT}.`);
});