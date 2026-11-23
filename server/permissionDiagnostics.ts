// server/permissionDiagnostics.ts
// Non-executing Binance USD-M Futures DEMO permission diagnostics.
// Strictly uses https://demo-fapi.binance.com via injected binanceRequest.
// Never places live or real orders during validation.

export type ApiAuthStatus = 'AUTHENTICATED' | 'DISCONNECTED';
export type AccountCanTradeStatus = 'ENABLED' | 'DISABLED';
export type OrderTestStatus = 'PASSED' | 'FAILED';

export type PermissionClassificationCode =
  | 'DEMO_ORDER_VALIDATION_PASSED'
  | 'FUTURES_ACCOUNT_DISABLED'
  | 'FUTURES_API_PERMISSION_ERROR'
  | 'ORDER_TEST_ERROR'
  | 'DISCONNECTED';

export interface FuturesPermissionDiagnostics {
  environment: 'USD_M_FUTURES_DEMO';
  apiAuthenticated: boolean;
  apiAuthStatus: ApiAuthStatus;
  canTrade: boolean;
  canTradeStatus: AccountCanTradeStatus;
  orderTestPassed: boolean;
  orderTestStatus: OrderTestStatus;
  orderTestMessage: string;
  orderTestCode: number | null;
  classificationCode: PermissionClassificationCode;
  classificationMessage: string;
  tradingConfirmed: boolean;
  walletBalance: number;
  availableBalance: number;
  lastVerifiedAt: number;
}

export type PermissionBinanceRequestFn = <T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>,
  signed?: boolean,
  credentials?: { apiKey: string; apiSecret: string }
) => Promise<T>;

export function isBinancePermissionError(
  code: number | null | undefined,
  message: string
): boolean {
  if (
    code === -2015 ||
    code === -2014 ||
    code === -1022 ||
    code === -1002 ||
    code === 401 ||
    code === 403
  ) {
    return true;
  }
  return /permission|invalid api-key|api-key|not authorized|unauthorized|enable futures|ip.*restrict|signature for this request is not valid/i.test(
    message || ''
  );
}

