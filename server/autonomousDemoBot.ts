// server/autonomousDemoBot.ts
// ─────────────────────────────────────────────────────────────
// Autonomous scalping bot for Binance USD-M Futures DEMO.
// Pushes every order to https://demo-fapi.binance.com
// ─────────────────────────────────────────────────────────────
import type { Express, Request, Response } from 'express';
import {
  buildProtectiveAlgoParams,
  cancelAlgoOrderSafe,
  fetchOpenAlgoOrdersSafe,
} from './agent/executionManager.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runNonExecutingPermissionDiagnostic } from './permissionDiagnostics.js';

// ── Types ──────────────────────────────────────────────────
type HttpMethod = 'GET' | 'POST' | 'DELETE';
type Credentials = { apiKey: string; apiSecret: string };

type BinanceRequest = (
  method: HttpMethod,
  endpoint: string,
  params?: Record<string, any>,
  signed?: boolean,
  credentials?: Credentials,
) => Promise<any>;

type Signal = {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  score: number;
  confidence: number;
  price: number;
  quoteVolume: number;
  volatilityPct: number;
  stopLoss: number | null;
  takeProfit: number | null;
  reasons?: string[];
};

type DemoOrderPlan = {
  symbol: string;
  side: 'BUY' | 'SELL';
  leverage: number;
  quantity: string;
  price: number;
  notionalUsd: number;
};

type TradeRecord = {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionMode?: 'ONE_WAY' | 'HEDGE';
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  lastEmergencyAttemptAt?: number;
  status: 'OPEN' | 'CLOSED';
  notionalUsd: number;
  quantity: string;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  stopPrice: number;
  targetPrice: number;
  unrealizedPnl: number;
  realizedPnl: number | null;
  entryOrderId: number | string | null;
  entryClientOrderId: string;
  stopAlgoId: number | string | null;
  stopClientAlgoId: string;
  targetAlgoId: number | string | null;
  targetClientAlgoId: string;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
};

type BotConfig = {
  riskPercent: number;
  maxNotionalUsd: number;
  leverage: number;
  minScore: number;
  minConfidence: number;
};

type BotStatus = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'ERROR';

type BotEvent = {
  at: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
};

type PersistedData = {
  version: number;
  trades: TradeRecord[];
  logs: BotEvent[];
};

type Dependencies = {
  getCredentials: (req: Request) => Credentials;
  binanceRequest: BinanceRequest;
  calculateDemoOrder: (input: any) => Promise<DemoOrderPlan>;
  getSignals: () => Promise<Signal[]>;
  maxOrderUsd: number;
  maxLeverage: number;
};

// ── Constants ──────────────────────────────────────────────
const ENVIRONMENT = 'USD_M_FUTURES_DEMO';
const LOOP_MS = 5_000;
const SCAN_INTERVAL_MS = 30_000;
const SAME_SYMBOL_COOLDOWN_MS = 15 * 60_000;
const MIN_NOTIONAL_USD = 5;
const MAX_HISTORY = 2_000;
const MAX_LOGS = 500;

const JOURNAL_FILE =
  process.env.TURBOSCALP_BOT_JOURNAL_FILE ||
  path.resolve(process.cwd(), 'data', 'turboscalp-demo-journal.json');

const defaultConfig: BotConfig = {
  riskPercent: 0.5,
  maxNotionalUsd: 100,
  leverage: 1,
  minScore: 65,
  minConfidence: 78,
};

// ── State ──────────────────────────────────────────────────
const state: {
  status: BotStatus;
  message: string;
  config: BotConfig;
  activeTrade: TradeRecord | null;
  trades: TradeRecord[];
  logs: BotEvent[];
  lastScanAt: number | null;
  lastScanCount: number;
  lastCandidate: { symbol: string; direction: string; score: number } | null;
  updatedAt: number;
} = {
  status: 'STOPPED',
  message: 'Connect the Binance USD-M Futures Demo account, then start the bot.',
  config: { ...defaultConfig },
  activeTrade: null,
  trades: [],
  logs: [],
  lastScanAt: null,
  lastScanCount: 0,
  lastCandidate: null,
  updatedAt: Date.now(),
};

// ── Module-level ───────────────────────────────────────────
let loaded = false;
let journalHealthy = true;
let loadPromise: Promise<void> | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let loop: ReturnType<typeof setInterval> | null = null;
let loopBusy = false;
let startRequestBusy = false;
let activeCredentials: Credentials | null = null;
let deps: Dependencies | null = null;
const cooldowns = new Map<string, number>();

