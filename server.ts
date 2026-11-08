
import express, {
  type Request,
  type Response
} from 'express';

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createHmac,
  randomBytes
} from 'node:crypto';

import axios from 'axios';

import {
  WebSocket,
  WebSocketServer
} from 'ws';

import dotenv from 'dotenv';
import { registerQuantRoutes } from './server/quantRoutes.js';
import {
  registerAutonomousDemoBotRoutes,
  pauseAllAutonomousDemoBots,
  shutdownAutonomousDemoBot
} from './server/autonomousDemoBot.js';

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

app.use(express.json({
  limit: '32kb'
}));

// Public Demo-market quant scanner and paper-bot analysis API.
registerQuantRoutes(app);

// AI Studio dev server must strictly listen on port 3000
const PORT = Number(process.env.PORT || 3000);

// ======================================================
// BINANCE DEMO ENDPOINTS
// ======================================================

const BINANCE_REST =
  'https://demo-fapi.binance.com';

const BINANCE_STREAM =
  'wss://demo-fstream.binance.com/market';

const SESSION_COOKIE = 'ts_demo_session';

const SESSION_TTL = 2 * 60 * 60 * 1000;

const RECV_WINDOW = 5000;

const MAX_ORDER_USD = Math.max(
  10,
  Math.min(
    Number(process.env.BINANCE_MAX_ORDER_USD || 1000),
    10000
  )
);

const MAX_LEVERAGE = Math.max(
  1,
  Math.min(
    Number(process.env.BINANCE_MAX_LEVERAGE || 10),
    20
  )
);

// ======================================================
// SESSION STORAGE
// ======================================================

interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

interface UserSession {
  apiKey: string;
  apiSecret: string;
  expiresAt: number;
}

const sessions = new Map<string, UserSession>();

// ======================================================
// ERROR CLASS
// ======================================================

class BinanceRequestError extends Error {

  status: number;

  code?: number;

  constructor(
    message: string,
    status = 502,
    code?: number
  ) {

    super(message);

    this.status = status;

    this.code = code;

  }

}

// ======================================================
// COOKIE HELPER
// ======================================================

function getCookie(
  req: Request,
  name: string
): string | undefined {

  const cookies = (
    req.headers.cookie || ''
  ).split(';');

  for (const item of cookies) {

    const separator = item.indexOf('=');

    if (separator < 0) continue;

    const key = item.slice(
      0,
      separator
    ).trim();

    const value = item.slice(
      separator + 1
    ).trim();

    if (key === name) {
      return value;
    }

  }

  return undefined;

}

// ======================================================
// SECURE SESSION LOOKUP
// ======================================================

function getSessionCredentials(
  req: Request,
  required = true
): BinanceCredentials | null {

  const sessionId = getCookie(
    req,
    SESSION_COOKIE
  );

  if (!sessionId) {

    if (required) {

      throw new BinanceRequestError(
        'Binance account is not connected.',
        401
      );

    }

    return null;

  }

  const session = sessions.get(sessionId);

  if (
    !session ||
    Date.now() > session.expiresAt
  ) {

    sessions.delete(sessionId);

    if (required) {

      throw new BinanceRequestError(
        'Binance session expired. Please reconnect.',
        401
      );

    }

    return null;

  }

  return {

    apiKey: session.apiKey,

    apiSecret: session.apiSecret

  };

}

// ======================================================
// CREATE SESSION
// ======================================================

function createSession(
  req: Request,
  res: Response,
  credentials: BinanceCredentials
): void {

  // Clean expired sessions.

  for (const [id, session] of sessions.entries()) {

    if (Date.now() > session.expiresAt) {
      sessions.delete(id);
    }

  }

  // Limit session storage.

  if (sessions.size >= 200) {

    const oldest = sessions.keys().next().value;

    if (oldest) {
      sessions.delete(oldest);
    }

  }

  const sessionId = randomBytes(32).toString('hex');

  sessions.set(sessionId, {

    apiKey: credentials.apiKey,

    apiSecret: credentials.apiSecret,

    expiresAt: Date.now() + SESSION_TTL

  });

  const secure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https';

  res.setHeader(
    'Set-Cookie',

    `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`
  );

}

// ======================================================
// DESTROY SESSION
// ======================================================

function destroySession(
  req: Request,
  res: Response
): void {

  const id = getCookie(
    req,
    SESSION_COOKIE
  );

  if (id) {
    sessions.delete(id);
  }

  const secure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https';

  res.setHeader(
    'Set-Cookie',

    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
  );

}

// ======================================================
// ERROR RESPONSE
// ======================================================