export function classifyFuturesPermission(input: {
  apiAuthenticated: boolean;
  canTrade: boolean;
  orderTestPassed: boolean;
  orderTestMessage: string;
  orderTestCode: number | null;
  walletBalance?: number;
  availableBalance?: number;
  lastVerifiedAt?: number;
}): FuturesPermissionDiagnostics {
  const verifiedAt = input.lastVerifiedAt ?? Date.now();
  const walletBalance = Number.isFinite(Number(input.walletBalance))
    ? Number(input.walletBalance)
    : 0;
  const availableBalance = Number.isFinite(Number(input.availableBalance))
    ? Number(input.availableBalance)
    : 0;
  const rawMessage = String(input.orderTestMessage || '').trim();
  const code =
    typeof input.orderTestCode === 'number' && Number.isFinite(input.orderTestCode)
      ? input.orderTestCode
      : null;

  if (!input.apiAuthenticated) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      apiAuthenticated: false,
      apiAuthStatus: 'DISCONNECTED',
      canTrade: false,
      canTradeStatus: 'DISABLED',
      orderTestPassed: false,
      orderTestStatus: 'FAILED',
      orderTestMessage:
        rawMessage || 'Binance Demo API session is disconnected.',
      orderTestCode: code,
      classificationCode: 'DISCONNECTED',
      classificationMessage:
        rawMessage || 'Binance Demo API session is disconnected.',
      tradingConfirmed: false,
      walletBalance: 0,
      availableBalance: 0,
      lastVerifiedAt: verifiedAt,
    };
  }

  const canTrade = Boolean(input.canTrade);
  const orderTestPassed = Boolean(input.orderTestPassed);

  if (!canTrade) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      apiAuthenticated: true,
      apiAuthStatus: 'AUTHENTICATED',
      canTrade: false,
      canTradeStatus: 'DISABLED',
      orderTestPassed,
      orderTestStatus: orderTestPassed ? 'PASSED' : 'FAILED',
      orderTestMessage:
        rawMessage || 'Binance account reports canTrade=false.',
      orderTestCode: code,
      classificationCode: 'FUTURES_ACCOUNT_DISABLED',
      classificationMessage: 'FUTURES ACCOUNT TRADING DISABLED.',
      tradingConfirmed: false,
      walletBalance,
      availableBalance,
      lastVerifiedAt: verifiedAt,
    };
  }

  if (orderTestPassed) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      apiAuthenticated: true,
      apiAuthStatus: 'AUTHENTICATED',
      canTrade: true,
      canTradeStatus: 'ENABLED',
      orderTestPassed: true,
      orderTestStatus: 'PASSED',
      orderTestMessage:
        rawMessage ||
        'Binance Demo POST /fapi/v1/order/test accepted non-executing order validation.',
      orderTestCode: null,
      classificationCode: 'DEMO_ORDER_VALIDATION_PASSED',
      classificationMessage: 'DEMO ORDER VALIDATION PASSED.',
      tradingConfirmed: true,
      walletBalance,
      availableBalance,
      lastVerifiedAt: verifiedAt,
    };
  }

  if (isBinancePermissionError(code, rawMessage)) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      apiAuthenticated: true,
      apiAuthStatus: 'AUTHENTICATED',
      canTrade: true,
      canTradeStatus: 'ENABLED',
      orderTestPassed: false,
      orderTestStatus: 'FAILED',
      orderTestMessage:
        rawMessage || 'Binance rejected test order due to API permission limits.',
      orderTestCode: code,
      classificationCode: 'FUTURES_API_PERMISSION_ERROR',
      classificationMessage: 'FUTURES API ORDER PERMISSION NOT CONFIRMED.',
      tradingConfirmed: false,
      walletBalance,
      availableBalance,
      lastVerifiedAt: verifiedAt,
    };
  }

  return {
    environment: 'USD_M_FUTURES_DEMO',
    apiAuthenticated: true,
    apiAuthStatus: 'AUTHENTICATED',
    canTrade: true,
    canTradeStatus: 'ENABLED',
    orderTestPassed: false,
    orderTestStatus: 'FAILED',
    orderTestMessage:
      rawMessage || 'Binance Demo POST /fapi/v1/order/test failed.',
    orderTestCode: code,
    classificationCode: 'ORDER_TEST_ERROR',
    classificationMessage:
      rawMessage || 'Binance Demo POST /fapi/v1/order/test failed.',
    tradingConfirmed: false,
    walletBalance,
    availableBalance,
    lastVerifiedAt: verifiedAt,
  };
}

function ceilQtyToStep(rawQty: number, stepSizeStr: string): string {
  const step = Number(stepSizeStr);
  if (!Number.isFinite(step) || step <= 0) return rawQty.toFixed(4);
  const decimals = (stepSizeStr.split('.')[1] || '').replace(/0+$/, '').length;
  const steps = Math.ceil(rawQty / step - 1e-12);
  return Math.max(step, steps * step).toFixed(decimals);
}

