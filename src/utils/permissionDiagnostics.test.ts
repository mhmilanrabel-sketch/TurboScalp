// src/utils/permissionDiagnostics.test.ts
// Unit tests for non-executing Futures trading permission classification and diagnostics.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFuturesPermission } from './permissionDiagnostics';
import {
  runNonExecutingPermissionDiagnostic,
  type PermissionBinanceRequestFn,
} from '../../server/permissionDiagnostics';

test('classifyFuturesPermission returns DEMO ORDER VALIDATION PASSED when auth, canTrade, and orderTest all pass', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    canTrade: true,
    orderTestPassed: true,
    orderTestMessage: 'OK',
    orderTestCode: null,
    walletBalance: 5000,
    availableBalance: 5000,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.apiAuthStatus, 'AUTHENTICATED');
  assert.equal(res.canTradeStatus, 'ENABLED');
  assert.equal(res.orderTestStatus, 'PASSED');
  assert.equal(res.classificationMessage, 'DEMO ORDER VALIDATION PASSED.');
  assert.equal(res.tradingConfirmed, true);
});

test('classifyFuturesPermission returns FUTURES ACCOUNT TRADING DISABLED when canTrade is false even with 5,000 USDT wallet balance', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    canTrade: false,
    orderTestPassed: true,
    orderTestMessage: 'Order test returned 200',
    orderTestCode: null,
    walletBalance: 5000,
    availableBalance: 5000,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.apiAuthStatus, 'AUTHENTICATED');
  assert.equal(res.canTradeStatus, 'DISABLED');
  assert.equal(res.classificationMessage, 'FUTURES ACCOUNT TRADING DISABLED.');
  assert.equal(res.tradingConfirmed, false);
});

test('classifyFuturesPermission returns FUTURES API ORDER PERMISSION NOT CONFIRMED on API key permission error (-2015)', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    canTrade: true,
    orderTestPassed: false,
    orderTestMessage: 'Invalid API-key, IP, or permissions for action',
    orderTestCode: -2015,
    walletBalance: 5000,
    availableBalance: 5000,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.apiAuthStatus, 'AUTHENTICATED');
  assert.equal(res.canTradeStatus, 'ENABLED');
  assert.equal(res.orderTestStatus, 'FAILED');
  assert.equal(res.orderTestCode, -2015);
  assert.equal(res.orderTestMessage, 'Invalid API-key, IP, or permissions for action');
  assert.equal(res.classificationMessage, 'FUTURES API ORDER PERMISSION NOT CONFIRMED.');
  assert.equal(res.tradingConfirmed, false);
});

test('classifyFuturesPermission displays actual Binance error for non-permission order test failures', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    canTrade: true,
    orderTestPassed: false,
    orderTestMessage: 'Margin is insufficient.',
    orderTestCode: -2019,
    walletBalance: 5000,
    availableBalance: 5000,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.orderTestStatus, 'FAILED');
  assert.equal(res.orderTestCode, -2019);
  assert.equal(res.classificationMessage, 'Margin is insufficient.');
  assert.equal(res.tradingConfirmed, false);
});

test('runNonExecutingPermissionDiagnostic only uses POST /fapi/v1/order/test and never places /fapi/v1/order', async () => {
  const calledEndpoints: string[] = [];
  const mockReq: PermissionBinanceRequestFn = (async (
    method: string,
    endpoint: string
  ): Promise<any> => {
    calledEndpoints.push(`${method} ${endpoint}`);
    if (endpoint === '/fapi/v3/account') {
      return {
        canTrade: false,
        totalWalletBalance: '5000.00',
        availableBalance: '5000.00',
        assets: [{ asset: 'USDT', walletBalance: '5000.00', availableBalance: '5000.00' }],
      };
    }
    if (endpoint === '/fapi/v1/exchangeInfo') {
      return {
        symbols: [
          {
            symbol: 'BTCUSDT',
            filters: [
              { filterType: 'MARKET_LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' },
              { filterType: 'MIN_NOTIONAL', notional: '50' },
            ],
          },
        ],
      };
    }
    if (endpoint === '/fapi/v1/ticker/price') {
      return { price: '65000' };
    }
    if (endpoint === '/fapi/v1/positionSide/dual') {
      return { dualSidePosition: false };
    }
    if (method === 'POST' && endpoint === '/fapi/v1/order/test') {
      const err: any = new Error('Invalid API-key, IP, or permissions for action.');
      err.code = -2015;
      throw err;
    }
    throw new Error(`Unexpected endpoint called: ${method} ${endpoint}`);
  }) as PermissionBinanceRequestFn;

  const diag = await runNonExecutingPermissionDiagnostic(mockReq, {
    apiKey: 'demo-key',
    apiSecret: 'demo-secret',
  });

  assert.equal(diag.apiAuthStatus, 'AUTHENTICATED');
  assert.equal(diag.canTradeStatus, 'DISABLED');
  assert.equal(diag.orderTestStatus, 'FAILED');
  assert.equal(diag.orderTestCode, -2015);
  assert.equal(diag.classificationMessage, 'FUTURES ACCOUNT TRADING DISABLED.');
  assert.equal(diag.walletBalance, 5000);
  assert.equal(diag.availableBalance, 5000);
  assert.equal(diag.tradingConfirmed, false);
  assert.ok(calledEndpoints.includes('POST /fapi/v1/order/test'));
  assert.ok(!calledEndpoints.includes('POST /fapi/v1/order'));
});