// ── Helpers ────────────────────────────────────────────────
const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(JOURNAL_FILE, 'utf8');
        const parsed = JSON.parse(raw) as PersistedData;
        state.trades = Array.isArray(parsed.trades)
          ? parsed.trades.slice(-MAX_HISTORY)
          : [];
        state.logs = Array.isArray(parsed.logs)
          ? parsed.logs.slice(-MAX_LOGS)
          : [];
        const openTrades = state.trades.filter(t => t.status === 'OPEN');
        if (openTrades.length > 1) {
          journalHealthy = false;
          state.status = 'ERROR';
          state.message =
            'Journal has multiple open trades. New entries disabled until reconciled.';
        }
        state.activeTrade = openTrades[0] || null;
        for (const trade of state.trades) {
          if (
            trade.status === 'CLOSED' &&
            trade.closedAt &&
            Date.now() - trade.closedAt < SAME_SYMBOL_COOLDOWN_MS
          ) {
            cooldowns.set(trade.symbol, trade.closedAt + SAME_SYMBOL_COOLDOWN_MS);
          }
        }
        if (state.activeTrade) {
          state.message =
            'A previous open Demo position was restored. Press START after reconciling.';
          addLog(
            'WARN',
            'Journal restored an open trade — bot is not auto-started.',
          );
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          journalHealthy = false;
          console.error('Journal read failed:', error);
          state.status = 'ERROR';
          state.message = 'Journal file could not be read. Trading disabled.';
        }
      }
      loaded = true;
      state.updatedAt = Date.now();
    })();
  }
  await loadPromise;
}