async function buildNonExecutingTestOrderParams(
  binanceRequest: PermissionBinanceRequestFn,
  credentials: { apiKey: string; apiSecret: string }
): Promise<Record<string, string>> {
  const symbol = 'BTCUSDT';
  let quantity = '0.002';

  try {
    const [info, ticker] = await Promise.all([
      binanceRequest<any>('GET', '/fapi/v1/exchangeInfo', { symbol }),
      binanceRequest<any>('GET', '/fapi/v1/ticker/price', { symbol }),
    ]);

    const market = info?.symbols?.find((s: any) => s.symbol === symbol);
    const price = Number(ticker?.price);
    if (market && Number.isFinite(price) && price > 0) {
      const filters = market.filters || [];
      const marketLot = filters.find(
        (f: any) => f.filterType === 'MARKET_LOT_SIZE'
      );
      const lot = filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const minNotionalFilter = filters.find(
        (f: any) => f.filterType === 'MIN_NOTIONAL'
      );
      const qtyFilter =
        marketLot && Number(marketLot.stepSize) > 0 ? marketLot : lot;
      const minNotional = Number(minNotionalFilter?.notional ?? 50);
      const targetUsd = Math.max(60, Number.isFinite(minNotional) ? minNotional * 1.2 : 60);
      if (qtyFilter?.stepSize) {
        const computed = ceilQtyToStep(targetUsd / price, String(qtyFilter.stepSize));
        const minQty = Number(qtyFilter.minQty ?? 0);
        quantity =
          Number(computed) >= minQty
            ? computed
            : ceilQtyToStep(minQty, String(qtyFilter.stepSize));
      }
    }
  } catch {
    // Fallback quantity remains valid for BTCUSDT on demo-fapi when exchangeInfo fails.
  }

  let positionSideParam: Record<string, string> = {};
  try {
    const dual = await binanceRequest<any>(
      'GET',
      '/fapi/v1/positionSide/dual',
      {},
      true,
      credentials
    );
    if (dual?.dualSidePosition === true) {
      positionSideParam = { positionSide: 'LONG' };
    }
  } catch {
    // Default One-Way mode if dual position mode query fails.
  }

  return {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity,
    ...positionSideParam,
  };
}

export async function runNonExecutingPermissionDiagnostic(
  binanceRequest: PermissionBinanceRequestFn,
  credentials: { apiKey: string; apiSecret: string },
  preFetchedAccount?: any
): Promise<FuturesPermissionDiagnostics> {
  const now = Date.now();
  let account = preFetchedAccount;

  if (!account) {
    try {
      account = await binanceRequest<any>(
        'GET',
        '/fapi/v3/account',
        {},
        true,
        credentials
      );
    } catch (err: any) {
      const code =
        typeof err?.code === 'number'
          ? err.code
          : typeof err?.status === 'number'
            ? err.status
            : null;
      return classifyFuturesPermission({
        apiAuthenticated: false,
        canTrade: false,
        orderTestPassed: false,
        orderTestMessage:
          err?.message || 'Signed Binance Demo account authentication failed.',
        orderTestCode: code,
        lastVerifiedAt: now,
      });
    }
  }

  const usdt = Array.isArray(account?.assets)
    ? account.assets.find((item: any) => item.asset === 'USDT')
    : undefined;
  const walletBalance = Number(
    usdt?.walletBalance ?? account?.totalWalletBalance ?? 0
  );
  const availableBalance = Number(
    usdt?.availableBalance ?? account?.availableBalance ?? 0
  );
  const canTrade = Boolean(account?.canTrade);

  let orderTestPassed = false;
  let orderTestMessage = '';
  let orderTestCode: number | null = null;

  try {
    const testParams = await buildNonExecutingTestOrderParams(
      binanceRequest,
      credentials
    );
    await binanceRequest<any>(
      'POST',
      '/fapi/v1/order/test',
      testParams,
      true,
      credentials
    );
    orderTestPassed = true;
    orderTestMessage =
      'Binance Demo POST /fapi/v1/order/test passed without placing an order.';
    orderTestCode = null;
  } catch (err: any) {
    orderTestPassed = false;
    orderTestMessage =
      err?.message || 'Binance Demo POST /fapi/v1/order/test failed.';
    orderTestCode =
      typeof err?.code === 'number'
        ? err.code
        : typeof err?.status === 'number'
          ? err.status
          : null;
  }

  return classifyFuturesPermission({
    apiAuthenticated: true,
    canTrade,
    orderTestPassed,
    orderTestMessage,
    orderTestCode,
    walletBalance,
    availableBalance,
    lastVerifiedAt: Date.now(),
  });
}
