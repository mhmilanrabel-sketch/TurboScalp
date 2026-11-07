
const SESSION_KEY = 'turboscalp_demo_session';

export interface BinanceConfig {
  success: boolean;
  environment: string;
  credentialsConfigured: boolean;
  liveTradingEnabled: boolean;
  maxOrderUsd: number;
  maxLeverage: number;
}

export interface BinanceAccount {
  success: boolean;
  canTrade: boolean;
  totalWalletBalance: string;
  availableBalance: string;
  totalUnrealizedProfit: string;
  assets?: any[];
}

export interface BinanceConnectionResult {
  success: boolean;
  environment: string;
  canTrade: boolean;
  availableBalance: number;
  walletBalance: number;
  message: string;
}

export interface BinanceConnectionState {
  connected: boolean;
  walletBalance?: number;
  availableBalance?: number;
  canTrade?: boolean;
}

export interface BinanceOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantityUsd: number;
  leverage: number;
}

// ======================================================
// TEMPORARY SESSION TOKEN
// ======================================================

function getSessionToken(): string {

  try {

    return sessionStorage.getItem(
      SESSION_KEY
    ) || '';

  } catch {

    return '';

  }

}

function saveSessionToken(token: string): void {

  if (!token) {
    throw new Error('Server did not return a session token.');
  }

  try {

    sessionStorage.setItem(
      SESSION_KEY,
      token
    );

  } catch {

    throw new Error(
      'Unable to save the temporary connection session.'
    );

  }

}

function clearSessionToken(): void {

  try {

    sessionStorage.removeItem(
      SESSION_KEY
    );

  } catch {

    // Nothing else to clear.

  }

}

// ======================================================
// GENERAL API REQUEST
// ======================================================

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {

  const headers = new Headers(options.headers || {});

  if (options.body && !headers.has('Content-Type')) {

    headers.set(
      'Content-Type',
      'application/json'
    );

  }

  const token = getSessionToken();

  if (token) {

    headers.set(
      'X-TS-Session',
      token
    );

  }

  const response = await fetch(endpoint, {

    ...options,

    credentials: 'same-origin',

    cache: 'no-store',

    headers

  });

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || data?.success === false) {

    throw new Error(
      data?.message ||
      data?.msg ||
      `Request failed: HTTP ${response.status}`
    );

  }

  return data as T;

}

// ======================================================
// MANUAL BINANCE CONNECTION
// ======================================================

export async function connectBinanceDemo(
  apiKey: string,
  apiSecret: string
): Promise<BinanceConnectionResult> {

  if (!apiKey.trim() || !apiSecret.trim()) {

    throw new Error(
      'API Key and API Secret are required.'
    );

  }

  // This request is the only request that sends
  // the exchange API Key and Secret from the browser.

  const response = await fetch(
    '/api/binance/connect',
    {

      method: 'POST',

      credentials: 'same-origin',

      cache: 'no-store',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({

        apiKey: apiKey.trim(),

        apiSecret: apiSecret.trim()

      })

    }
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || data?.success !== true) {

    throw new Error(
      data?.message ||
      'Binance authentication failed.'
    );

  }

  // The server returns an application session token,
  // NOT the Binance API key or secret.

  saveSessionToken(data.sessionToken);

  return data as BinanceConnectionResult;

}

// ======================================================
// SERVER CONFIGURATION
// ======================================================

export async function getBinanceConfig():
Promise<BinanceConfig> {

  const result = await apiRequest<BinanceConfig>(
    '/api/binance/config'
  );

  // An expired or invalid session is removed.

  if (!result.credentialsConfigured) {

    clearSessionToken();

  }

  return result;

}

// ======================================================
// CONNECTION RECHECK
// ======================================================

export async function testBinanceConnection():
Promise<{
  success: boolean;
  canTrade: boolean;
  message: string;
}> {

  return apiRequest(
    '/api/binance/test',
    {
      method: 'POST'
    }
  );

}

// ======================================================
// ACCOUNT AND WALLET
// ======================================================

export async function getBinanceAccount():
Promise<BinanceAccount> {

  return apiRequest<BinanceAccount>(
    '/api/binance/account'
  );

}

// ======================================================
// DISCONNECT
// ======================================================

export async function disconnectBinanceDemo():
Promise<{
  success: boolean;
  message?: string;
}> {

  const result = await apiRequest<{
    success: boolean;
    message?: string;
  }>(
    '/api/binance/disconnect',
    {
      method: 'POST'
    }
  );

  clearSessionToken();

  return result;

}

// ======================================================
// POSITIONS
// ======================================================

export async function getBinancePositions():

Promise<{
  success: boolean;
  positions: any[];
}> {

  return apiRequest(
    '/api/binance/positions'
  );

}

// ======================================================
// OPEN ORDERS
// ======================================================

export async function getBinanceOpenOrders():

Promise<{
  success: boolean;
  orders: any[];
}> {

  return apiRequest(
    '/api/binance/open-orders'
  );

}

// ======================================================
// HISTORICAL CANDLES
// ======================================================

export async function fetchBinanceKlines(
  symbol: string,
  interval = '15m',
  limit = 100
): Promise<any[]> {

  const query = new URLSearchParams({

    symbol: symbol.replace('/', '').toUpperCase(),

    interval,

    limit: String(
      Math.min(
        Math.max(limit, 1),
        1000
      )
    )

  });

  const result = await apiRequest<{
    success: boolean;
    data: any[];
  }>(
    `/api/binance/klines?${query.toString()}`
  );

  return result.data || [];

}

// ======================================================
// TEST ORDER
// ======================================================

export async function validateBinanceOrder(
  order: BinanceOrder
): Promise<any> {

  return apiRequest(
    '/api/binance/order-test',
    {

      method: 'POST',

      body: JSON.stringify(order)

    }
  );

}

// ======================================================
// EXECUTE DEMO ORDER
// ======================================================

export async function executeBinanceOrder(
  order: BinanceOrder
): Promise<any> {

  return apiRequest(
    '/api/binance/order',
    {

      method: 'POST',

      body: JSON.stringify(order)

    }
  );

}