function persist(): Promise<void> {
  persistQueue = persistQueue
    .then(async () => {
      const data: PersistedData = {
        version: 1,
        trades: state.trades.slice(-MAX_HISTORY),
        logs: state.logs.slice(-MAX_LOGS),
      };
      const dir = path.dirname(JOURNAL_FILE);
      const tmp = `${JOURNAL_FILE}.${Date.now()}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmp, JOURNAL_FILE);
      } catch (error) {
        journalHealthy = false;
        console.error('Journal persist failed:', error);
        state.message = 'WARNING: journal could not be saved.';
        try {
          await fs.unlink(tmp);
        } catch {}
      }
    })
    .catch(err => console.error('Journal queue failed:', err));
  return persistQueue;
}

function addLog(level: BotEvent['level'], message: string): void {
  state.logs.push({ at: Date.now(), level, message });
  state.logs = state.logs.slice(-MAX_LOGS);
  state.updatedAt = Date.now();
  void persist();
}

function publicState() {
  const closed = state.trades.filter(
    t => t.status === 'CLOSED' && t.realizedPnl !== null,
  );
  const wins = closed.filter(t => (t.realizedPnl || 0) > 0).length;
  const losses = closed.filter(t => (t.realizedPnl || 0) < 0).length;
  const net = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  return {
    success: true,
    environment: ENVIRONMENT,
    liveTradingEnabled: false,
    status: state.status,
    message: state.message,
    config: state.config,
    activeTrade: state.activeTrade,
    trades: state.trades
      .slice()
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, 100),
    logs: state.logs
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, 100),
    stats: {
      closedTrades: closed.length,
      wins,
      losses,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      netRealizedPnl: net,
    },
    lastScanAt: state.lastScanAt,
    lastScanCount: state.lastScanCount,
    lastCandidate: state.lastCandidate,
    updatedAt: state.updatedAt,
  };
}

// ── Binance wrappers ───────────────────────────────────────
async function readExchangeSnapshot(symbol?: string): Promise<any[]> {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  const positions: any = await deps.binanceRequest(
    'GET',
    '/fapi/v3/positionRisk',
    symbol ? { symbol } : {},
    true,
    activeCredentials,
  );
  if (!Array.isArray(positions)) {
    throw new Error('Binance returned an invalid positionRisk response.');
  }
  return positions;
}

async function detectLegacyPositionMode(): Promise<'ONE_WAY' | 'HEDGE'> {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  const response: any = await deps.binanceRequest(
    'GET',
    '/fapi/v1/positionSide/dual',
    {},
    true,
    activeCredentials,
  );
  if (typeof response?.dualSidePosition !== 'boolean') {
    throw new Error('Unable to confirm Binance position mode. Entry blocked.');
  }
  return response.dualSidePosition ? 'HEDGE' : 'ONE_WAY';
}

function findLivePositionForTrade(positions: any[], trade: TradeRecord): any | null {
  const expectedHedgeSide =
    trade.positionSide && trade.positionSide !== 'BOTH'
      ? trade.positionSide
      : trade.side === 'BUY'
        ? 'LONG'
        : 'SHORT';

  return positions.find((position: any) => {
    if (position?.symbol !== trade.symbol) return false;
    const amount = num(position?.positionAmt);
    if (Math.abs(amount) <= 1e-12) return false;

    const exchangeSide = String(position?.positionSide || 'BOTH');
    if (exchangeSide === 'BOTH') {
      return trade.side === 'BUY' ? amount > 0 : amount < 0;
    }
    return exchangeSide === expectedHedgeSide;
  }) || null;
}

function syncTradePositionMode(trade: TradeRecord, position: any): void {
  const positionSide = String(position?.positionSide || 'BOTH');
  if (positionSide === 'BOTH') {
    trade.positionMode = 'ONE_WAY';
    trade.positionSide = 'BOTH';
  } else if (positionSide === 'LONG' || positionSide === 'SHORT') {
    trade.positionMode = 'HEDGE';
    trade.positionSide = positionSide;
  } else {
    throw new Error(`Unexpected Binance positionSide: ${positionSide}`);
  }
}

async function getPriceTick(symbol: string): Promise<number> {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  const info: any = await deps.binanceRequest(
    'GET',
    '/fapi/v1/exchangeInfo',
    {},
    false,
    activeCredentials,
  );
  const sym = info?.symbols?.find((s: any) => s.symbol === symbol);
  const filter = sym?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
  const tick = Number(filter?.tickSize);
  if (!Number.isFinite(tick) || tick <= 0) {
    throw new Error(`Could not read a valid PRICE_FILTER tickSize for ${symbol}.`);
  }
  return tick;
}

function roundTrigger(price: number, tick: number): string {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tick) || tick <= 0) {
    throw new Error('Invalid protective trigger price or tick size.');
  }
  const tickText = String(tick);
  const precision = tickText.includes('.')
    ? tickText.split('.')[1].replace(/0+$/, '').length
    : 0;
  const rounded = Math.round(price / tick) * tick;
  return rounded.toFixed(precision);
}

async function getOpenAlgoOrders(symbol: string): Promise<any[]> {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  return fetchOpenAlgoOrdersSafe(
    deps.binanceRequest as any,
    activeCredentials as any,
    symbol,
  );
}

async function placeAlgoProtection(
  trade: TradeRecord,
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
  clientAlgoId: string,
): Promise<any> {
  if (!deps || !activeCredentials) throw new Error('No credentials');

  const positionMode = trade.positionMode || 'ONE_WAY';
  const positionSide =
    positionMode === 'HEDGE'
      ? (trade.positionSide && trade.positionSide !== 'BOTH'
          ? trade.positionSide
          : trade.side === 'BUY' ? 'LONG' : 'SHORT')
      : 'BOTH';
  const trigger = type === 'STOP_MARKET' ? trade.stopPrice : trade.targetPrice;
  const tick = await getPriceTick(trade.symbol);

  const params = buildProtectiveAlgoParams({
    symbol: trade.symbol,
    entrySide: trade.side,
    positionMode,
    positionSide,
    type,
    triggerPrice: roundTrigger(trigger, tick),
    clientAlgoId,
  });

  // closePosition=true: no quantity, reduceOnly or timeInForce.
  return deps.binanceRequest(
    'POST',
    '/fapi/v1/algoOrder',
    params,
    true,
    activeCredentials,
  );
}

async function cancelTradeAlgoOrders(trade: TradeRecord): Promise<void> {
  if (!deps || !activeCredentials) {
    throw new Error('Credentials unavailable; cannot verify Algo order cleanup.');
  }

  const sameAlgoId = (
    expected: number | string | null,
    actual: any,
  ): boolean =>
    expected !== null &&
    expected !== undefined &&
    actual !== null &&
    actual !== undefined &&
    String(expected) === String(actual);

  const belongsToTrade = (order: any): boolean =>
    (!!trade.stopClientAlgoId &&
      order?.clientAlgoId === trade.stopClientAlgoId) ||
    (!!trade.targetClientAlgoId &&
      order?.clientAlgoId === trade.targetClientAlgoId) ||
    sameAlgoId(trade.stopAlgoId, order?.algoId) ||
    sameAlgoId(trade.targetAlgoId, order?.algoId);

  // First obtain a valid exchange snapshot. Never treat an API failure
  // as proof that no protective orders exist.
  const before = await getOpenAlgoOrders(trade.symbol);
  const ownedOrders = before.filter(belongsToTrade);

  for (const order of ownedOrders) {
    const isStop =
      (!!trade.stopClientAlgoId &&
        order?.clientAlgoId === trade.stopClientAlgoId) ||
      sameAlgoId(trade.stopAlgoId, order?.algoId);

    const fallbackClientId = isStop
      ? trade.stopClientAlgoId
      : trade.targetClientAlgoId;

    const fallbackAlgoId = isStop
      ? trade.stopAlgoId
      : trade.targetAlgoId;

    const algoId = order?.algoId ?? fallbackAlgoId;
    const clientAlgoId = String(
      order?.clientAlgoId || fallbackClientId || '',
    );

    const cancelled = await cancelAlgoOrderSafe(
      deps.binanceRequest as any,
      activeCredentials as any,
      trade.symbol,
      algoId,
      clientAlgoId || undefined,
    );

    if (!cancelled) {
      addLog(
        'WARN',
        `${trade.symbol} cancellation was not acknowledged for a bot-owned Algo order. Checking exchange state.`,
      );
    }
  }

  // A cancellation response is not enough. Verify that neither of
  // this trade's bot-owned protective orders remains open.
  const after = await getOpenAlgoOrders(trade.symbol);
  const remaining = after.filter(belongsToTrade);

  if (remaining.length > 0) {
    throw new Error(
      `Binance still reports ${remaining.length} bot-owned protective Algo order(s) open for ${trade.symbol}.`,
    );
  }
}

async function getRealizedNetPnl(symbol: string, sinceMs: number): Promise<number> {
  if (!deps || !activeCredentials) return 0;
  try {
    const trades: any[] = await deps.binanceRequest(
      'GET',
      '/fapi/v1/userTrades',
      { symbol, startTime: sinceMs, limit: 100 },
      true,
      activeCredentials,
    );
    if (!Array.isArray(trades)) return 0;
    return trades.reduce(
      (sum, trade) => sum + num(trade.realizedPnl) - num(trade.commission),
      0,
    );
  } catch {
    return 0;
  }
}

async function closeTradeJournal(
  trade: TradeRecord,
  reason: string,
): Promise<void> {
  if (!deps || !activeCredentials) return;

  // Only cancel Algo orders whose IDs belong to this bot trade.
  await cancelTradeAlgoOrders(trade);

  const realized = await getRealizedNetPnl(trade.symbol, trade.openedAt);
  trade.status = 'CLOSED';
  trade.closedAt = Date.now();
  trade.closeReason = reason;
  trade.realizedPnl = realized;
  trade.unrealizedPnl = 0;
  cooldowns.set(trade.symbol, Date.now() + SAME_SYMBOL_COOLDOWN_MS);

  if (state.activeTrade?.id === trade.id) {
    state.activeTrade = null;
  }

  addLog(
    'TRADE',
    `${trade.symbol} closed (${reason}) - realized PnL $${realized.toFixed(2)}`,
  );

  if (state.status !== 'RUNNING') {
    state.message =
      `${trade.symbol} is confirmed flat on Binance Demo. Press START again only when ready to resume entries.`;
  }
  await persist();
}

async function ensureBothProtections(trade: TradeRecord): Promise<boolean> {
  if (!deps || !activeCredentials) return false;

  try {
    const open = await getOpenAlgoOrders(trade.symbol);
    const hasOrder = (
      orders: any[],
      clientId: string,
      algoId: number | string | null,
    ) => orders.some((order: any) =>
      (clientId && order?.clientAlgoId === clientId) ||
      (algoId !== null && algoId !== undefined &&
        String(order?.algoId) === String(algoId))
    );

    if (!hasOrder(open, trade.stopClientAlgoId, trade.stopAlgoId)) {
      const stop: any = await placeAlgoProtection(
        trade,
        'STOP_MARKET',
        trade.stopClientAlgoId,
      );
      trade.stopAlgoId = stop?.algoId ?? null;
    }

    if (!hasOrder(open, trade.targetClientAlgoId, trade.targetAlgoId)) {
      const target: any = await placeAlgoProtection(
        trade,
        'TAKE_PROFIT_MARKET',
        trade.targetClientAlgoId,
      );
      trade.targetAlgoId = target?.algoId ?? null;
    }

    // Do not trust POST acknowledgements alone. Verify both orders on Binance.
    const verified = await getOpenAlgoOrders(trade.symbol);
    const stopAlive = hasOrder(
      verified,
      trade.stopClientAlgoId,
      trade.stopAlgoId,
    );
    const targetAlive = hasOrder(
      verified,
      trade.targetClientAlgoId,
      trade.targetAlgoId,
    );

    if (!stopAlive || !targetAlive) {
      throw new Error(
        `Binance Algo verification failed (STOP=${stopAlive}, TAKE_PROFIT=${targetAlive}).`,
      );
    }

    const stopOrder = verified.find((o: any) =>
      o?.clientAlgoId === trade.stopClientAlgoId ||
      (trade.stopAlgoId && String(o?.algoId) === String(trade.stopAlgoId))
    );
    const targetOrder = verified.find((o: any) =>
      o?.clientAlgoId === trade.targetClientAlgoId ||
      (trade.targetAlgoId && String(o?.algoId) === String(trade.targetAlgoId))
    );
    if (stopOrder?.algoId !== undefined) trade.stopAlgoId = stopOrder.algoId;
    if (targetOrder?.algoId !== undefined) trade.targetAlgoId = targetOrder.algoId;

    delete trade.lastEmergencyAttemptAt;
    return true;
  } catch (error: any) {
    addLog(
      'ERROR',
      `${trade.symbol} protective orders are NOT verified: ${error?.message || error}`,
    );
    return false;
  }
}

async function emergencyCloseUnprotectedTrade(trade: TradeRecord): Promise<boolean> {
  if (!deps || !activeCredentials) return false;

  const now = Date.now();

  if (
    trade.lastEmergencyAttemptAt &&
    now - trade.lastEmergencyAttemptAt < 30_000
  ) {
    state.status = 'ERROR';
    state.message =
      `CRITICAL: emergency close for ${trade.symbol} is rate-limited while the result is uncertain. Check Binance Demo immediately.`;
    await persist();
    return false;
  }

  trade.lastEmergencyAttemptAt = now;
  await persist();

  try {
    // Read the current exchange position BEFORE doing anything to protection.
    const before = await readExchangeSnapshot(trade.symbol);
    const live = findLivePositionForTrade(before, trade);

    if (!live) {
      // The exchange is already flat. Cleanup is now safe, but it must
      // still be confirmed before the journal is marked CLOSED.
      await closeTradeJournal(
        trade,
        'PROTECTION_FAILURE_POSITION_ALREADY_FLAT',
      );

      state.status = 'PAUSED';
      state.message =
        `${trade.symbol} is confirmed flat on Binance Demo. New entries remain paused.`;
      await persist();
      return true;
    }

    syncTradePositionMode(trade, live);

    // Use the exact current exchange quantity, not the original journal quantity.
    const rawAmount = String(live.positionAmt ?? '0');
    const closeQuantity = rawAmount.startsWith('-')
      ? rawAmount.slice(1)
      : rawAmount.replace(/^\+/, '');

    if (!closeQuantity || num(closeQuantity) <= 0) {
      throw new Error('Binance returned an invalid live position quantity.');
    }

    const closeParams: Record<string, any> = {
      symbol: trade.symbol,
      side: trade.side === 'BUY' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: closeQuantity,
      newClientOrderId: `ts-emergency-${newId()}`,
      newOrderRespType: 'RESULT',
    };

    if (trade.positionMode === 'HEDGE') {
      // Hedge Mode uses the matching position side and omits reduceOnly.
      closeParams.positionSide = trade.positionSide;
    } else {
      // One-Way Mode uses reduceOnly to prevent position reversal.
      closeParams.reduceOnly = 'true';
    }

    let submitError: any = null;

    try {
      await deps.binanceRequest(
        'POST',
        '/fapi/v1/order',
        closeParams,
        true,
        activeCredentials,
      );
    } catch (error: any) {
      // The request may have reached Binance even if the response failed.
      // Inspect the exchange position; do not blindly submit another order.
      submitError = error;
      addLog(
        'WARN',
        `${trade.symbol} emergency-close response was uncertain. Checking the exchange position before any retry.`,
      );
    }

    // Keep existing protective Algo orders in place until flat is confirmed.
    const after = await readExchangeSnapshot(trade.symbol);
    const stillOpen = findLivePositionForTrade(after, trade);

    if (!stillOpen) {
      // Position is confirmed flat. Now cancel and verify only our own orders.
      await closeTradeJournal(
        trade,
        'PROTECTION_FAILURE_EMERGENCY_CLOSED',
      );

      state.status = 'PAUSED';
      state.message =
        `${trade.symbol} emergency close was verified flat on Binance Demo. Remaining bot-owned protective orders were checked. New entries remain paused.`;
      addLog('WARN', `${trade.symbol} emergency close verified flat.`);
      await persist();
      return true;
    }

    state.status = 'ERROR';
    state.message =
      `CRITICAL: ${trade.symbol} remains open after the emergency-close attempt. Existing bot protective orders were not cancelled before the attempt. Verify exchange-side protection and the position on Binance Demo immediately. Automatic entries are blocked.${submitError ? ` Binance response: ${submitError?.message || submitError}` : ''}`;

    addLog('ERROR', state.message);
    await persist();
    return false;
  } catch (error: any) {
    state.status = 'ERROR';
    state.message =
      `CRITICAL: ${trade.symbol} emergency close or post-close cleanup could not be fully verified. This recovery path did not cancel protective orders before attempting the close. Check Binance Demo immediately; automatic entries are blocked.`;

    addLog(
      'ERROR',
      `${state.message} Details: ${error?.message || error}`,
    );
    await persist();
    return false;
  }
}

function qualifyingSignal(
  signals: Signal[],
  config: BotConfig,
): Signal | null {
  const now = Date.now();
  const candidates = signals.filter(
    s =>
      s.direction !== 'NEUTRAL' &&
      s.stopLoss &&
      s.takeProfit &&
      s.score >= config.minScore &&
      s.confidence >= config.minConfidence &&
      (!cooldowns.get(s.symbol) || now > (cooldowns.get(s.symbol) || 0)),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score * b.confidence - a.score * a.confidence);
  return candidates[0];
}

// ── Trade opening ──────────────────────────────────────────
async function openDemoTrade(signal: Signal, config: BotConfig) {
  if (!deps || !activeCredentials) throw new Error('No credentials');

  const plan = await deps.calculateDemoOrder({
    symbol: signal.symbol,
    direction: signal.direction,
    price: signal.price,
    riskPercent: config.riskPercent,
    leverage: config.leverage,
    maxNotionalUsd: Math.min(config.maxNotionalUsd, deps.maxOrderUsd),
  });

  if (!plan || num(plan.notionalUsd) < MIN_NOTIONAL_USD) {
    addLog('WARN', `${signal.symbol} plan too small - skipped`);
    return;
  }

  const stopPrice = num(signal.stopLoss);
  const targetPrice = num(signal.takeProfit);
  if (stopPrice <= 0 || targetPrice <= 0) {
    addLog('WARN', `${signal.symbol} has invalid SL/TP prices - entry skipped`);
    return;
  }

  if (
    (plan.side === 'BUY' && !(stopPrice < signal.price && targetPrice > signal.price)) ||
    (plan.side === 'SELL' && !(stopPrice > signal.price && targetPrice < signal.price))
  ) {
    addLog('WARN', `${signal.symbol} SL/TP geometry is invalid for ${plan.side} - entry skipped`);
    return;
  }

  // Do not guess One-Way mode if Binance cannot confirm the account setting.
  const positionMode = await detectLegacyPositionMode();
  const positionSide: 'BOTH' | 'LONG' | 'SHORT' =
    positionMode === 'HEDGE'
      ? plan.side === 'BUY' ? 'LONG' : 'SHORT'
      : 'BOTH';

  // Leverage must be confirmed before submitting the entry.
  await deps.binanceRequest(
    'POST',
    '/fapi/v1/leverage',
    { symbol: plan.symbol, leverage: plan.leverage },
    true,
    activeCredentials,
  );

  const entryClientOrderId = `ts-entry-${newId()}`;
  const entryParams: Record<string, any> = {
    symbol: plan.symbol,
    side: plan.side,
    type: 'MARKET',
    quantity: plan.quantity,
    newClientOrderId: entryClientOrderId,
    newOrderRespType: 'RESULT',
  };
  if (positionMode === 'HEDGE') {
    entryParams.positionSide = positionSide;
  }

  let order: any;
  try {
    order = await deps.binanceRequest(
      'POST',
      '/fapi/v1/order',
      entryParams,
      true,
      activeCredentials,
    );
  } catch (submitError: any) {
    // Resolve an ambiguous POST by client order ID. Never blindly submit a second entry.
    try {
      order = await deps.binanceRequest(
        'GET',
        '/fapi/v1/order',
        { symbol: plan.symbol, origClientOrderId: entryClientOrderId },
        true,
        activeCredentials,
      );
      addLog('WARN', `${plan.symbol} entry response recovered by client order ID.`);
    } catch {
      state.status = 'ERROR';
      state.message =
        `Entry result for ${plan.symbol} is uncertain. Do not restart the bot until the Binance Demo position and order are checked manually.`;
      addLog('ERROR', `${state.message} Original error: ${submitError?.message || submitError}`);
      throw new Error(state.message);
    }
  }

  const executedQty = num(order?.executedQty);
  if (executedQty <= 0) {
    state.status = 'ERROR';
    state.message =
      `Binance did not confirm an executed quantity for ${plan.symbol}. Check Demo orders/positions before restarting.`;
    addLog('ERROR', state.message);
    throw new Error(state.message);
  }

  const entryPrice = num(order?.avgPrice) || num(signal.price);
  const actualQuantity = String(order.executedQty);
  const trade: TradeRecord = {
    id: newId(),
    symbol: plan.symbol,
    side: plan.side,
    positionMode,
    positionSide,
    status: 'OPEN',
    notionalUsd: executedQty * entryPrice,
    quantity: actualQuantity,
    leverage: plan.leverage,
    entryPrice,
    markPrice: entryPrice,
    stopPrice,
    targetPrice,
    unrealizedPnl: 0,
    realizedPnl: null,
    entryOrderId: order?.orderId ?? null,
    entryClientOrderId,
    stopAlgoId: null,
    stopClientAlgoId: `ts-stop-${newId()}`,
    targetAlgoId: null,
    targetClientAlgoId: `ts-tp-${newId()}`,
    openedAt: Date.now(),
    closedAt: null,
    closeReason: null,
  };

  // Persist the actual exchange fill BEFORE attempting conditional protection.
  state.activeTrade = trade;
  state.trades.push(trade);
  addLog(
    'WARN',
    `${trade.symbol} entry filled; verifying exchange-side STOP and TAKE_PROFIT protection.`,
  );
  await persist();

  const protectedOnExchange = await ensureBothProtections(trade);
  if (!protectedOnExchange) {
    state.status = 'PAUSED';
    state.message =
      `${trade.symbol} protection could not be verified. New entries are paused and an emergency close is being attempted.`;
    addLog('ERROR', state.message);
    await emergencyCloseUnprotectedTrade(trade);
    await persist();
    return;
  }

  addLog(
    'TRADE',
    `OPENED ${trade.side} ${trade.symbol} qty=${trade.quantity} entry=${entryPrice} SL=${stopPrice} TP=${targetPrice} - BOTH PROTECTIONS VERIFIED`,
  );
  await persist();
}
// ── Main cycle ─────────────────────────────────────────────
async function runCycle() {
  if (loopBusy || !deps) return;
  loopBusy = true;

  try {
    await ensureLoaded();
    if (!activeCredentials) return;

    // Existing positions are ALWAYS reconciled, even when entries are paused or stopped.
    if (state.activeTrade) {
      const trade = state.activeTrade;
      const positions = await readExchangeSnapshot(trade.symbol);
      const live = findLivePositionForTrade(positions, trade);

      if (!live) {
        await closeTradeJournal(trade, 'CLOSED_ON_EXCHANGE');
        return;
      }

      syncTradePositionMode(trade, live);
      trade.markPrice = num(live.markPrice);
      trade.unrealizedPnl = num(live.unRealizedProfit);

      const protectedOnExchange = await ensureBothProtections(trade);
      if (!protectedOnExchange) {
        state.status = 'PAUSED';
        state.message =
          `${trade.symbol} has an open position without verified protective exits. New entries are paused.`;
        await emergencyCloseUnprotectedTrade(trade);
      }

      await persist();
      return;
    }

    // No tracked trade: never enter while ANY untracked exchange position is open.
    if (state.status !== 'RUNNING' || !journalHealthy) return;

    const now = Date.now();
    if (state.lastScanAt && now - state.lastScanAt < SCAN_INTERVAL_MS) return;

    const exchangePositions = await readExchangeSnapshot();
    const externalPosition = exchangePositions.find(
      (position: any) => Math.abs(num(position?.positionAmt)) > 1e-12,
    );
    if (externalPosition) {
      state.status = 'PAUSED';
      state.message =
        `Untracked Binance Demo position detected (${externalPosition.symbol}). New entries are blocked; reconcile it first.`;
      addLog('WARN', state.message);
      stopLoop();
      return;
    }

    const signals = await deps.getSignals();
    state.lastScanAt = now;
    state.lastScanCount = signals.length;

    const best = qualifyingSignal(signals, state.config);
    if (!best) {
      state.lastCandidate = null;
      return;
    }

    state.lastCandidate = {
      symbol: best.symbol,
      direction: best.direction,
      score: best.score,
    };
    addLog(
      'INFO',
      `Signal: ${best.symbol} ${best.direction} score=${best.score} conf=${best.confidence}`,
    );
    await openDemoTrade(best, state.config);
  } catch (err: any) {
    console.error('runCycle error:', err);
    addLog('ERROR', `Cycle error: ${err?.message ?? err}`);
  } finally {
    loopBusy = false;
    state.updatedAt = Date.now();

    // Once an existing trade is flat, stop the monitor timer unless entries are RUNNING.
    if (!state.activeTrade && state.status !== 'RUNNING') {
      stopLoop();
    }
  }
}
function startLoop() {
  if (loop) return;
  loop = setInterval(() => {
    void runCycle();
  }, LOOP_MS);
}

function stopLoop() {
  if (loop) {
    clearInterval(loop);
    loop = null;
  }
}

// ── Lifecycle exports (for server.ts shutdown hooks) ───────
// Every plausible name is exported so ESM import resolution succeeds
// regardless of how server.ts spells it (singular vs plural, pause vs stop).

function _pauseInternal(): void {
  if (state.status === 'RUNNING') {
    state.status = 'PAUSED';
    state.message = 'Paused by server lifecycle; existing positions remain monitored.';
  }
  if (state.activeTrade && activeCredentials) startLoop();
  else stopLoop();
  addLog('INFO', 'pause invoked via lifecycle hook.');
}

function _stopInternal(): void {
  stopLoop();
  state.status = 'STOPPED';
  state.message = 'Stopped by server lifecycle.';
  addLog('INFO', 'stop invoked via lifecycle hook.');
}

// Pause aliases
export const pauseAllAutonomousDemoBots = (..._args: any[]) => _pauseInternal();
export const pauseAllAutonomousDemoBot  = (..._args: any[]) => _pauseInternal();
export const pauseAutonomousDemoBots    = (..._args: any[]) => _pauseInternal();
export const pauseAutonomousDemoBot     = (..._args: any[]) => _pauseInternal();

// Stop aliases
export const stopAllAutonomousDemoBots  = (..._args: any[]) => _stopInternal();
export const stopAllAutonomousDemoBot   = (..._args: any[]) => _stopInternal();
export const stopAutonomousDemoBots     = (..._args: any[]) => _stopInternal();
export const stopAutonomousDemoBot      = (..._args: any[]) => _stopInternal();

// Shutdown aliases  ← server.ts line 29 needs this one
export const shutdownAutonomousDemoBot      = (..._args: any[]) => _stopInternal();
export const shutdownAutonomousDemoBots     = (..._args: any[]) => _stopInternal();
export const shutdownAllAutonomousDemoBot   = (..._args: any[]) => _stopInternal();
export const shutdownAllAutonomousDemoBots  = (..._args: any[]) => _stopInternal();

// Read-only state accessors
export function getAutonomousDemoBotState()   { return publicState(); }
export function getAutonomousDemoBotStatus()  { return publicState(); }
export function getAutonomousDemoBotSnapshot() { return publicState(); }

// Programmatic start
export async function resumeAutonomousDemoBot(
  credentials: Credentials,
): Promise<void> {
  await ensureLoaded();
  if (!deps) throw new Error('Bot routes not registered yet.');
  activeCredentials = credentials;

  if (state.activeTrade) {
    state.status = 'PAUSED';
    state.message =
      'Existing journal trade detected. Programmatic resume is monitor-only until Binance confirms the position is flat.';
    addLog('WARN', 'Programmatic resume blocked new entries because an OPEN trade exists.');
    startLoop();
    await runCycle();
    await persist();
    return;
  }

  state.status = 'RUNNING';
  state.message = 'Resumed programmatically.';
  addLog('INFO', 'resumeAutonomousDemoBot invoked.');
  startLoop();
  await persist();
}

export const resumeAllAutonomousDemoBots = resumeAutonomousDemoBot;
export const startAutonomousDemoBot      = resumeAutonomousDemoBot;
export const startAllAutonomousDemoBots  = resumeAutonomousDemoBot;

// ── Route registration ─────────────────────────────────────
export function registerAutonomousDemoBotRoutes(
  app: Express,
  dependencies: Dependencies,
) {
  deps = dependencies;

  app.get('/api/autonomous-demo-bot/status', async (_req, res) => {
    await ensureLoaded();
    res.json(publicState());
  });

  app.post('/api/autonomous-demo-bot/start', async (req, res) => {
    if (startRequestBusy) {
      return res.status(409).json({ success: false, error: 'Start in progress' });
    }
    startRequestBusy = true;
    try {
      await ensureLoaded();
      if (!journalHealthy) {
        state.status = 'ERROR';
        state.message = 'Legacy trade journal is not healthy. New entries are disabled until it is repaired.';
        return res.status(409).json({ success: false, error: state.message });
      }

      const creds = deps!.getCredentials(req);
      if (!creds.apiKey || !creds.apiSecret) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing demo API credentials' });
      }
      activeCredentials = creds;

      try {
        const diag = await runNonExecutingPermissionDiagnostic(
          deps!.binanceRequest,
          activeCredentials,
        );
        if (!diag.apiAuthenticated) {
          state.status = 'ERROR';
          state.message = `Demo account verification failed: ${diag.orderTestMessage}`;
          return res.status(401).json({
            success: false,
            error: diag.orderTestMessage || 'Demo credentials rejected by Binance',
          });
        }
        if (!diag.tradingConfirmed) {
          state.status = 'PAUSED';
          const reason = diag.classificationMessage || 'ACCOUNT TRADING DISABLED.';
          state.message = reason;
          addLog('WARN', `Start blocked: ${reason}`);
          return res.status(403).json({
            success: false,
            error: reason,
            diagnostics: diag,
          });
        }
      } catch (err: any) {
        state.status = 'ERROR';
        state.message = `Demo account verification failed: ${err?.message}`;
        return res.status(400).json({
          success: false,
          error: 'Demo credentials rejected by Binance',
          detail: err?.message,
        });
      }

      if (state.activeTrade) {
        state.status = 'PAUSED';
        state.message =
          'A saved OPEN trade exists. START will only reconcile/monitor it; no new entry will be opened until it is confirmed flat.';
        addLog('WARN', 'Start request entered monitor-only mode because a journal trade is still OPEN.');
        startLoop();
        await runCycle();
        await persist();
        return res.json({
          success: true,
          state: publicState(),
          monitorOnly: true,
        });
      }
      if (req.body && typeof req.body === 'object') {
        for (const key of Object.keys(defaultConfig) as (keyof BotConfig)[]) {
          if (Number.isFinite(Number(req.body[key]))) {
            state.config[key] = Number(req.body[key]);
          }
        }
      }
      state.config.leverage = Math.min(state.config.leverage, deps!.maxLeverage);
      state.config.maxNotionalUsd = Math.min(
        state.config.maxNotionalUsd,
        deps!.maxOrderUsd,
      );

      state.status = 'RUNNING';
      state.message = 'Autonomous Demo scalping active.';
      addLog('INFO', 'Bot started in DEMO mode.');
      startLoop();
      await persist();
      return res.json({ success: true, state: publicState() });
    } catch (err: any) {
      state.status = 'ERROR';
      state.message = err?.message ?? 'Failed to start';
      return res.status(500).json({ success: false, error: state.message });
    } finally {
      startRequestBusy = false;
    }
  });

    app.post('/api/autonomous-demo-bot/stop', async (_req, res) => {
    await ensureLoaded();
    state.status = 'STOPPED';
    state.message = state.activeTrade
      ? 'New entries stopped. The existing Binance Demo position remains under reconciliation monitoring.'
      : 'Bot stopped by user.';
    addLog('INFO', 'Bot stopped by user; existing position monitoring is preserved.');
    if (state.activeTrade && activeCredentials) startLoop();
    else stopLoop();
    await persist();
    res.json({ success: true, state: publicState() });
  });

    app.post('/api/autonomous-demo-bot/pause', async (_req, res) => {
    await ensureLoaded();
    state.status = 'PAUSED';
    state.message = state.activeTrade
      ? 'New entries paused. The existing Binance Demo position remains under reconciliation monitoring.'
      : 'Bot paused by user.';
    addLog('INFO', 'Bot paused; existing position monitoring is preserved.');
    if (state.activeTrade && activeCredentials) startLoop();
    else stopLoop();
    await persist();
    res.json({ success: true, state: publicState() });
  });

  addLog('INFO', 'Autonomous Demo Bot routes registered.');
}

// ── Re-exports (types) ─────────────────────────────────────
export type { BinanceRequest, Credentials, Dependencies, BotConfig };