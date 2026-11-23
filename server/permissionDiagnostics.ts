// server/permissionDiagnostics.ts
// Binance USD-M Futures DEMO permission diagnostics.
// Strictly uses https://demo-fapi.binance.com.
// Never reads account configuration fields from GET /fapi/v3/account
// (removed by Binance on July 24, 2024); uses GET /fapi/v1/accountConfig
// as the authoritative source for canTrade === true and account configuration.
// Never places live or Demo orders during diagnostics.

export const BINANCE_DEMO_REST_ENDPOINT = 'https://demo-fapi.binance.com';

export type ApiAuthStatus = 'VERIFIED' | 'DISCONNECTED';
export type AccountTradingPermissionStatus =
  | 'ENABLED'
  | 'DISABLED'
  | 'UNKNOWN'
  | 'ERROR';
export type OrderTestStatus = 'PASSED' | 'FAILED';

export type PermissionStatusCode =
  | 'ACCOUNT_PERMISSION_AND_TEST_VALIDATION_PASSED'
  | 'ACCOUNT_TRADING_DISABLED'
  | 'ACCOUNT_PERMISSION_UNKNOWN'
  | 'ORDER_TEST_VALIDATION_FAILED'
  | 'ENDPOINT_ERROR'
  | 'DISCONNECTED';

export type PermissionClassificationCode =
  | 'DEMO_ORDER_VALIDATION_PASSED'
  | 'ACCOUNT_TRADING_DISABLED'
  | 'ACCOUNT_PERMISSION_UNKNOWN'
  | 'ENDPOINT_ERROR'
  | 'DISCONNECTED';

