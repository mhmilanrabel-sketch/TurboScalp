// server.ts
// TurboScalp server entry point (Binance USD-M Futures DEMO ONLY)
// Preserves Vite dev middleware, HttpOnly session cookies, WebSocket market stream,
// manual Demo trading, existing quant/autonomous-bot routes, and Multi-Agent engine.

import express, { type Request, type Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import axios from 'axios';
import { WebSocket, WebSocketServer } from 'ws';
import dotenv from 'dotenv';

import { registerQuantRoutes, scanMarketSignals } from './server/quantRoutes.js';
import {
  registerAutonomousDemoBotRoutes,
  pauseAllAutonomousDemoBots,
  shutdownAutonomousDemoBot,
  getAutonomousDemoBotState,
} from './server/autonomousDemoBot.js';
import {
  registerAgentEngineRoutes,
  reconcileOnSessionConnected,
  pauseAutoAgentOnDisconnect,
  shutdownAutoAgent,
  updateSessionPermissionDiagnostics,
} from './server/agent/agentEngine.js';
import {
  classifyFuturesPermission,
  runNonExecutingPermissionDiagnostic,
  type FuturesPermissionDiagnostics,
} from './server/permissionDiagnostics.js';

dotenv.config();

// ======================================================
// SERVER INITIALIZATION
// ======================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  express.json({
    limit: '32kb',
  })
);

// AI Studio dev server must strictly listen on port 3000
const PORT = Number(process.env.PORT || 3000);

// ======================================================
// BINANCE DEMO ENDPOINTS (DEMO ONLY — NO LIVE ENDPOINT)
// ======================================================

const BINANCE_REST = 'https://demo-fapi.binance.com';
const BINANCE_STREAM = 'wss://demo-fstream.binance.com/market';
const SESSION_COOKIE = 'ts_demo_session';
const SESSION_TTL = 2 * 60 * 60 * 1000;
const RECV_WINDOW = 5000;

const MAX_ORDER_USD = Math.max(
  10,
  Math.min(Number(process.env.BINANCE_MAX_ORDER_USD || 1000), 10000)
);

const MAX_LEVERAGE = Math.max(
  1,
  Math.min(Number(process.env.BINANCE_MAX_LEVERAGE || 10), 20)
);

// Optional native axios proxy support if AWS_PROXY_URL is configured
let proxyConfig: any = undefined;
if (process.env.AWS_PROXY_URL) {
  try {
    const proxyUrl = new URL(process.env.AWS_PROXY_URL);
    proxyConfig = {
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 3128,
      protocol: proxyUrl.protocol.replace(':', ''),
    };
    console.log(
      `[proxy] Native Axios proxy active: ${proxyUrl.hostname}:${proxyConfig.port}`
    );
  } catch {
    console.warn('[proxy] Invalid AWS_PROXY_URL format; bypassing proxy.');
  }
}

// ======================================================
// SESSION STORAGE (HttpOnly cookie-backed)
// ======================================================

interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

interface UserSession {
  apiKey: string;
  apiSecret: string;
  expiresAt: number;
  diagnostics?: FuturesPermissionDiagnostics;
}

const sessions = new Map<string, UserSession>();

class BinanceRequestError extends Error {
  status: number;
  code?: number;

  constructor(message: string, status = 502, code?: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const cookies = (req.headers.cookie || '').split(';');
  for (const item of cookies) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === name) return value;
  }
  return undefined;
}

function validateMutationOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const rawForwarded = req.headers['x-forwarded-host'];
      const forwardedHost = Array.isArray(rawForwarded)
        ? rawForwarded[0]
        : rawForwarded;
      const expectedHost = (forwardedHost || req.headers.host || '').split(',')[0].trim();
      return Boolean(expectedHost && originHost === expectedHost);
    } catch {
      return false;
    }
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  return true;
}

function getSessionRecord(
  req: Request,
  required = true
): UserSession | null {
  const sessionId = getCookie(req, SESSION_COOKIE);

  if (!sessionId) {
    if (required) {
      throw new BinanceRequestError('Binance account is not connected.', 401);
    }
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    if (required) {
      throw new BinanceRequestError(
        'Binance session expired. Please reconnect.',
        401
      );
    }
    return null;
  }

  return session;
}

