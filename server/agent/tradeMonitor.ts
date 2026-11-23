// server/agent/tradeMonitor.ts
// Agent 6 – Trade Monitoring & Learning Agent
// Monitors exchange positions, regular open orders, open Algo Orders,
// mark price, unrealized & realized PnL, trading fees, and funding fees.
// Preserves protective exits even when new entries are paused or stopped.
// Starts symbol cooldown on closure and saves completed trade + learning records.

import {
  appendAgentLog,
  getActiveTradeRecord,
  notifyTelegramEvent,
  recordCriticalError,
  recordTradeClosed,
  startSymbolCooldown,
  syncDailyEquity,
  updateOpenTradeMetrics,
  type AgentTradeRecord,
} from './agentStorage.js';
import {
  cancelAlgoOrderSafe,
  fetchOpenAlgoOrdersSafe,
  type BinanceRequestFn,
  type DemoCredentials,
} from './executionManager.js';
import type { AccountSnapshotInput } from './riskManager.js';

export interface ExchangePositionSnapshot {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  leverage: number;
}

export interface ExchangeStateSnapshot {
  account: AccountSnapshotInput;
  positions: ExchangePositionSnapshot[];
  openOrders: any[];
  algoOrders: any[];
  openOrdersCount: number;
}

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function readExchangeSnapshot(
  binanceRequest: BinanceRequestFn,
  credentials: DemoCredentials | null
): Promise<ExchangeStateSnapshot> {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    return {
      account: {
        connected: false,
        canTrade: false,
        availableBalance: 0,
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
      },
      positions: [],
      openOrders: [],
      algoOrders: [],
      openOrdersCount: 0,
    };
  }

  const [acct, posRisk, openOrders, algoOrders] = await Promise.all([
    binanceRequest<any>('GET', '/fapi/v3/account', {}, true, credentials),
    binanceRequest<any[]>('GET', '/fapi/v3/positionRisk', {}, true, credentials),
    binanceRequest<any[]>('GET', '/fapi/v1/openOrders', {}, true, credentials),
    fetchOpenAlgoOrdersSafe(binanceRequest, credentials),
  ]);

  const usdtAsset = Array.isArray(acct?.assets)
    ? acct.assets.find((a: any) => a.asset === 'USDT')
    : undefined;

  const totalWalletBalance = toNum(
    usdtAsset?.walletBalance ?? acct?.totalWalletBalance
  );
  const availableBalance = toNum(
    usdtAsset?.availableBalance ?? acct?.availableBalance
  );
  const totalUnrealizedProfit = toNum(acct?.totalUnrealizedProfit);

  if (totalWalletBalance > 0) {
    syncDailyEquity(totalWalletBalance);
  }

  const positions: ExchangePositionSnapshot[] = (
    Array.isArray(posRisk) ? posRisk : []
  )
    .map((p: any) => ({
      symbol: String(p.symbol || ''),
      positionSide: String(p.positionSide || 'BOTH'),
      positionAmt: toNum(p.positionAmt),
      entryPrice: toNum(p.entryPrice),
      markPrice: toNum(p.markPrice),
      unRealizedProfit: toNum(p.unRealizedProfit),
      leverage: toNum(p.leverage) || 1,
    }))
    .filter((p) => Math.abs(p.positionAmt) > 1e-12);

  const regList = Array.isArray(openOrders) ? openOrders : [];
  const algoList = Array.isArray(algoOrders) ? algoOrders : [];

  return {
    account: {
      connected: true,
      canTrade: Boolean(acct?.canTrade),
      availableBalance,
      totalWalletBalance,
      totalUnrealizedProfit,
    },
    positions,
    openOrders: regList,
    algoOrders: algoList,
    openOrdersCount: regList.length + algoList.length,
  };
}