export interface FuturesPermissionDiagnostics {
  environment: 'USD_M_FUTURES_DEMO';
  restEndpoint: string;
  authenticated: boolean;
  apiAuthenticated: boolean;
  apiAuthStatus: ApiAuthStatus;
  walletBalance: number;
  availableBalance: number;
  accountCanTrade: null;
  accountConfigCanTrade: boolean | null;
  canTrade: boolean;
  canTradeStatus: 'ENABLED' | 'DISABLED' | 'UNKNOWN';
  accountPermissionStatus: AccountTradingPermissionStatus;
  canDeposit: boolean | null;
  canWithdraw: boolean | null;
  dualSidePosition: boolean | null;
  multiAssetsMargin: boolean | null;
  feeTier: number | null;
  orderTestPassed: boolean;
  orderTestStatus: OrderTestStatus;
  orderTestMessage: string;
  orderTestCode: number | null;
  accountEndpointOk: boolean;
  accountErrorCode: number | null;
  accountErrorMessage: string | null;
  accountConfigEndpointOk: boolean;
  accountConfigErrorCode: number | null;
  accountConfigErrorMessage: string | null;
  permissionStatus: PermissionStatusCode;
  classificationCode: PermissionClassificationCode;
  classificationMessage: string;
  tradingConfirmed: boolean;
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

function formatEndpointFailure(
  endpoint: string,
  code: number | null,
  message: string
): string {
  const cleanMsg = message.trim() || 'Request failed.';
  return code !== null
    ? `${endpoint} failed [Code ${code}]: ${cleanMsg}`
    : `${endpoint} failed: ${cleanMsg}`;
}

function extractBinanceError(
  err: any,
  fallbackMessage: string
): { code: number | null; message: string } {
  const code =
    typeof err?.code === 'number' && Number.isFinite(err.code)
      ? err.code
      : typeof err?.status === 'number' && Number.isFinite(err.status)
        ? err.status
        : null;
  const message =
    String(err?.message || fallbackMessage).trim() || fallbackMessage;
  return { code, message };
}

export function classifyFuturesPermission(input: {
  apiAuthenticated: boolean;
  accountConfigCanTrade?: boolean | null;
  accountEndpointOk?: boolean;
  accountErrorCode?: number | null;
  accountErrorMessage?: string | null;
  accountConfigEndpointOk?: boolean;
  accountConfigErrorCode?: number | null;
  accountConfigErrorMessage?: string | null;
  orderTestPassed: boolean;
  orderTestMessage: string;
  orderTestCode: number | null;
  canDeposit?: boolean | null;
  canWithdraw?: boolean | null;
  dualSidePosition?: boolean | null;
  multiAssetsMargin?: boolean | null;
  feeTier?: number | null;
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

  // Authoritative trading permission comes strictly from GET /fapi/v1/accountConfig.
  // GET /fapi/v3/account does not return account configuration fields (always null).
  const accountConfigCanTrade =
    typeof input.accountConfigCanTrade === 'boolean'
      ? input.accountConfigCanTrade === true
      : null;

  const accountEndpointOk =
    input.accountEndpointOk !== undefined
      ? Boolean(input.accountEndpointOk)
      : input.apiAuthenticated;
  const accountConfigEndpointOk =
    input.accountConfigEndpointOk !== undefined
      ? Boolean(input.accountConfigEndpointOk)
      : accountConfigCanTrade !== null;

  const accountErrorCode =
    typeof input.accountErrorCode === 'number' &&
    Number.isFinite(input.accountErrorCode)
      ? input.accountErrorCode
      : null;
  const accountErrorMessage = input.accountErrorMessage
    ? String(input.accountErrorMessage).trim()
    : null;
  const accountConfigErrorCode =
    typeof input.accountConfigErrorCode === 'number' &&
    Number.isFinite(input.accountConfigErrorCode)
      ? input.accountConfigErrorCode
      : null;
  const accountConfigErrorMessage = input.accountConfigErrorMessage
    ? String(input.accountConfigErrorMessage).trim()
    : null;

  const rawOrderMsg = String(input.orderTestMessage || '').trim();
  const orderTestCode =
    typeof input.orderTestCode === 'number' &&
    Number.isFinite(input.orderTestCode)
      ? input.orderTestCode
      : null;
  const orderTestPassed = Boolean(input.orderTestPassed);

  const canDeposit =
    typeof input.canDeposit === 'boolean' ? input.canDeposit : null;
  const canWithdraw =
    typeof input.canWithdraw === 'boolean' ? input.canWithdraw : null;
  const dualSidePosition =
    typeof input.dualSidePosition === 'boolean' ? input.dualSidePosition : null;
  const multiAssetsMargin =
    typeof input.multiAssetsMargin === 'boolean'
      ? input.multiAssetsMargin
      : null;
  const feeTier =
    typeof input.feeTier === 'number' && Number.isFinite(input.feeTier)
      ? input.feeTier
      : null;

  if (!input.apiAuthenticated) {
    const firstFailure = accountErrorMessage
      ? formatEndpointFailure(
          'GET /fapi/v3/account',
          accountErrorCode,
          accountErrorMessage
        )
      : accountConfigErrorMessage
        ? formatEndpointFailure(
            'GET /fapi/v1/accountConfig',
            accountConfigErrorCode,
            accountConfigErrorMessage
          )
        : rawOrderMsg || 'Binance Demo API session is disconnected.';

    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: false,
      apiAuthenticated: false,
      apiAuthStatus: 'DISCONNECTED',
      walletBalance: 0,
      availableBalance: 0,
      accountCanTrade: null,
      accountConfigCanTrade: null,
      canTrade: false,
      canTradeStatus: 'UNKNOWN',
      accountPermissionStatus: 'ERROR',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed: false,
      orderTestStatus: 'FAILED',
      orderTestMessage: rawOrderMsg || firstFailure,
      orderTestCode,
      accountEndpointOk: false,
      accountErrorCode,
      accountErrorMessage,
      accountConfigEndpointOk: false,
      accountConfigErrorCode,
      accountConfigErrorMessage,
      permissionStatus: 'DISCONNECTED',
      classificationCode: 'DISCONNECTED',
      classificationMessage: firstFailure,
      tradingConfirmed: false,
      lastVerifiedAt: verifiedAt,
    };
  }

  // GET /fapi/v1/accountConfig request itself failed -> report exact Binance error
  if (!accountConfigEndpointOk) {
    const msg = formatEndpointFailure(
      'GET /fapi/v1/accountConfig',
      accountConfigErrorCode,
      accountConfigErrorMessage || 'Signed accountConfig request failed.'
    );
    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: true,
      apiAuthenticated: true,
      apiAuthStatus: 'VERIFIED',
      walletBalance,
      availableBalance,
      accountCanTrade: null,
      accountConfigCanTrade: null,
      canTrade: false,
      canTradeStatus: 'UNKNOWN',
      accountPermissionStatus: 'ERROR',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed,
      orderTestStatus: orderTestPassed ? 'PASSED' : 'FAILED',
      orderTestMessage:
        rawOrderMsg ||
        (orderTestPassed
          ? 'POST /fapi/v1/order/test passed without placing an order.'
          : 'POST /fapi/v1/order/test failed.'),
      orderTestCode,
      accountEndpointOk,
      accountErrorCode,
      accountErrorMessage,
      accountConfigEndpointOk: false,
      accountConfigErrorCode,
      accountConfigErrorMessage:
        accountConfigErrorMessage || 'GET /fapi/v1/accountConfig failed.',
      permissionStatus: 'ENDPOINT_ERROR',
      classificationCode: 'ENDPOINT_ERROR',
      classificationMessage: msg,
      tradingConfirmed: false,
      lastVerifiedAt: verifiedAt,
    };
  }

