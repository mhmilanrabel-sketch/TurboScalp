// src/utils/permissionDiagnostics.ts
// Client-side types and classifier matching server/permissionDiagnostics.ts.
// GET /fapi/v3/account provides wallet/balances only (accountCanTrade is null).
// GET /fapi/v1/accountConfig is the authoritative source for canTrade === true.

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
  walletBalance?: number;
  availableBalance?: number;
  accountCanTrade: null;
  accountConfigCanTrade: boolean | null;
  canTrade: boolean;
  canTradeStatus: 'ENABLED' | 'DISABLED' | 'UNKNOWN';
  accountPermissionStatus: AccountTradingPermissionStatus;
  canDeposit?: boolean | null;
  canWithdraw?: boolean | null;
  dualSidePosition?: boolean | null;
  multiAssetsMargin?: boolean | null;
  feeTier?: number | null;
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
  lastVerifiedAt: number | null;
}

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
  lastVerifiedAt?: number | null;
}): FuturesPermissionDiagnostics {
  const verifiedAt = input.lastVerifiedAt ?? null;
  const walletBalance = Number.isFinite(Number(input.walletBalance))
    ? Number(input.walletBalance)
    : 0;
  const availableBalance = Number.isFinite(Number(input.availableBalance))
    ? Number(input.availableBalance)
    : 0;

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