function sendApiError(
  res: Response,
  error: unknown
): void {

  const err =
    error instanceof BinanceRequestError
      ? error
      : new BinanceRequestError(
          error instanceof Error
            ? error.message
            : 'Unexpected server error.'
        );

  res.status(err.status).json({

    success: false,

    message: err.message,

    ...(err.code !== undefined
      ? { code: err.code }
      : {})

  });

}

// ======================================================
// QUERY SERIALIZATION
// ======================================================

function toQuery(
  params: Record<
    string,
    string | number | boolean | undefined
  >
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
// BINANCE REQUEST SIGNING
// ======================================================

async function binanceRequest<T = any>(
  method: 'GET' | 'POST' | 'DELETE',

  endpoint: string,

  params: Record<
    string,
    string | number | boolean | undefined
  > = {},

  signed = false,

  credentials?: BinanceCredentials

): Promise<T> {

  const query = toQuery(params);

  const headers: Record<string, string> = {};

  if (signed) {

    if (
      !credentials?.apiKey ||
      !credentials?.apiSecret
    ) {

      throw new BinanceRequestError(
        'Binance credentials are missing.',
        401
      );

    }

    query.set(
      'recvWindow',
      String(RECV_WINDOW)
    );

    query.set(
      'timestamp',
      String(Date.now())
    );

    const signature = createHmac(
      'sha256',
      credentials.apiSecret
    )
      .update(query.toString())
      .digest('hex');

    query.set('signature', signature);

    headers['X-MBX-APIKEY'] =
      credentials.apiKey;

  }

  const queryString = query.toString();

  const url =
    `${BINANCE_REST}${endpoint}` +
    (queryString ? `?${queryString}` : '');

  try {

    const response = await axios.request<T>({

      url,

      method,

      headers,

      timeout: 12000,

      validateStatus: () => true

    });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {

      const body: any = response.data;

      throw new BinanceRequestError(

        body?.msg ||
        `Binance HTTP ${response.status}`,

        response.status,

        typeof body?.code === 'number'
          ? body.code
          : undefined

      );

    }

    return response.data;

  } catch (error: any) {

    if (error instanceof BinanceRequestError) {
      throw error;
    }

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
// SYMBOL VALIDATION
// ======================================================

function cleanSymbol(value: unknown): string {

  const symbol = String(value || '')
    .replace('/', '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {

    throw new BinanceRequestError(
      'Invalid market symbol.',
      400
    );

  }

  return symbol;

}

// ======================================================
// QUANTITY ROUNDING
// ======================================================

function floorQuantityToStep(
  quantity: number,
  stepSize: string
): string {

  const step = Number(stepSize);

  if (!Number.isFinite(step) || step <= 0) {

    throw new BinanceRequestError(
      'Invalid quantity step.',
      502
    );

  }

  const decimals = (
    stepSize.split('.')[1] || ''
  )
    .replace(/0+$/, '')
    .length;

  const units = Math.floor(
    quantity / step + 1e-10
  );

  return (units * step).toFixed(decimals);

}

// ======================================================
// ORDER CALCULATION
// ======================================================

async function calculateDemoOrder(input: any) {

  const symbol = cleanSymbol(input?.symbol);

  const side = String(
    input?.side || ''
  ).toUpperCase();

  if (
    side !== 'BUY' &&
    side !== 'SELL'
  ) {

    throw new BinanceRequestError(
      'Side must be BUY or SELL.',
      400
    );

  }

  const notionalUsd = Number(
    input?.quantityUsd
  );

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

  const leverage = Number(
    input?.leverage || 1
  );

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

    binanceRequest<any>(
      'GET',
      '/fapi/v1/exchangeInfo',
      { symbol }
    ),

    binanceRequest<any>(
      'GET',
      '/fapi/v1/ticker/price',
      { symbol }
    )

  ]);

  const market = info?.symbols?.find(
    (item: any) =>
      item.symbol === symbol
  );

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

    throw new BinanceRequestError(
      'Invalid market price.',
      502
    );

  }

  const filters = market.filters || [];

  const marketLot = filters.find(
    (f: any) => f.filterType === 'MARKET_LOT_SIZE'
  );

  const lot = filters.find(
    (f: any) => f.filterType === 'LOT_SIZE'
  );

  const filter =
    marketLot && Number(marketLot.stepSize) > 0
      ? marketLot
      : lot;

  if (!filter) {

    throw new BinanceRequestError(
      'Quantity rules are missing.',
      502
    );

  }

  const quantity = floorQuantityToStep(
    notionalUsd / price,
    String(filter.stepSize)
  );

  const numericQty = Number(quantity);

  if (
    !Number.isFinite(numericQty) ||
    numericQty < Number(filter.minQty || 0) ||
    numericQty > Number(
      filter.maxQty || Number.MAX_SAFE_INTEGER
    )
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
    notionalUsd
  };

}