function getSessionCredentials(
  req: Request,
  required = true
): BinanceCredentials | null {
  const session = getSessionRecord(req, required);
  if (!session) return null;
  return {
    apiKey: session.apiKey,
    apiSecret: session.apiSecret,
  };
}

function createSession(
  req: Request,
  res: Response,
  credentials: BinanceCredentials,
  diagnostics?: FuturesPermissionDiagnostics
): void {
  for (const [id, session] of sessions.entries()) {
    if (Date.now() > session.expiresAt) sessions.delete(id);
  }
  if (sessions.size >= 200) {
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }

  const sessionId = randomBytes(32).toString('hex');
  sessions.set(sessionId, {
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    expiresAt: Date.now() + SESSION_TTL,
    diagnostics,
  });

  const secure =
    req.secure || req.headers['x-forwarded-proto'] === 'https';

  const cookieFlags = secure
    ? 'HttpOnly; Path=/; SameSite=None; Secure; Partitioned'
    : 'HttpOnly; Path=/; SameSite=Lax';

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sessionId}; ${cookieFlags}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`
  );
}

function destroySession(req: Request, res: Response): void {
  const id = getCookie(req, SESSION_COOKIE);
  if (id) {
    const s = sessions.get(id);
    if (s) {
      s.apiKey = '';
      s.apiSecret = '';
    }
    sessions.delete(id);
  }

  const secure =
    req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieFlags = secure
    ? 'HttpOnly; Path=/; SameSite=None; Secure; Partitioned'
    : 'HttpOnly; Path=/; SameSite=Lax';

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${cookieFlags}; Max-Age=0`
  );
}

function sendApiError(res: Response, error: unknown): void {
  const err =
    error instanceof BinanceRequestError
      ? error
      : new BinanceRequestError(
          error instanceof Error ? error.message : 'Unexpected server error.'
        );

  res.status(err.status).json({
    success: false,
    message: err.message,
    ...(err.code !== undefined ? { code: err.code } : {}),
  });
}

function toQuery(
  params: Record<string, string | number | boolean | undefined>
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  return query;
}

// ======================================================
// BINANCE REQUEST SIGNING (STRICTLY DEMO-FAPI)
// ======================================================

async function binanceRequest<T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params: Record<string, string | number | boolean | undefined> = {},
  signed = false,
  credentials?: BinanceCredentials
): Promise<T> {
  const query = toQuery(params);
  const headers: Record<string, string> = {};

  if (signed) {
    if (!credentials?.apiKey || !credentials?.apiSecret) {
      throw new BinanceRequestError('Binance credentials are missing.', 401);
    }

    query.set('recvWindow', String(RECV_WINDOW));
    query.set('timestamp', String(Date.now()));

    const signature = createHmac('sha256', credentials.apiSecret)
      .update(query.toString())
      .digest('hex');

    query.set('signature', signature);
    headers['X-MBX-APIKEY'] = credentials.apiKey;
  }

  const queryString = query.toString();
  const url = `${BINANCE_REST}${endpoint}${queryString ? `?${queryString}` : ''}`;

  try {
    const response = await axios.request<T>({
      method,
      url,
      headers,
      timeout: 12000,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      validateStatus: () => true,
    });

    if (response.status === 429 || response.status === 418) {
      throw new BinanceRequestError(
        'Binance Demo API rate limit reached. Slowing down requests.',
        429
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const body: any = response.data;
      throw new BinanceRequestError(
        body?.msg || `Binance HTTP ${response.status}`,
        response.status,
        typeof body?.code === 'number' ? body.code : undefined
      );
    }

    return response.data;
  } catch (error: any) {
    if (error instanceof BinanceRequestError) throw error;
    throw new BinanceRequestError(
      error?.response?.data?.msg ||
        error?.message ||
        'Unable to connect to Binance Demo API.',
      error?.response?.status || 502,
      error?.response?.data?.code
    );
  }
}

// ======================================================
// SYMBOL VALIDATION & ORDER CALCULATION
// ======================================================

function cleanSymbol(value: unknown): string {
  const symbol = String(value || '')
    .replace('/', '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw new BinanceRequestError('Invalid market symbol.', 400);
  }
  return symbol;
}

function floorQuantityToStep(quantity: number, stepSize: string): string {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) {
    throw new BinanceRequestError('Invalid quantity step.', 502);
  }
  const decimals = (stepSize.split('.')[1] || '').replace(/0+$/, '').length;
  const units = Math.floor(quantity / step + 1e-10);
  return (units * step).toFixed(decimals);
}