  // GET /fapi/v1/accountConfig succeeded, check strict boolean field
  if (accountConfigCanTrade === null) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: true,
      apiAuthenticated: true,
      apiAuthStatus: 'VERIFIED',
      walletBalance,
      availableBalance,
      accountCanTrade: null,
      accountConfigCanTrade: null,
      canTrade: false,
      canTradeStatus: 'UNKNOWN',
      accountPermissionStatus: 'UNKNOWN',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed,
      orderTestStatus: orderTestPassed ? 'PASSED' : 'FAILED',
      orderTestMessage:
        rawOrderMsg ||
        (orderTestPassed
          ? 'POST /fapi/v1/order/test passed without placing an order.'
          : 'POST /fapi/v1/order/test failed.'),
      orderTestCode,
      accountEndpointOk,
      accountErrorCode,
      accountErrorMessage,
      accountConfigEndpointOk: true,
      accountConfigErrorCode: null,
      accountConfigErrorMessage: null,
      permissionStatus: 'ACCOUNT_PERMISSION_UNKNOWN',
      classificationCode: 'ACCOUNT_PERMISSION_UNKNOWN',
      classificationMessage:
        'FUTURES ACCOUNT TRADING PERMISSION: UNKNOWN (canTrade missing from /fapi/v1/accountConfig).',
      tradingConfirmed: false,
      lastVerifiedAt: verifiedAt,
    };
  }

  // GET /fapi/v3/account failed while /fapi/v1/accountConfig succeeded
  if (!accountEndpointOk) {
    const msg = formatEndpointFailure(
      'GET /fapi/v3/account',
      accountErrorCode,
      accountErrorMessage || 'Signed account balance request failed.'
    );
    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: true,
      apiAuthenticated: true,
      apiAuthStatus: 'VERIFIED',
      walletBalance,
      availableBalance,
      accountCanTrade: null,
      accountConfigCanTrade,
      canTrade: accountConfigCanTrade,
      canTradeStatus: accountConfigCanTrade ? 'ENABLED' : 'DISABLED',
      accountPermissionStatus: accountConfigCanTrade ? 'ENABLED' : 'DISABLED',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed,
      orderTestStatus: orderTestPassed ? 'PASSED' : 'FAILED',
      orderTestMessage:
        rawOrderMsg ||
        (orderTestPassed
          ? 'POST /fapi/v1/order/test passed without placing an order.'
          : 'POST /fapi/v1/order/test failed.'),
      orderTestCode,
      accountEndpointOk: false,
      accountErrorCode,
      accountErrorMessage:
        accountErrorMessage || 'GET /fapi/v3/account failed.',
      accountConfigEndpointOk: true,
      accountConfigErrorCode: null,
      accountConfigErrorMessage: null,
      permissionStatus: 'ENDPOINT_ERROR',
      classificationCode: 'ENDPOINT_ERROR',
      classificationMessage: msg,
      tradingConfirmed: false,
      lastVerifiedAt: verifiedAt,
    };
  }

  // Authoritative accountConfig.canTrade === false
  if (accountConfigCanTrade === false) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: true,
      apiAuthenticated: true,
      apiAuthStatus: 'VERIFIED',
      walletBalance,
      availableBalance,
      accountCanTrade: null,
      accountConfigCanTrade: false,
      canTrade: false,
      canTradeStatus: 'DISABLED',
      accountPermissionStatus: 'DISABLED',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed,
      orderTestStatus: orderTestPassed ? 'PASSED' : 'FAILED',
      orderTestMessage:
        rawOrderMsg ||
        (orderTestPassed
          ? 'POST /fapi/v1/order/test passed (parameter check only); /fapi/v1/accountConfig reports canTrade=false.'
          : 'POST /fapi/v1/order/test failed.'),
      orderTestCode,
      accountEndpointOk: true,
      accountErrorCode: null,
      accountErrorMessage: null,
      accountConfigEndpointOk: true,
      accountConfigErrorCode: null,
      accountConfigErrorMessage: null,
      permissionStatus: 'ACCOUNT_TRADING_DISABLED',
      classificationCode: 'ACCOUNT_TRADING_DISABLED',
      classificationMessage: 'ACCOUNT TRADING DISABLED.',
      tradingConfirmed: false,
      lastVerifiedAt: verifiedAt,
    };
  }

  // Authoritative accountConfig.canTrade === true AND order/test PASSED
  if (orderTestPassed) {
    return {
      environment: 'USD_M_FUTURES_DEMO',
      restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
      authenticated: true,
      apiAuthenticated: true,
      apiAuthStatus: 'VERIFIED',
      walletBalance,
      availableBalance,
      accountCanTrade: null,
      accountConfigCanTrade: true,
      canTrade: true,
      canTradeStatus: 'ENABLED',
      accountPermissionStatus: 'ENABLED',
      canDeposit,
      canWithdraw,
      dualSidePosition,
      multiAssetsMargin,
      feeTier,
      orderTestPassed: true,
      orderTestStatus: 'PASSED',
      orderTestMessage:
        rawOrderMsg ||
        'Binance Demo POST /fapi/v1/order/test accepted non-executing order validation.',
      orderTestCode: null,
      accountEndpointOk: true,
      accountErrorCode: null,
      accountErrorMessage: null,
      accountConfigEndpointOk: true,
      accountConfigErrorCode: null,
      accountConfigErrorMessage: null,
      permissionStatus: 'ACCOUNT_PERMISSION_AND_TEST_VALIDATION_PASSED',
      classificationCode: 'DEMO_ORDER_VALIDATION_PASSED',
      classificationMessage:
        'ACCOUNT PERMISSION AND DEMO ORDER VALIDATION PASSED.',
      tradingConfirmed: true,
      lastVerifiedAt: verifiedAt,
    };
  }

  // Authoritative accountConfig.canTrade === true, but order/test FAILED
  const orderFailureMsg = formatEndpointFailure(
    'POST /fapi/v1/order/test',
    orderTestCode,
    rawOrderMsg || 'Order validation request failed.'
  );
  return {
    environment: 'USD_M_FUTURES_DEMO',
    restEndpoint: BINANCE_DEMO_REST_ENDPOINT,
    authenticated: true,
    apiAuthenticated: true,
    apiAuthStatus: 'VERIFIED',
    walletBalance,
    availableBalance,
    accountCanTrade: null,
    accountConfigCanTrade: true,
    canTrade: true,
    canTradeStatus: 'ENABLED',
    accountPermissionStatus: 'ENABLED',
    canDeposit,
    canWithdraw,
    dualSidePosition,
    multiAssetsMargin,
    feeTier,
    orderTestPassed: false,
    orderTestStatus: 'FAILED',
    orderTestMessage: rawOrderMsg || 'Order validation request failed.',
    orderTestCode,
    accountEndpointOk: true,
    accountErrorCode: null,
    accountErrorMessage: null,
    accountConfigEndpointOk: true,
    accountConfigErrorCode: null,
    accountConfigErrorMessage: null,
    permissionStatus: 'ORDER_TEST_VALIDATION_FAILED',
    classificationCode: 'ENDPOINT_ERROR',
    classificationMessage: orderFailureMsg,
    tradingConfirmed: false,
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
  credentials: { apiKey: string; apiSecret: string },
  knownDualSidePosition?: boolean | null
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
      const targetUsd = Math.max(
        60,
        Number.isFinite(minNotional) ? minNotional * 1.2 : 60
      );
      if (qtyFilter?.stepSize) {
        const computed = ceilQtyToStep(
          targetUsd / price,
          String(qtyFilter.stepSize)
        );
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
  if (typeof knownDualSidePosition === 'boolean') {
    if (knownDualSidePosition) {
      positionSideParam = { positionSide: 'LONG' };
    }
  } else {
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
  // Query GET /fapi/v3/account (for balances/assets) and GET /fapi/v1/accountConfig (authoritative permissions)
  const accountPromise = preFetchedAccount
    ? Promise.resolve(preFetchedAccount)
    : binanceRequest<any>('GET', '/fapi/v3/account', {}, true, credentials);

  const accountConfigPromise = binanceRequest<any>(
    'GET',
    '/fapi/v1/accountConfig',
    {},
    true,
    credentials
  );

  const [accountSettled, configSettled] = await Promise.allSettled([
    accountPromise,
    accountConfigPromise,
  ]);

  let accountEndpointOk = false;
  let accountErrorCode: number | null = null;
  let accountErrorMessage: string | null = null;
  let walletBalance = 0;
  let availableBalance = 0;

  if (accountSettled.status === 'fulfilled' && accountSettled.value) {
    const account = accountSettled.value;
    accountEndpointOk = true;
    const usdt = Array.isArray(account?.assets)
      ? account.assets.find((item: any) => item.asset === 'USDT')
      : undefined;
    walletBalance = Number(
      usdt?.walletBalance ?? account?.totalWalletBalance ?? 0
    );
    availableBalance = Number(
      usdt?.availableBalance ?? account?.availableBalance ?? 0
    );
  } else {
    const err = extractBinanceError(
      accountSettled.status === 'rejected' ? accountSettled.reason : null,
      'Signed GET /fapi/v3/account request failed.'
    );
    accountEndpointOk = false;
    accountErrorCode = err.code;
    accountErrorMessage = err.message;
  }

  let accountConfigEndpointOk = false;
  let accountConfigCanTrade: boolean | null = null;
  let accountConfigErrorCode: number | null = null;
  let accountConfigErrorMessage: string | null = null;
  let canDeposit: boolean | null = null;
  let canWithdraw: boolean | null = null;
  let dualSidePosition: boolean | null = null;
  let multiAssetsMargin: boolean | null = null;
  let feeTier: number | null = null;

  if (configSettled.status === 'fulfilled' && configSettled.value) {
    const cfg = configSettled.value;
    accountConfigEndpointOk = true;
    // Strict boolean validation from authoritative /fapi/v1/accountConfig
    accountConfigCanTrade =
      typeof cfg?.canTrade === 'boolean' ? cfg.canTrade === true : null;
    if (typeof cfg?.canDeposit === 'boolean') canDeposit = cfg.canDeposit;
    if (typeof cfg?.canWithdraw === 'boolean') canWithdraw = cfg.canWithdraw;
    if (typeof cfg?.dualSidePosition === 'boolean') {
      dualSidePosition = cfg.dualSidePosition;
    }
    if (typeof cfg?.multiAssetsMargin === 'boolean') {
      multiAssetsMargin = cfg.multiAssetsMargin;
    }
    if (typeof cfg?.feeTier === 'number' && Number.isFinite(cfg.feeTier)) {
      feeTier = cfg.feeTier;
    }
  } else {
    const err = extractBinanceError(
      configSettled.status === 'rejected' ? configSettled.reason : null,
      'Signed GET /fapi/v1/accountConfig request failed.'
    );
    accountConfigEndpointOk = false;
    accountConfigCanTrade = null;
    accountConfigErrorCode = err.code;
    accountConfigErrorMessage = err.message;
  }

  const bothAuthRejected =
    !accountEndpointOk &&
    !accountConfigEndpointOk &&
    (isBinancePermissionError(accountErrorCode, accountErrorMessage || '') ||
      isBinancePermissionError(
        accountConfigErrorCode,
        accountConfigErrorMessage || ''
      ));

  const apiAuthenticated =
    accountEndpointOk || accountConfigEndpointOk || !bothAuthRejected;

  // Non-executing POST /fapi/v1/order/test when authenticated
  let orderTestPassed = false;
  let orderTestMessage = '';
  let orderTestCode: number | null = null;

  if (apiAuthenticated) {
    try {
      const testParams = await buildNonExecutingTestOrderParams(
        binanceRequest,
        credentials,
        dualSidePosition
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
      const parsed = extractBinanceError(
        err,
        'Binance Demo POST /fapi/v1/order/test failed.'
      );
      orderTestPassed = false;
      orderTestMessage = parsed.message;
      orderTestCode = parsed.code;
    }
  } else {
    orderTestPassed = false;
    orderTestMessage =
      accountErrorMessage ||
      accountConfigErrorMessage ||
      'Signed API authentication rejected.';
    orderTestCode = accountErrorCode ?? accountConfigErrorCode;
  }

  return classifyFuturesPermission({
    apiAuthenticated,
    accountConfigCanTrade,
    accountEndpointOk,
    accountErrorCode,
    accountErrorMessage,
    accountConfigEndpointOk,
    accountConfigErrorCode,
    accountConfigErrorMessage,
    orderTestPassed,
    orderTestMessage,
    orderTestCode,
    canDeposit,
    canWithdraw,
    dualSidePosition,
    multiAssetsMargin,
    feeTier,
    walletBalance,
    availableBalance,
    lastVerifiedAt: Date.now(),
  });
}
