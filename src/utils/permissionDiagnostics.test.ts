// src/utils/permissionDiagnostics.test.ts
// Unit tests confirming /fapi/v3/account does NOT override /fapi/v1/accountConfig,
// accountCanTrade stays null, and strict cfg.canTrade === true / UNKNOWN handling works.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFuturesPermission } from './permissionDiagnostics';
import {
  runNonExecutingPermissionDiagnostic,
  type PermissionBinanceRequestFn,
} from '../../server/permissionDiagnostics';

test('runNonExecutingPermissionDiagnostic handles V3 without canTrade + V1 accountConfig canTrade=true + order/test PASS', async () => {
  const calledEndpoints: string[] = [];
  const mockReq: PermissionBinanceRequestFn = (async (
    method: string,
    endpoint: string
  ): Promise<any> => {
    calledEndpoints.push(`${method} ${endpoint}`);
    if (endpoint === '/fapi/v3/account') {
      // Real Binance V3 response since July 24, 2024: NO canTrade field!
      return {
        totalWalletBalance: '5000.00',
        availableBalance: '5000.00',
        totalUnrealizedProfit: '0.00',
        assets: [
          {
            asset: 'USDT',
            walletBalance: '5000.00',
            availableBalance: '5000.00',
          },
        ],
      };
    }
    if (endpoint === '/fapi/v1/accountConfig') {
      return {
        feeTier: 0,
        canTrade: true,
        canDeposit: true,
        canWithdraw: true,
        dualSidePosition: false,
        multiAssetsMargin: false,
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
    if (method === 'POST' && endpoint === '/fapi/v1/order/test') {
      return {};
    }
    throw new Error(`Unexpected endpoint called: ${method} ${endpoint}`);
  }) as PermissionBinanceRequestFn;

  const diag = await runNonExecutingPermissionDiagnostic(mockReq, {
    apiKey: 'demo-key',
    apiSecret: 'demo-secret',
  });

  assert.equal(diag.authenticated, true);
  assert.equal(diag.apiAuthStatus, 'VERIFIED');
  assert.equal(diag.environment, 'USD_M_FUTURES_DEMO');
  assert.equal(diag.walletBalance, 5000);
  assert.equal(diag.availableBalance, 5000);
  assert.equal(diag.accountCanTrade, null);
  assert.equal(diag.accountConfigCanTrade, true);
  assert.equal(diag.canTrade, true);
  assert.equal(diag.canTradeStatus, 'ENABLED');
  assert.equal(diag.orderTestPassed, true);
  assert.equal(diag.dualSidePosition, false);
  assert.equal(diag.feeTier, 0);
  assert.equal(
    diag.permissionStatus,
    'ACCOUNT_PERMISSION_AND_TEST_VALIDATION_PASSED'
  );
  assert.equal(diag.tradingConfirmed, true);
  assert.ok(calledEndpoints.includes('GET /fapi/v3/account'));
  assert.ok(calledEndpoints.includes('GET /fapi/v1/accountConfig'));
  assert.ok(calledEndpoints.includes('POST /fapi/v1/order/test'));
  assert.ok(!calledEndpoints.includes('POST /fapi/v1/order'));
});

test('classifyFuturesPermission returns ACCOUNT TRADING DISABLED when accountConfigCanTrade is false even if wallet=5000 and order/test passes', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    accountConfigCanTrade: false,
    orderTestPassed: true,
    orderTestMessage: 'OK',
    orderTestCode: null,
    walletBalance: 5000,
    availableBalance: 5000,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.apiAuthStatus, 'VERIFIED');
  assert.equal(res.accountCanTrade, null);
  assert.equal(res.accountConfigCanTrade, false);
  assert.equal(res.canTradeStatus, 'DISABLED');
  assert.equal(res.permissionStatus, 'ACCOUNT_TRADING_DISABLED');
  assert.equal(res.classificationMessage, 'ACCOUNT TRADING DISABLED.');
  assert.equal(res.tradingConfirmed, false);
});

test('classifyFuturesPermission returns UNKNOWN when /fapi/v1/accountConfig omits boolean canTrade field', () => {
  const res = classifyFuturesPermission({
    apiAuthenticated: true,
    accountEndpointOk: true,
    accountConfigEndpointOk: true,
    accountConfigCanTrade: null,
    orderTestPassed: true,
    orderTestMessage: 'OK',
    orderTestCode: null,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(res.accountCanTrade, null);
  assert.equal(res.accountConfigCanTrade, null);
  assert.equal(res.canTrade, false);
  assert.equal(res.canTradeStatus, 'UNKNOWN');
  assert.equal(res.accountPermissionStatus, 'UNKNOWN');
  assert.equal(res.permissionStatus, 'ACCOUNT_PERMISSION_UNKNOWN');
  assert.equal(res.tradingConfirmed, false);
});

test('classifyFuturesPermission displays exact Binance error code and message on endpoint failure', () => {
  const configFail = classifyFuturesPermission({
    apiAuthenticated: true,
    accountConfigCanTrade: null,
    accountEndpointOk: true,
    accountConfigEndpointOk: false,
    accountConfigErrorCode: -2015,
    accountConfigErrorMessage: 'Invalid API-key, IP, or permissions for action.',
    orderTestPassed: true,
    orderTestMessage: 'OK',
    orderTestCode: null,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(configFail.accountPermissionStatus, 'ERROR');
  assert.equal(configFail.permissionStatus, 'ENDPOINT_ERROR');
  assert.equal(configFail.accountConfigErrorCode, -2015);
  assert.match(configFail.classificationMessage, /\[Code -2015\]/);
  assert.equal(configFail.tradingConfirmed, false);

  const orderFail = classifyFuturesPermission({
    apiAuthenticated: true,
    accountConfigCanTrade: true,
    orderTestPassed: false,
    orderTestMessage: 'Margin is insufficient.',
    orderTestCode: -2019,
    lastVerifiedAt: 1_750_000_000_000,
  });

  assert.equal(orderFail.orderTestStatus, 'FAILED');
  assert.equal(orderFail.permissionStatus, 'ORDER_TEST_VALIDATION_FAILED');
  assert.equal(orderFail.orderTestCode, -2019);
  assert.match(
    orderFail.classificationMessage,
    /\[Code -2019\]: Margin is insufficient\./
  );
  assert.equal(orderFail.tradingConfirmed, false);
});