// Authenticated Binance USD-M Futures Demo autonomous bot routes.
registerAutonomousDemoBotRoutes(app, {
  getCredentials: req => {
    const credentials = getSessionCredentials(req);
    if (!credentials) {
      throw new BinanceRequestError('Binance account is not connected.', 401);
    }
    return credentials;
  },
  binanceRequest,
  calculateDemoOrder,
  getSignals: async () => {
    const response = await axios.get(
      `http://127.0.0.1:${PORT}/api/quant/scan?limit=40&minVolume=250000`,
      { timeout: 45_000 }
    );
    if (!response.data?.success || !Array.isArray(response.data?.signals)) {
      throw new Error(response.data?.message || response.data?.error || 'Scanner returned an invalid response.');
    }
    return response.data.signals;
  },
  maxOrderUsd: MAX_ORDER_USD,
  maxLeverage: MAX_LEVERAGE,
});

// ======================================================
// CONNECT WITH MANUAL CREDENTIALS
// ======================================================

app.post('/api/binance/connect', async (req, res) => {

  try {

    const apiKey = String(
      req.body?.apiKey || ''
    ).trim();

    const apiSecret = String(
      req.body?.apiSecret || ''
    ).trim();

    if (
      !apiKey ||
      !apiSecret ||
      apiKey.length > 256 ||
      apiSecret.length > 512
    ) {

      throw new BinanceRequestError(
        'Enter both valid API credentials.',
        400
      );

    }

    const credentials = {
      apiKey,
      apiSecret
    };

    // Authenticate before storing anything.

    const account = await binanceRequest<any>(
      'GET',
      '/fapi/v3/account',
      {},
      true,
      credentials
    );

    // Create temporary HttpOnly session.

    createSession(req, res, credentials);

    const usdt = Array.isArray(account.assets)
      ? account.assets.find(
          (item: any) => item.asset === 'USDT'
        )
      : undefined;

    res.json({

      success: true,

      environment: 'USD_M_FUTURES_DEMO',

      canTrade: Boolean(account.canTrade),

      availableBalance: Number(
        usdt?.availableBalance ??
        account.availableBalance ??
        0
      ),

      walletBalance: Number(
        usdt?.walletBalance ??
        account.totalWalletBalance ??
        0
      ),

      message:
        'Binance Futures Demo authentication successful.'

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// DISCONNECT
// ======================================================

app.post('/api/binance/disconnect', (req, res) => {

  pauseAllAutonomousDemoBots('Binance API disconnected');
  destroySession(req, res);

  res.json({
    success: true,
    message: 'Binance Demo session disconnected.'
  });

});

// ======================================================
// CONFIGURATION
// ======================================================

app.get('/api/binance/config', (req, res) => {

  const connected = Boolean(
    getSessionCredentials(req, false)
  );

  res.json({

    success: true,

    environment: 'USD_M_FUTURES_DEMO',

    credentialsConfigured: connected,

    liveTradingEnabled: false,

    maxOrderUsd: MAX_ORDER_USD,

    maxLeverage: MAX_LEVERAGE

  });

});

// ======================================================
// TEST CONNECTION
// ======================================================

app.post('/api/binance/test', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

    const account = await binanceRequest<any>(
      'GET',
      '/fapi/v3/account',
      {},
      true,
      credentials
    );

    res.json({

      success: true,

      canTrade: Boolean(account.canTrade),

      message:
        'Binance account authenticated successfully.'

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// ACCOUNT
// ======================================================

app.get('/api/binance/account', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

    const account = await binanceRequest<any>(
      'GET',
      '/fapi/v3/account',
      {},
      true,
      credentials
    );

    res.json({

      success: true,

      canTrade: Boolean(account.canTrade),

      totalWalletBalance:
        account.totalWalletBalance || '0',

      availableBalance:
        account.availableBalance || '0',

      totalUnrealizedProfit:
        account.totalUnrealizedProfit || '0',

      assets: account.assets || []

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// POSITIONS
// ======================================================

app.get('/api/binance/positions', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

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
        position =>
          Number(position.positionAmt || 0) !== 0
      )

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// OPEN ORDERS
// ======================================================

app.get('/api/binance/open-orders', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

    const params: Record<string, string> = {};

    if (req.query.symbol) {

      params.symbol = cleanSymbol(
        req.query.symbol
      );

    }

    const [orders, algoOrders] = await Promise.all([
      binanceRequest<any[]>(
        'GET',
        '/fapi/v1/openOrders',
        params,
        true,
        credentials
      ),
      binanceRequest<any[]>(
        'GET',
        '/fapi/v1/openAlgoOrders',
        params,
        true,
        credentials
      )
    ]);

    const normalizedAlgoOrders = (algoOrders || []).map(order => ({
      ...order,
      orderId: order.algoId,
      clientOrderId: order.clientAlgoId,
      status: order.algoStatus,
      type: order.orderType,
      conditional: true
    }));

    res.json({
      success: true,
      orders: [...(orders || []), ...normalizedAlgoOrders]
    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// HISTORICAL CANDLES
// ======================================================

app.get('/api/binance/klines', async (req, res) => {

  try {

    const symbol = cleanSymbol(
      req.query.symbol
    );

    const intervals = new Set([
      '1m', '3m', '5m', '15m',
      '30m', '1h', '2h', '4h',
      '6h', '8h', '12h', '1d'
    ]);

    const interval = String(
      req.query.interval || '15m'
    );

    if (!intervals.has(interval)) {

      throw new BinanceRequestError(
        'Unsupported candle interval.',
        400
      );

    }

    const limit = Math.min(
      Math.max(
        Number(req.query.limit || 100),
        1
      ),
      1000
    );

    const data = await binanceRequest<any[]>(
      'GET',
      '/fapi/v1/klines',
      {
        symbol,
        interval,
        limit
      }
    );

    res.json({
      success: true,
      data
    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// TEST ORDER: NO EXECUTION
// ======================================================

app.post('/api/binance/order-test', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

    const order = await calculateDemoOrder(
      req.body
    );

    const result = await binanceRequest<any>(
      'POST',
      '/fapi/v1/order/test',
      {
        symbol: order.symbol,
        side: order.side,
        type: 'MARKET',
        quantity: order.quantity
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

      result

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// DEMO MARKET ORDER
// ======================================================

app.post('/api/binance/order', async (req, res) => {

  try {

    const credentials =
      getSessionCredentials(req)!;

    const order = await calculateDemoOrder(
      req.body
    );

    // Leverage is set separately.

    await binanceRequest(
      'POST',
      '/fapi/v1/leverage',
      {
        symbol: order.symbol,
        leverage: order.leverage
      },
      true,
      credentials
    );

    // Actual Demo market order.

    const result = await binanceRequest<any>(
      'POST',
      '/fapi/v1/order',
      {
        symbol: order.symbol,
        side: order.side,
        type: 'MARKET',
        quantity: order.quantity,
        newOrderRespType: 'RESULT'
      },
      true,
      credentials
    );

    const executedQty = Number(
      result?.executedQty || 0
    );

    const avgPrice = Number(
      result?.avgPrice || 0
    );

    const quoteTotal = Number(
      result?.cumQuote ||
      result?.cumQuoteQty ||
      0
    );

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

      message:
        `Binance Demo order ${result?.orderId ?? ''} accepted.`

    });

  } catch (error) {

    sendApiError(res, error);

  }

});

// ======================================================
// HEALTH
// ======================================================

app.get('/api/health', (_req, res) => {

  res.json({

    status: 'online',

    timestamp: Date.now(),

    binanceEnvironment: 'USD_M_FUTURES_DEMO',

    marketStreamStatus: upstreamStatus,

    credentialsMode: 'MANUAL_APP_SESSION'

  });

});

// ======================================================
// DEDICATED MARKET WEBSOCKET
// ======================================================

// CRITICAL:
// noServer prevents the market socket from taking over
// Vite's development HMR WebSocket connection.

const wss = new WebSocketServer({
  noServer: true
});

server.on('upgrade', (request, socket, head) => {

  let pathname: string;

  try {

    pathname = new URL(
      request.url || '/',
      'http://localhost'
    ).pathname;

  } catch {

    socket.destroy();

    return;

  }

  if (pathname !== '/ws/market') {

    // Do not intercept Vite HMR upgrades.

    return;

  }

  wss.handleUpgrade(
    request,
    socket,
    head,
    ws => {
      wss.emit('connection', ws, request);
    }
  );

});

// ======================================================
// BINANCE STREAM
// ======================================================

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
  'pepeusdt'
];

let upstream: WebSocket | null = null;

let reconnectTimer:
  ReturnType<typeof setTimeout> | null = null;

let reconnectAttempts = 0;

let shuttingDown = false;

let receivedFirstMessage = false;

let upstreamStatus:
  | 'LIVE'
  | 'RECONNECTING'
  | 'OFFLINE' = 'RECONNECTING';

// ======================================================
// BROADCAST
// ======================================================

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

// ======================================================
// CONNECTION STATUS
// ======================================================

function publishStatus(
  status: 'LIVE' | 'RECONNECTING' | 'OFFLINE'
): void {

  upstreamStatus = status;

  const wireStatus =
    status === 'LIVE'
      ? 'connected'
      : status === 'OFFLINE'
        ? 'disconnected'
        : 'reconnecting';

  broadcast(JSON.stringify({

    type: 'connection',

    status: wireStatus,

    upstream: status,

    environment: 'USD_M_FUTURES_DEMO'

  }));

}

// ======================================================
// RECONNECT
// ======================================================

function scheduleReconnect(): void {

  if (shuttingDown || reconnectTimer) return;

  publishStatus('RECONNECTING');

  const delay = Math.min(
    15000,
    1000 * (2 ** Math.min(reconnectAttempts, 4))
  );

  reconnectAttempts++;

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    connectBinance();

  }, delay);

}

// ======================================================
// CONNECT BINANCE STREAM
// ======================================================

function connectBinance(): void {

  if (shuttingDown) return;

  const streams = activeSymbols
    .map(symbol => `${symbol}@ticker`)
    .join('/');

  const url =
    `${BINANCE_STREAM}/stream?streams=${streams}`;

  try {

    upstream = new WebSocket(url, {
      handshakeTimeout: 12000
    });

    upstream.on('open', () => {

      reconnectAttempts = 0;

      receivedFirstMessage = false;

      publishStatus('RECONNECTING');

      console.log(
        'Connected to Binance Demo WebSocket. Waiting for ticker data.'
      );

    });

    upstream.on('message', data => {

      if (!receivedFirstMessage) {

        receivedFirstMessage = true;

        publishStatus('LIVE');

        console.log(
          'Binance Demo market data is flowing.'
        );

      }

      broadcast(data.toString());

    });

    upstream.on('error', error => {

      console.error(
        'Binance WebSocket error:',
        error.message
      );

      publishStatus('RECONNECTING');

      upstream?.terminate();

    });

    upstream.on('close', () => {

      console.warn(
        'Binance market stream disconnected.'
      );

      scheduleReconnect();

    });

  } catch (error) {

    console.error(
      'Binance WebSocket initialization failed:',
      error
    );

    scheduleReconnect();

  }

}

// ======================================================
// CLIENT CONNECTION
// ======================================================

wss.on('connection', client => {

  const status =
    upstreamStatus === 'LIVE'
      ? 'connected'
      : upstreamStatus === 'OFFLINE'
        ? 'disconnected'
        : 'reconnecting';

  client.send(JSON.stringify({

    type: 'connection',

    status,

    upstream: upstreamStatus,

    environment: 'USD_M_FUTURES_DEMO'

  }));

});

// ======================================================
// PRODUCTION / DEVELOPMENT
// ======================================================

async function configureApplication() {

  if (process.env.NODE_ENV === 'production') {

    app.use(
      express.static(
        path.resolve(__dirname, 'dist')
      )
    );

    app.use((req, res, next) => {

      if (
        req.method === 'GET' &&
        !req.path.startsWith('/api/')
      ) {

        return res.sendFile(
          path.resolve(__dirname, 'dist', 'index.html')
        );

      }

      next();

    });

  } else {

    const {
      createServer: createViteServer
    } = await import('vite');

    const vite = await createViteServer({

      configFile: path.resolve(
        __dirname,
        'vite.config.ts'
      ),

      server: {
        middlewareMode: true,
      },

      appType: 'spa'

    });

    app.use(vite.middlewares);

  }

}

// ======================================================
// START SERVER
// ======================================================

async function startServer() {

  await configureApplication();

  server.listen(PORT, '0.0.0.0', () => {

    console.log(
      `TurboScalp server listening on port ${PORT}`
    );

    console.log(
      'Binance environment: USD-M Futures Demo'
    );

    console.log(
      'API credentials: Enter manually in API Settings.'
    );

    console.log(
      'Market WebSocket: /ws/market'
    );

    if (process.env.DISABLE_BINANCE_STREAM !== 'true') {

      connectBinance();

    } else {

      publishStatus('OFFLINE');

    }

  });

}

// ======================================================
// SHUTDOWN
// ======================================================

function shutdown() {

  shutdownAutonomousDemoBot();
  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

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

startServer().catch(error => {

  console.error(
    'Application startup failed:',
    error
  );

  process.exitCode = 1;

});