export async function reconcilePositionAndOrders(
  binanceRequest: BinanceRequestFn,
  credentials: DemoCredentials | null,
  cooldownMinutes: number
): Promise<{
  snapshot: ExchangeStateSnapshot;
  activeTradeStillOpen: boolean;
  reconcileNote: string;
}> {
  const snapshot = await readExchangeSnapshot(binanceRequest, credentials);
  const active = getActiveTradeRecord();

  if (!credentials?.apiKey || !credentials?.apiSecret) {
    return {
      snapshot,
      activeTradeStillOpen: Boolean(active),
      reconcileNote: active
        ? `Awaiting Demo reconnect to reconcile ${active.symbol}`
        : 'Monitoring idle (Demo API disconnected)',
    };
  }

  if (!active) {
    if (snapshot.positions.length > 0) {
      const p = snapshot.positions[0];
      return {
        snapshot,
        activeTradeStillOpen: true,
        reconcileNote: `External open Demo position detected: ${p.symbol} (${p.positionAmt})`,
      };
    }
    return {
      snapshot,
      activeTradeStillOpen: false,
      reconcileNote: `Account reconciled · $0 uPnL · ${snapshot.openOrdersCount} open order(s)`,
    };
  }

  // Reconcile the bot-tracked OPEN trade against real Binance Demo state
  const livePos = snapshot.positions.find(
    (p) =>
      p.symbol === active.symbol &&
      (active.positionMode === 'ONE_WAY' || p.positionSide === active.positionSide)
  );

  if (!livePos) {
    // Position became flat: query exchange realized PnL, trading commissions, funding fees, and last trade exit price
    let realizedPnl = 0;
    let tradingFees = 0;
    let fundingFees = 0;
    let exitPrice: number | null = active.markPrice;

    try {
      const [incomes, userTrades] = await Promise.all([
        binanceRequest<any[]>(
          'GET',
          '/fapi/v1/income',
          { symbol: active.symbol, startTime: active.openedAt - 5_000, limit: 100 },
          true,
          credentials
        ),
        binanceRequest<any[]>(
          'GET',
          '/fapi/v1/userTrades',
          { symbol: active.symbol, startTime: active.openedAt - 5_000, limit: 50 },
          true,
          credentials
        ),
      ]);

      if (Array.isArray(incomes)) {
        for (const inc of incomes) {
          const amt = toNum(inc.income);
          if (inc.incomeType === 'REALIZED_PNL') realizedPnl += amt;
          else if (inc.incomeType === 'COMMISSION') tradingFees += Math.abs(amt);
          else if (inc.incomeType === 'FUNDING_FEE') fundingFees += amt;
        }
      }
      if (Array.isArray(userTrades) && userTrades.length > 0) {
        const lastFill = userTrades[userTrades.length - 1];
        const px = toNum(lastFill.price);
        if (px > 0) exitPrice = px;
      }
    } catch {
      // Fallback safely if income endpoint returns partial info
    }

    // Cancel any leftover bot-owned protective Algo orders cleanly
    await cancelAlgoOrderSafe(
      binanceRequest,
      credentials,
      active.symbol,
      active.stopAlgoId,
      active.stopClientAlgoId
    );
    await cancelAlgoOrderSafe(
      binanceRequest,
      credentials,
      active.symbol,
      active.targetAlgoId,
      active.targetClientAlgoId
    );

    const closed = await recordTradeClosed(active.id, {
      status: 'CLOSED',
      exitPrice,
      realizedPnl,
      tradingFees,
      fundingFees,
      closeReason: 'EXCHANGE_FLAT_RECONCILED',
      executionStatus: 'CLOSED',
    });

    await startSymbolCooldown(active.symbol, cooldownMinutes);

    const netPnl = closed?.netPnl ?? realizedPnl - tradingFees + fundingFees;
    appendAgentLog(
      'AGENT_6_MONITOR',
      'TRADE',
      `${active.symbol} closed on exchange · realized=${realizedPnl.toFixed(4)} USDT · fees=${tradingFees.toFixed(4)} · funding=${fundingFees.toFixed(4)} · net=${netPnl.toFixed(4)} USDT · ${cooldownMinutes}m cooldown started`,
      active.symbol
    );

    void notifyTelegramEvent(
      'POSITION_CLOSED',
      `${active.symbol} ${active.side} closed @ $${(exitPrice ?? active.entryPrice).toFixed(4)}\nNet PnL: ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT (Realized ${realizedPnl.toFixed(4)}, Fees ${tradingFees.toFixed(4)}, Funding ${fundingFees.toFixed(4)})`
    );

    return {
      snapshot,
      activeTradeStillOpen: false,
      reconcileNote: `Closed ${active.symbol} reconciled (net ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)})`,
    };
  }

  // Still open: reconcile mark price, unrealized PnL, and protective Algo Order status
  const matchingAlgos = snapshot.algoOrders.filter(
    (o: any) => o.symbol === active.symbol
  );
  const slAlive = matchingAlgos.some(
    (o: any) =>
      o.clientAlgoId === active.stopClientAlgoId ||
      (active.stopAlgoId && String(o.algoId) === String(active.stopAlgoId))
  );
  const tpAlive = matchingAlgos.some(
    (o: any) =>
      o.clientAlgoId === active.targetClientAlgoId ||
      (active.targetAlgoId && String(o.algoId) === String(active.targetAlgoId))
  );

  // Also sample accrued funding fees while open
  let accruedFunding = active.fundingFees ?? 0;
  try {
    const fundingRows = await binanceRequest<any[]>(
      'GET',
      '/fapi/v1/income',
      {
        symbol: active.symbol,
        incomeType: 'FUNDING_FEE',
        startTime: active.openedAt,
        limit: 50,
      },
      true,
      credentials
    );
    if (Array.isArray(fundingRows)) {
      accruedFunding = fundingRows.reduce((s, r) => s + toNum(r.income), 0);
    }
  } catch {
    // Non-fatal
  }

  if (!slAlive) {
    recordCriticalError(
      'MONITOR_MISSING_SL',
      `Protective STOP_MARKET Algo order missing for open ${active.symbol} position.`,
      active.symbol
    );
  }

  await updateOpenTradeMetrics(active.id, {
    markPrice: livePos.markPrice,
    entryPrice: livePos.entryPrice > 0 ? livePos.entryPrice : active.entryPrice,
    executedQuantity: String(Math.abs(livePos.positionAmt)),
    unrealizedPnl: livePos.unRealizedProfit,
    fundingFees: accruedFunding,
    stopStatus: slAlive ? 'ARMED' : 'FAILED',
    takeProfitStatus: tpAlive ? 'ARMED' : 'FAILED',
  });

  return {
    snapshot,
    activeTradeStillOpen: true,
    reconcileNote: `${active.symbol} OPEN · entry=$${livePos.entryPrice.toFixed(4)} mark=$${livePos.markPrice.toFixed(4)} uPnL=${livePos.unRealizedProfit >= 0 ? '+' : ''}$${livePos.unRealizedProfit.toFixed(2)}`,
  };
}

export function markUncertainStartupTrades(active: AgentTradeRecord | null): void {
  if (!active) return;
  appendAgentLog(
    'AGENT_6_MONITOR',
    'WARN',
    `Server restarted with OPEN trade ${active.symbol} (entry=${active.entryPrice}, SL Algo #${active.stopAlgoId}, TP Algo #${active.targetAlgoId}). Auto-trading remains DISABLED until explicit resumption; monitoring continues.`,
    active.symbol
  );
}