async function calculateDemoOrder(input: any) {
  const symbol = cleanSymbol(input?.symbol);
  const rawSide = String(input?.side || input?.direction || '').toUpperCase();
  const side: 'BUY' | 'SELL' =
    rawSide === 'BUY' || rawSide === 'SELL'
      ? rawSide
      : (() => {
          throw new BinanceRequestError('Side must be BUY or SELL.', 400);
        })();

  const notionalUsd = Number(input?.quantityUsd ?? input?.maxNotionalUsd ?? 50);
  if (
    !Number.isFinite(notionalUsd) ||
    notionalUsd <= 0 ||
    notionalUsd > MAX_ORDER_USD
  ) {
    throw new BinanceRequestError(
      `Order must be between $0 and $${MAX_ORDER_USD}.`,
      400
    );
  }

  const leverage = Number(input?.leverage || 1);
  if (
    !Number.isInteger(leverage) ||
    leverage < 1 ||
    leverage > MAX_LEVERAGE
  ) {
    throw new BinanceRequestError(
      `Leverage must be between 1 and ${MAX_LEVERAGE}.`,
      400
    );
  }

  const [info, ticker] = await Promise.all([
    binanceRequest<any>('GET', '/fapi/v1/exchangeInfo', { symbol }),
    binanceRequest<any>('GET', '/fapi/v1/ticker/price', { symbol }),
  ]);

  const market = info?.symbols?.find((item: any) => item.symbol === symbol);
  if (
    !market ||
    market.status !== 'TRADING' ||
    market.quoteAsset !== 'USDT'
  ) {
    throw new BinanceRequestError(
      'Market is not an active USDT futures pair.',
      400
    );
  }

  const price = Number(ticker?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new BinanceRequestError('Invalid market price.', 502);
  }

  const filters = market.filters || [];
  const marketLot = filters.find(
    (f: any) => f.filterType === 'MARKET_LOT_SIZE'
  );
  const lot = filters.find((f: any) => f.filterType === 'LOT_SIZE');
  const filter =
    marketLot && Number(marketLot.stepSize) > 0 ? marketLot : lot;

  if (!filter) {
    throw new BinanceRequestError('Quantity rules are missing.', 502);
  }

  const quantity = floorQuantityToStep(
    notionalUsd / price,
    String(filter.stepSize)
  );
  const numericQty = Number(quantity);

  if (
    !Number.isFinite(numericQty) ||
    numericQty < Number(filter.minQty || 0) ||
    numericQty > Number(filter.maxQty || Number.MAX_SAFE_INTEGER)
  ) {
    throw new BinanceRequestError(
      'Order quantity is outside Binance limits.',
      400
    );
  }

  return {
    symbol,
    side,
    leverage,
    quantity,
    price,
    notionalUsd,
  };
}

// ======================================================
// DASHBOARD COMPATIBILITY ALIASES FOR LEGACY /api/quant/bot/*
// ======================================================

const LEGACY_BOT_ALIASES: Record<string, string> = {
  '/api/quant/bot/state': '/api/autonomous-demo-bot/status',
  '/api/quant/bot/status': '/api/autonomous-demo-bot/status',
  '/api/quant/bot/start': '/api/autonomous-demo-bot/start',
  '/api/quant/bot/stop': '/api/autonomous-demo-bot/stop',
  '/api/quant/bot/pause': '/api/autonomous-demo-bot/pause',
  '/api/quant/bot/resume': '/api/autonomous-demo-bot/start',
};

