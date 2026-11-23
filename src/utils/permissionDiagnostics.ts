// src/utils/permissionDiagnostics.ts
// Client-side types and deterministic status classifier matching server/permissionDiagnostics.ts.

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
  walletBalance?: number;
  availableBalance?: number;
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

export function classifyFuturesPermission(input: {
  apiAuthenticated: boolean;
  canTrade: boolean;
  orderTestPassed: boolean;
  orderTestMessage: string;
  orderTestCode: number | null;
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