app.use((req, _res, next) => {
  const [reqPath, qs] = req.url.split('?');
  const target = LEGACY_BOT_ALIASES[reqPath];
  if (target) {
    req.url = target + (qs ? `?${qs}` : '');
  }
  next();
});

// ======================================================
// REGISTER EXISTING QUANT & AUTONOMOUS BOT & NEW MULTI-AGENT ROUTES
// ======================================================

registerQuantRoutes(app);

registerAutonomousDemoBotRoutes(app, {
  getCredentials: (req) => {
    const credentials = getSessionCredentials(req, true);
    if (!credentials) {
      throw new BinanceRequestError('Binance account is not connected.', 401);
    }
    return credentials;
  },
  binanceRequest,
  calculateDemoOrder,
  getSignals: async () => {
    const res = await scanMarketSignals({ limit: 40, minVolume: 250000 });
    return res.signals.map((s) => ({
      ...s,
      direction: s.direction === 'BUY' || s.direction === 'SELL' ? s.direction : 'NEUTRAL',
    }));
  },
  maxOrderUsd: MAX_ORDER_USD,
  maxLeverage: MAX_LEVERAGE,
});

// CSV exports for legacy QuantAIEngine dashboard
app.get('/api/quant/bot/history.csv', (_req, res) => {
  const snapshot = getAutonomousDemoBotState();
  const header = 'id,symbol,side,status,notionalUsd,quantity,leverage,entryPrice,stopPrice,targetPrice,realizedPnl,openedAt,closedAt,closeReason';
  const rows = snapshot.trades.map((t) =>
    [
      t.id,
      t.symbol,
      t.side,
      t.status,
      t.notionalUsd,
      t.quantity,
      t.leverage,
      t.entryPrice,
      t.stopPrice,
      t.targetPrice,
      t.realizedPnl ?? '',
      t.openedAt,
      t.closedAt ?? '',
      JSON.stringify(t.closeReason ?? ''),
    ].join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send([header, ...rows].join('\n'));
});

app.get('/api/quant/bot/logs.csv', (_req, res) => {
  const snapshot = getAutonomousDemoBotState();
  const header = 'timestamp,level,message';
  const rows = snapshot.logs.map((l) =>
    [new Date(l.at).toISOString(), l.level, JSON.stringify(l.message)].join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send([header, ...rows].join('\n'));
});

// 6-Agent Autonomous Engine routes (/api/agent/*)
registerAgentEngineRoutes(app, {
  getCredentials: (req, required = false) =>
    getSessionCredentials(req, required),
  binanceRequest,
  validateMutationOrigin,
});

// ======================================================
// BINANCE DEMO AUTH & SESSION ROUTES (PRESERVED)
// ======================================================

app.post('/api/binance/connect', async (req, res) => {
  try {
    if (!validateMutationOrigin(req)) {
      throw new BinanceRequestError('Cross-origin connection rejected.', 403);
    }

    const apiKey = String(req.body?.apiKey || '').trim();
    const apiSecret = String(req.body?.apiSecret || '').trim();

    if (
      !apiKey ||
      !apiSecret ||
      apiKey.length > 256 ||
      apiSecret.length > 512
    ) {
      throw new BinanceRequestError('Enter both valid API credentials.', 400);
    }

    const credentials = { apiKey, apiSecret };
    const account = await binanceRequest<any>(
      'GET',
      '/fapi/v3/account',
      {},
      true,
      credentials
    );

    const diagnostics = await runNonExecutingPermissionDiagnostic(
      binanceRequest,
      credentials,
      account
    );

    createSession(req, res, credentials, diagnostics);
    updateSessionPermissionDiagnostics(diagnostics);
    void reconcileOnSessionConnected(credentials);

    res.json({
      success: true,
      ...diagnostics,
      message: diagnostics.classificationMessage,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post('/api/binance/disconnect', (req, res) => {
  if (!validateMutationOrigin(req)) {
    return res.status(403).json({ success: false, message: 'Forbidden origin.' });
  }
  pauseAllAutonomousDemoBots('Binance API disconnected');
  pauseAutoAgentOnDisconnect('Binance API disconnected');
  updateSessionPermissionDiagnostics(null);
  destroySession(req, res);

  res.json({
    success: true,
    message: 'Binance Demo session disconnected.',
  });
});

app.get('/api/binance/config', (req, res) => {
  const session = getSessionRecord(req, false);
  const connected = Boolean(session);
  const diag = session?.diagnostics ?? null;
  res.json({
    success: true,
    environment: 'USD_M_FUTURES_DEMO',
    credentialsConfigured: connected,
    liveTradingEnabled: false,
    maxOrderUsd: MAX_ORDER_USD,
    maxLeverage: MAX_LEVERAGE,
    canTrade: diag?.accountConfigCanTrade === true,
    accountCanTrade: null,
    accountConfigCanTrade: diag?.accountConfigCanTrade ?? null,
    permissionStatus:
      diag?.permissionStatus ??
      (connected ? 'ACCOUNT_PERMISSION_UNKNOWN' : 'DISCONNECTED'),
    diagnostics: diag,
  });
});

app.post('/api/binance/test', async (req, res) => {
  try {
    if (!validateMutationOrigin(req)) {
      throw new BinanceRequestError('Forbidden origin.', 403);
    }

    const session = getSessionRecord(req, false);
    if (!session) {
      const disconnectedDiag = classifyFuturesPermission({
        apiAuthenticated: false,
        accountConfigCanTrade: null,
        orderTestPassed: false,
        orderTestMessage: 'Binance account is not connected.',
        orderTestCode: 401,
        lastVerifiedAt: Date.now(),
      });
      updateSessionPermissionDiagnostics(null);
      return res.status(401).json({
        success: false,
        ...disconnectedDiag,
        message: 'Binance account is not connected.',
      });
    }

    const diagnostics = await runNonExecutingPermissionDiagnostic(
      binanceRequest,
      { apiKey: session.apiKey, apiSecret: session.apiSecret }
    );
    session.diagnostics = diagnostics;
    updateSessionPermissionDiagnostics(diagnostics);

    if (!diagnostics.tradingConfirmed) {
      pauseAllAutonomousDemoBots(diagnostics.classificationMessage);
    }

    return res.json({
      success: true,
      ...diagnostics,
      message: diagnostics.classificationMessage,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('/api/binance/account', async (req, res) => {
  try {
    const session = getSessionRecord(req, true)!;
    const creds = { apiKey: session.apiKey, apiSecret: session.apiSecret };

    // Use GET /fapi/v3/account strictly for balances, uPnL, assets (never canTrade).
    // Use GET /fapi/v1/accountConfig as the authoritative source for canTrade and config fields.
    const [account, accountConfigResult] = await Promise.all([
      binanceRequest<any>('GET', '/fapi/v3/account', {}, true, creds),
      binanceRequest<any>('GET', '/fapi/v1/accountConfig', {}, true, creds).then(
        (cfg) => ({ ok: true as const, cfg }),
        (err) => ({ ok: false as const, err })
      ),
    ]);

    const accountConfigCanTrade: boolean | null =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.canTrade === 'boolean'
        ? accountConfigResult.cfg.canTrade === true
        : null;
    const canDeposit =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.canDeposit === 'boolean'
        ? accountConfigResult.cfg.canDeposit
        : null;
    const canWithdraw =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.canWithdraw === 'boolean'
        ? accountConfigResult.cfg.canWithdraw
        : null;
    const dualSidePosition =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.dualSidePosition === 'boolean'
        ? accountConfigResult.cfg.dualSidePosition
        : null;
    const multiAssetsMargin =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.multiAssetsMargin === 'boolean'
        ? accountConfigResult.cfg.multiAssetsMargin
        : null;
    const feeTier =
      accountConfigResult.ok &&
      typeof accountConfigResult.cfg?.feeTier === 'number' &&
      Number.isFinite(accountConfigResult.cfg.feeTier)
        ? accountConfigResult.cfg.feeTier
        : null;

    const usdt = Array.isArray(account?.assets)
      ? account.assets.find((item: any) => item.asset === 'USDT')
      : undefined;
    const walletBalance = Number(
      usdt?.walletBalance ?? account?.totalWalletBalance ?? 0
    );
    const availableBalance = Number(
      usdt?.availableBalance ?? account?.availableBalance ?? 0
    );

    const prevDiag = session.diagnostics;
    const updatedDiag = classifyFuturesPermission({
      apiAuthenticated: true,
      accountConfigCanTrade,
      accountEndpointOk: true,
      accountConfigEndpointOk: accountConfigResult.ok,
      accountConfigErrorCode: accountConfigResult.ok
        ? null
        : typeof accountConfigResult.err?.code === 'number'
          ? accountConfigResult.err.code
          : typeof accountConfigResult.err?.status === 'number'
            ? accountConfigResult.err.status
            : null,
      accountConfigErrorMessage: accountConfigResult.ok
        ? null
        : accountConfigResult.err?.message ||
          'Signed GET /fapi/v1/accountConfig request failed.',
      orderTestPassed: prevDiag?.orderTestPassed ?? false,
      orderTestMessage:
        prevDiag?.orderTestMessage ??
        'Run CHECK FUTURES TRADING PERMISSION to validate POST /fapi/v1/order/test.',
      orderTestCode: prevDiag?.orderTestCode ?? null,
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      walletBalance,
      availableBalance,
      lastVerifiedAt: Date.now(),
    });

    session.diagnostics = updatedDiag;
    updateSessionPermissionDiagnostics(updatedDiag);

    const canTradeStatus =
      accountConfigCanTrade === true
        ? 'ENABLED'
        : accountConfigCanTrade === false
          ? 'DISABLED'
          : 'UNKNOWN';

    res.json({
      success: true,
      canTrade: accountConfigCanTrade === true,
      canTradeStatus,
      accountCanTrade: null,
      accountConfigCanTrade,
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      totalWalletBalance: account.totalWalletBalance || '0',
      availableBalance: account.availableBalance || '0',
      totalUnrealizedProfit: account.totalUnrealizedProfit || '0',
      assets: account.assets || [],
      diagnostics: updatedDiag,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('/api/binance/positions', async (req, res) => {
  try {
    const credentials = getSessionCredentials(req)!;
    const positions = await binanceRequest<any[]>(
      'GET',
      '/fapi/v3/positionRisk',
      {},
      true,
      credentials
    );

    res.json({
      success: true,
      positions: (positions || []).filter(
        (position) => Number(position.positionAmt || 0) !== 0
      ),
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('/api/binance/open-orders', async (req, res) => {
  try {
    const credentials = getSessionCredentials(req)!;
    const params: Record<string, string> = {};
    if (req.query.symbol) {
      params.symbol = cleanSymbol(req.query.symbol);
    }

    const orders = await binanceRequest<any[]>(
      'GET',
      '/fapi/v1/openOrders',
      params,
      true,
      credentials
    );

    let algoOrders: any[] = [];
    try {
      const r = await binanceRequest<any[]>(
        'GET',
        '/fapi/v1/openAlgoOrders',
        params,
        true,
        credentials
      );
      algoOrders = Array.isArray(r) ? r : [];
    } catch {
      try {
        const r = await binanceRequest<any[]>(
          'GET',
          '/fapi/v1/algoOpenOrders',
          params,
          true,
          credentials
        );
        algoOrders = Array.isArray(r) ? r : [];
      } catch {
        algoOrders = [];
      }
    }

    const normalizedAlgoOrders = algoOrders.map((order) => ({
      ...order,
      orderId: order.algoId,
      clientOrderId: order.clientAlgoId,
      status: order.algoStatus,
      type: order.orderType || order.type,
      conditional: true,
    }));

    res.json({
      success: true,
      orders: [...(orders || []), ...normalizedAlgoOrders],
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('/api/binance/klines', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.query.symbol);
    const intervals = new Set([
      '1m', '3m', '5m', '15m',
      '30m', '1h', '2h', '4h',
      '6h', '8h', '12h', '1d',
    ]);
    const interval = String(req.query.interval || '15m');
    if (!intervals.has(interval)) {
      throw new BinanceRequestError('Unsupported candle interval.', 400);
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);

    const data = await binanceRequest<any[]>('GET', '/fapi/v1/klines', {
      symbol,
      interval,
      limit,
    });

    res.json({ success: true, data });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post('/api/binance/order-test', async (req, res) => {
  try {
    if (!validateMutationOrigin(req)) {
      throw new BinanceRequestError('Forbidden origin.', 403);
    }
    const credentials = getSessionCredentials(req)!;
    const order = await calculateDemoOrder(req.body);

    const result = await binanceRequest<any>(
      'POST',
      '/fapi/v1/order/test',
      {
        symbol: order.symbol,
        side: order.side,
        type: 'MARKET',
        quantity: order.quantity,
      },
      true,
      credentials
    );

    res.json({
      success: true,
      message:
        'Binance accepted the test order parameters. No order was executed.',
      environment: 'USD_M_FUTURES_DEMO',
      symbol: order.symbol,
      quantity: order.quantity,
      referencePrice: order.price,
      result,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post('/api/binance/order', async (req, res) => {
  try {
    if (!validateMutationOrigin(req)) {
      throw new BinanceRequestError('Forbidden origin.', 403);
    }
    const session = getSessionRecord(req, true)!;
    const credentials = {
      apiKey: session.apiKey,
      apiSecret: session.apiSecret,
    };

    const diag =
      session.diagnostics ??
      (await runNonExecutingPermissionDiagnostic(binanceRequest, credentials));
    session.diagnostics = diag;
    updateSessionPermissionDiagnostics(diag);

    if (!diag.tradingConfirmed) {
      throw new BinanceRequestError(
        diag.classificationMessage || 'ACCOUNT TRADING DISABLED.',
        403,
        diag.accountErrorCode ??
          diag.accountConfigErrorCode ??
          diag.orderTestCode ??
          undefined
      );
    }

    const order = await calculateDemoOrder(req.body);

    // Respect account position mode (One-Way vs Hedge)
    let positionSideParam: Record<string, string> = {};
    try {
      const dual = await binanceRequest<any>(
        'GET',
        '/fapi/v1/positionSide/dual',
        {},
        true,
        credentials
      );
      if (dual?.dualSidePosition) {
        positionSideParam = {
          positionSide: order.side === 'BUY' ? 'LONG' : 'SHORT',
        };
      }
    } catch {
      // One-way default
    }

    await binanceRequest(
      'POST',
      '/fapi/v1/leverage',
      { symbol: order.symbol, leverage: order.leverage },
      true,
      credentials
    );

    const result = await binanceRequest<any>(
      'POST',
      '/fapi/v1/order',
      {
        symbol: order.symbol,
        side: order.side,
        type: 'MARKET',
        quantity: order.quantity,
        newOrderRespType: 'RESULT',
        ...positionSideParam,
      },
      true,
      credentials
    );

    const executedQty = Number(result?.executedQty || 0);
    const avgPrice = Number(result?.avgPrice || 0);
    const quoteTotal = Number(result?.cumQuote || result?.cumQuoteQty || 0);
    const executedPrice =
      avgPrice > 0
        ? avgPrice
        : executedQty > 0 && quoteTotal > 0
          ? quoteTotal / executedQty
          : order.price;

    res.json({
      success: true,
      environment: 'USD_M_FUTURES_DEMO',
      orderId: result?.orderId,
      status: result?.status,
      symbol: order.symbol,
      side: order.side,
      quantity: result?.executedQty || order.quantity,
      executedPrice,
      leverage: order.leverage,
      message: `Binance Demo order ${result?.orderId ?? ''} accepted.`,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'online',
    ok: true,
    timestamp: Date.now(),
    binanceEnvironment: 'USD_M_FUTURES_DEMO',
    marketStreamStatus: upstreamStatus,
    credentialsMode: 'MANUAL_APP_SESSION',
  });
});

// ======================================================
// DEDICATED MARKET WEBSOCKET (/ws/market -> demo-fstream)
// ======================================================

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  let pathname: string;
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws/market') {
    // Allow Vite HMR or other upgrade handlers to handle non-market sockets
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

const activeSymbols = [
  'btcusdt',
  'ethusdt',
  'solusdt',
  'xrpusdt',
  'adausdt',
  'dogeusdt',
  'bnbusdt',
  'nearusdt',
  'suiusdt',
  'linkusdt',
  'avaxusdt',
  'pepeusdt',
];

let upstream: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let shuttingDown = false;
let receivedFirstMessage = false;
let upstreamStatus: 'LIVE' | 'RECONNECTING' | 'OFFLINE' = 'RECONNECTING';

function broadcast(message: string): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Market broadcast failed:', error);
      }
    }
  }
}

function publishStatus(status: 'LIVE' | 'RECONNECTING' | 'OFFLINE'): void {
  upstreamStatus = status;
  const wireStatus =
    status === 'LIVE'
      ? 'connected'
      : status === 'OFFLINE'
        ? 'disconnected'
        : 'reconnecting';

  broadcast(
    JSON.stringify({
      type: 'connection',
      status: wireStatus,
      upstream: status,
      environment: 'USD_M_FUTURES_DEMO',
    })
  );
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  publishStatus('RECONNECTING');
  const delay = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempts, 4));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinance();
  }, delay);
}

function connectBinance(): void {
  if (shuttingDown) return;
  const streams = activeSymbols.map((s) => `${s}@ticker`).join('/');
  const url = `${BINANCE_STREAM}/stream?streams=${streams}`;

  try {
    upstream = new WebSocket(url, { handshakeTimeout: 12000 });

    upstream.on('open', () => {
      reconnectAttempts = 0;
      receivedFirstMessage = false;
      publishStatus('RECONNECTING');
      console.log('Connected to Binance Demo WebSocket. Waiting for ticker data.');
    });

    upstream.on('message', (data) => {
      if (!receivedFirstMessage) {
        receivedFirstMessage = true;
        publishStatus('LIVE');
        console.log('Binance Demo market data is flowing.');
      }
      broadcast(data.toString());
    });

    upstream.on('error', (error) => {
      console.error('Binance WebSocket error:', error.message);
      publishStatus('RECONNECTING');
      upstream?.terminate();
    });

    upstream.on('close', () => {
      console.warn('Binance market stream disconnected.');
      scheduleReconnect();
    });
  } catch (error) {
    console.error('Binance WebSocket initialization failed:', error);
    scheduleReconnect();
  }
}

wss.on('connection', (client) => {
  const status =
    upstreamStatus === 'LIVE'
      ? 'connected'
      : upstreamStatus === 'OFFLINE'
        ? 'disconnected'
        : 'reconnecting';

  client.send(
    JSON.stringify({
      type: 'connection',
      status,
      upstream: upstreamStatus,
      environment: 'USD_M_FUTURES_DEMO',
    })
  );
});

// ======================================================
// VITE DEV MIDDLEWARE / PRODUCTION STATIC FRONTEND
// ======================================================

async function configureApplication() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
      }
      next();
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
}

// ======================================================
// START & SHUTDOWN
// ======================================================

async function startServer() {
  await configureApplication();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`TurboScalp server listening on port ${PORT}`);
    console.log('Binance environment: USD-M Futures Demo');
    console.log('Market WebSocket: /ws/market');

    if (process.env.DISABLE_BINANCE_STREAM !== 'true') {
      connectBinance();
    } else {
      publishStatus('OFFLINE');
    }
  });
}

function shutdown() {
  shutdownAutonomousDemoBot();
  shutdownAutoAgent();
  shuttingDown = true;

  if (reconnectTimer) clearTimeout(reconnectTimer);
  upstream?.close();

  for (const session of sessions.values()) {
    session.apiKey = '';
    session.apiSecret = '';
  }
  sessions.clear();
  wss.close();
  server.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startServer().catch((error) => {
  console.error('Application startup failed:', error);
  process.exitCode = 1;
});