import type { Express, Request, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type Credentials = { apiKey: string; apiSecret: string };
type BinanceRequest = (
  method: HttpMethod,
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>,
  signed?: boolean,
  credentials?: Credentials
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
  calculateDemoOrder: (input: any) => Promise<any>;
  getSignals: () => Promise<Signal[]>;
  maxOrderUsd: number;
  maxLeverage: number;
};

const ENVIRONMENT = 'USD_M_FUTURES_DEMO';
const LOOP_MS = 5_000;
const SCAN_INTERVAL_MS = 30_000;
const SAME_SYMBOL_COOLDOWN_MS = 15 * 60_000;
const MIN_NOTIONAL_USD = 5;
const MAX_HISTORY = 2_000;
const MAX_LOGS = 500;
const JOURNAL_FILE = process.env.TURBOSCALP_BOT_JOURNAL_FILE ||
  path.resolve(process.cwd(), 'data', 'turboscalp-demo-journal.json');

const defaultConfig: BotConfig = {
  riskPercent: 0.5,
  maxNotionalUsd: 100,
  leverage: 1,
  minScore: 65,
  minConfidence: 78,
};

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

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(JOURNAL_FILE, 'utf8');
        const parsed = JSON.parse(raw) as PersistedData;
        state.trades = Array.isArray(parsed.trades) ? parsed.trades.slice(-MAX_HISTORY) : [];
        state.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(-MAX_LOGS) : [];
        const openTrades = state.trades.filter(item => item.status === 'OPEN');
        if (openTrades.length > 1) {
          journalHealthy = false;
          state.status = 'ERROR';
          state.message = 'Journal contains multiple open bot trades. New entries are disabled until the journal and Binance positions are reconciled.';
        }
        state.activeTrade = openTrades[0] || null;
        for (const trade of state.trades) {
          if (trade.status === 'CLOSED' && trade.closedAt && Date.now() - trade.closedAt < SAME_SYMBOL_COOLDOWN_MS) {
            cooldowns.set(trade.symbol, trade.closedAt + SAME_SYMBOL_COOLDOWN_MS);
          }
        }
        if (state.activeTrade) {
          state.message = 'A previously opened Demo position needs exchange reconciliation. Press START / RESUME after reconnecting.';
          addLog('WARN', 'Server journal restored an open trade. The bot is not auto-started; exchange positions and protective orders must be reconciled first.');
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          journalHealthy = false;
          console.error('Unable to read TurboScalp Demo journal:', error);
          state.message = 'Journal file could not be read. Trading is disabled until the journal issue is fixed.';
          state.status = 'ERROR';
        }
      }
      loaded = true;
      state.updatedAt = Date.now();
    })();
  }
  await loadPromise;
}

function persist(): Promise<void> {
  persistQueue = persistQueue.then(async () => {
    const data: PersistedData = {
      version: 1,
      trades: state.trades.slice(-MAX_HISTORY),
      logs: state.logs.slice(-MAX_LOGS),
    };
    const directory = path.dirname(JOURNAL_FILE);
    const temporary = `${JOURNAL_FILE}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(temporary, JOURNAL_FILE);
    } catch (error) {
      journalHealthy = false;
      console.error('TurboScalp Demo journal persistence failed:', error);
      state.message = 'WARNING: trade journal could not be saved. New entries are disabled until storage is healthy.';
      try { await fs.unlink(temporary); } catch { /* temp file may not exist */ }
    }
  }).catch(error => {
    console.error('TurboScalp Demo journal queue failed:', error);
  });
  return persistQueue;
}

function addLog(level: BotEvent['level'], message: string): void {
  state.logs.push({ at: Date.now(), level, message });
  state.logs = state.logs.slice(-MAX_LOGS);
  state.updatedAt = Date.now();
  void persist();
}

function publicState() {
  const closed = state.trades.filter(item => item.status === 'CLOSED' && item.realizedPnl !== null);
  const wins = closed.filter(item => (item.realizedPnl || 0) > 0).length;
  const losses = closed.filter(item => (item.realizedPnl || 0) < 0).length;
  const net = closed.reduce((sum, item) => sum + (item.realizedPnl || 0), 0);
  return {
    success: true,
    environment: ENVIRONMENT,
    liveTradingEnabled: false,
    status: state.status,
    message: state.message,
    config: state.config,
    activeTrade: state.activeTrade,
    trades: state.trades.slice().sort((a, b) => b.openedAt - a.openedAt).slice(0, 100),
    logs: state.logs.slice().sort((a, b) => b.at - a.at).slice(0, 100),
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

function startLoop(): void {
  if (loop) clearInterval(loop);
  loop = setInterval(() => { void runCycle(); }, LOOP_MS);
  void runCycle();
}

function stopLoop(): void {
  if (loop) clearInterval(loop);
  loop = null;
}

async function readExchangeSnapshot(credentials: Credentials, symbol?: string, includeAccount = true) {
  if (!deps) throw new Error('Bot dependencies are not registered.');
  const orderParams = symbol ? { symbol } : {};
  const [account, positions, orders, algoOrders] = await Promise.all([
    includeAccount
      ? deps.binanceRequest('GET', '/fapi/v3/account', {}, true, credentials)
      : Promise.resolve(null),
    deps.binanceRequest('GET', '/fapi/v3/positionRisk', {}, true, credentials),
    deps.binanceRequest('GET', '/fapi/v1/openOrders', orderParams, true, credentials),
    // Binance's current read endpoint for conditional TP/SL orders is openAlgoOrders.
    deps.binanceRequest('GET', '/fapi/v1/openAlgoOrders', orderParams, true, credentials),
  ]);
  return {
    account,
    positions: (Array.isArray(positions) ? positions : []).filter(item => Math.abs(num(item.positionAmt)) > 0),
    orders: Array.isArray(orders) ? orders : [],
    algoOrders: Array.isArray(algoOrders) ? algoOrders : [],
  };
}

function roundTrigger(price: number, tickSizeRaw: unknown, mode: 'floor' | 'ceil'): string {
  const tickSize = num(tickSizeRaw);
  if (!(tickSize > 0) || !(price > 0)) throw new Error('Invalid Binance price tick size.');
  const units = price / tickSize;
  const rounded = (mode === 'floor' ? Math.floor(units + 1e-10) : Math.ceil(units - 1e-10)) * tickSize;
  const decimals = (String(tickSizeRaw).split('.')[1] || '').replace(/0+$/, '').length;
  return rounded.toFixed(decimals);
}

async function getPriceTick(symbol: string): Promise<string> {
  if (!deps) throw new Error('Bot dependencies are not registered.');
  const info = await deps.binanceRequest('GET', '/fapi/v1/exchangeInfo', { symbol });
  const market = info?.symbols?.find((item: any) => item.symbol === symbol);
  const filter = market?.filters?.find((item: any) => item.filterType === 'PRICE_FILTER');
  if (!market || !filter?.tickSize) throw new Error(`Could not read ${symbol} price precision from Binance.`);
  return String(filter.tickSize);
}

async function placeAlgoProtection(
  credentials: Credentials,
  trade: TradeRecord,
  kind: 'SL' | 'TP',
  tickSize: string
): Promise<{ algoId: number | string | null; clientAlgoId: string }> {
  if (!deps) throw new Error('Bot dependencies are not registered.');
  const isLong = trade.side === 'BUY';
  const closeSide = isLong ? 'SELL' : 'BUY';
  const rawTrigger = kind === 'SL' ? trade.stopPrice : trade.targetPrice;
  const rounding = kind === 'SL'
    ? (isLong ? 'floor' : 'ceil')
    : (isLong ? 'ceil' : 'floor');
  const triggerPrice = roundTrigger(rawTrigger, tickSize, rounding);
  const clientAlgoId = `TSBOT${kind}${trade.id.slice(-13)}`;
  const result = await deps.binanceRequest('POST', '/fapi/v1/algoOrder', {
    algoType: 'CONDITIONAL',
    symbol: trade.symbol,
    side: closeSide,
    type: kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
    triggerPrice,
    closePosition: 'true',
    workingType: 'MARK_PRICE',
    // Keep Binance's default price-protection gate off so an abnormal mark/contract
    // price divergence does not suppress a protective stop trigger.
    priceProtect: 'false',
    clientAlgoId,
  }, true, credentials);
  return { algoId: result?.algoId ?? null, clientAlgoId };
}

async function cancelOurAlgoOrders(credentials: Credentials, trade: TradeRecord, algoOrders: any[]): Promise<void> {
  if (!deps) return;
  const clientIds = new Set([trade.stopClientAlgoId, trade.targetClientAlgoId].filter(Boolean));
  const algoIds = new Set([trade.stopAlgoId, trade.targetAlgoId].filter(value => value !== null && value !== undefined).map(String));
  for (const order of algoOrders) {
    const clientId = String(order.clientAlgoId || '');
    const algoId = String(order.algoId ?? '');
    if (order.symbol !== trade.symbol || (!clientIds.has(clientId) && !algoIds.has(algoId))) continue;
    try {
      const cancelParams: Record<string, string | number | boolean | undefined> = {
        symbol: trade.symbol,
      };
      if (order.algoId !== undefined && order.algoId !== null) {
        cancelParams.algoId = order.algoId;
      } else {
        cancelParams.clientAlgoId = clientId;
      }
      await deps.binanceRequest('DELETE', '/fapi/v1/algoOrder', cancelParams, true, credentials);
    } catch (error) {
      addLog('WARN', `Could not cancel leftover ${trade.symbol} protection order ${clientId}: ${error instanceof Error ? error.message : 'Binance error'}`);
    }
  }
}

async function getRealizedNetPnl(credentials: Credentials, trade: TradeRecord): Promise<number | null> {
  if (!deps) return null;
  try {
    const income = await deps.binanceRequest('GET', '/fapi/v1/income', {
      symbol: trade.symbol,
      startTime: trade.openedAt - 2_000,
      endTime: Date.now(),
      limit: 1000,
    }, true, credentials);
    if (!Array.isArray(income)) return null;
    const allowed = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);
    const relevant = income.filter((item: any) =>
      allowed.has(String(item.incomeType)) &&
      (!item.asset || item.asset === 'USDT') &&
      num(item.time) >= trade.openedAt - 2_000
    );
    if (!relevant.length) return null;
    return relevant.reduce((sum: number, item: any) => sum + num(item.income), 0);
  } catch (error) {
    addLog('WARN', `Exchange P&L could not be reconciled for ${trade.symbol}: ${error instanceof Error ? error.message : 'Binance error'}`);
    return null;
  }
}

async function closeTradeJournal(credentials: Credentials, trade: TradeRecord, algoOrders: any[]): Promise<void> {
  await cancelOurAlgoOrders(credentials, trade, algoOrders);
  const pnl = await getRealizedNetPnl(credentials, trade);
  const index = state.trades.findIndex(item => item.id === trade.id);
  if (index >= 0) {
    state.trades[index] = {
      ...state.trades[index],
      status: 'CLOSED',
      closedAt: Date.now(),
      closeReason: 'Position closed on Binance Demo; SL/TP or manual exchange close.',
      realizedPnl: pnl,
      unrealizedPnl: 0,
    };
  }
  state.activeTrade = null;
  cooldowns.set(trade.symbol, Date.now() + SAME_SYMBOL_COOLDOWN_MS);
  state.message = pnl === null
    ? `${trade.symbol} is closed on Binance Demo. Realized P&L is not yet available from the exchange income history.`
    : `${trade.symbol} closed on Binance Demo. Net realized P&L: ${pnl.toFixed(4)} USDT.`;
  addLog('TRADE', `${trade.symbol} position no longer exists on Binance Demo. Remaining bot protection orders were reconciled and the journal was closed.`);
  await persist();
}

async function ensureBothProtections(credentials: Credentials, trade: TradeRecord, algoOrders: any[]): Promise<boolean> {
  if (!deps) return false;
  const openClientIds = new Set(algoOrders.map(order => String(order.clientAlgoId || '')));
  const openAlgoIds = new Set(algoOrders.map(order => String(order.algoId ?? '')));
  const stopExists = openClientIds.has(trade.stopClientAlgoId) || (trade.stopAlgoId !== null && openAlgoIds.has(String(trade.stopAlgoId)));
  const targetExists = openClientIds.has(trade.targetClientAlgoId) || (trade.targetAlgoId !== null && openAlgoIds.has(String(trade.targetAlgoId)));
  if (stopExists && targetExists) return true;
  try {
    const tickSize = await getPriceTick(trade.symbol);
    if (!stopExists) {
      const placed = await placeAlgoProtection(credentials, trade, 'SL', tickSize);
      trade.stopAlgoId = placed.algoId;
      trade.stopClientAlgoId = placed.clientAlgoId;
      addLog('WARN', `${trade.symbol} stop-loss protection was missing and has been recreated on Binance Demo.`);
    }
    if (!targetExists) {
      const placed = await placeAlgoProtection(credentials, trade, 'TP', tickSize);
      trade.targetAlgoId = placed.algoId;
      trade.targetClientAlgoId = placed.clientAlgoId;
      addLog('WARN', `${trade.symbol} take-profit protection was missing and has been recreated on Binance Demo.`);
    }
    const index = state.trades.findIndex(item => item.id === trade.id);
    if (index >= 0) state.trades[index] = { ...trade };
    state.activeTrade = { ...trade };
    await persist();
    return true;
  } catch (error) {
    addLog('ERROR', `${trade.symbol} protection repair failed. Attempting an emergency reduce-only close: ${error instanceof Error ? error.message : 'Binance error'}`);
    try {
      // Keep any protection that is already active while attempting the
      // emergency close. If the market close fails, an existing stop/target
      // can still protect the exchange position. Leftovers are cancelled
      // after the position is confirmed flat by the next reconciliation.
      await deps.binanceRequest('POST', '/fapi/v1/order', {
        symbol: trade.symbol,
        side: trade.side === 'BUY' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: trade.quantity,
        reduceOnly: 'true',
        newClientOrderId: `TSBOTEM${Date.now()}`,
        newOrderRespType: 'RESULT',
      }, true, credentials);
      state.status = 'PAUSED';
      state.message = `Protection could not be repaired for ${trade.symbol}; emergency reduce-only close sent. New entries are paused.`;
      addLog('ERROR', state.message);
    } catch (closeError) {
      state.status = 'ERROR';
      state.message = `CRITICAL: ${trade.symbol} is open and protection repair plus emergency close failed. Check Binance Demo immediately. ${closeError instanceof Error ? closeError.message : ''}`;
      addLog('ERROR', state.message);
    }
    await persist();
    return false;
  }
}

function qualifyingSignal(signals: Signal[], config: BotConfig): Signal | null {
  const now = Date.now();
  const ranked = signals
    .filter(signal => {
      if (!signal || !/^[A-Z0-9]{2,30}USDT$/.test(signal.symbol)) return false;
      if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return false;
      if (Math.abs(num(signal.score)) < config.minScore) return false;
      if (num(signal.confidence) < config.minConfidence) return false;
      if (num(signal.quoteVolume) < 250_000) return false;
      if (num(signal.volatilityPct) < 0.05 || num(signal.volatilityPct) > 2.5) return false;
      if (!(num(signal.price) > 0) || !(num(signal.stopLoss) > 0) || !(num(signal.takeProfit) > 0)) return false;
      if ((cooldowns.get(signal.symbol) || 0) > now) return false;
      const long = signal.direction === 'BUY';
      if (long && !(num(signal.stopLoss) < num(signal.price) && num(signal.takeProfit) > num(signal.price))) return false;
      if (!long && !(num(signal.takeProfit) < num(signal.price) && num(signal.stopLoss) > num(signal.price))) return false;
      const risk = Math.abs(num(signal.price) - num(signal.stopLoss));
      const reward = Math.abs(num(signal.takeProfit) - num(signal.price));
      return risk > 0 && reward / risk >= 1.5;
    })
    .sort((a, b) => Math.abs(num(b.score)) - Math.abs(num(a.score)));
  return ranked[0] || null;
}

async function openDemoTrade(credentials: Credentials, signal: Signal, availableBalance: number): Promise<void> {
  if (!deps) return;
  const riskFraction = Math.abs(num(signal.price) - num(signal.stopLoss)) / num(signal.price);
  if (!(riskFraction > 0) || riskFraction > 0.05) {
    state.message = `Skipped ${signal.symbol}: stop distance is outside the permitted range.`;
    return;
  }
  const riskBudget = availableBalance * (state.config.riskPercent / 100);
  const riskSizedNotional = riskBudget / riskFraction;
  const capitalCap = availableBalance * 0.05 * state.config.leverage;
  const notionalUsd = Math.min(
    state.config.maxNotionalUsd,
    deps.maxOrderUsd,
    riskSizedNotional,
    capitalCap
  );
  if (!(notionalUsd >= MIN_NOTIONAL_USD)) {
    state.message = `Available Demo balance is too low for the minimum ${MIN_NOTIONAL_USD} USDT order under current risk limits.`;
    return;
  }

  const side = signal.direction as 'BUY' | 'SELL';
  const plan = await deps.calculateDemoOrder({
    symbol: signal.symbol,
    side,
    quantityUsd: notionalUsd,
    leverage: state.config.leverage,
  });
  const entry = num(plan.price);
  const stop = num(signal.stopLoss);
  const target = num(signal.takeProfit);
  const correctlyPlaced = side === 'BUY'
    ? stop < entry && target > entry
    : target < entry && stop > entry;
  if (!correctlyPlaced) {
    state.message = `Skipped ${signal.symbol}: the fresh Binance entry quote moved outside the planned stop/target levels.`;
    addLog('INFO', state.message);
    return;
  }
  const freshRisk = Math.abs(entry - stop);
  const freshReward = Math.abs(target - entry);
  if (!(freshRisk > 0) || freshReward / freshRisk < 1.5) {
    state.message = `Skipped ${signal.symbol}: the fresh entry quote reduced reward-to-risk below 1.5:1.`;
    addLog('INFO', state.message);
    return;
  }

  const positionMode = await deps.binanceRequest('GET', '/fapi/v1/positionSide/dual', {}, true, credentials);
  if (Boolean(positionMode?.dualSidePosition)) {
    throw new Error('Hedge Mode is enabled. This bot requires Binance One-way Mode because its protective orders close the full one-way position. Change the account to One-way Mode before starting.');
  }

  // Last duplicate guard immediately before execution. The scan and sizing
  // steps above may take time, so never rely only on the earlier preflight.
  const finalSnapshot = await readExchangeSnapshot(credentials);
  if (finalSnapshot.positions.length || finalSnapshot.orders.length || finalSnapshot.algoOrders.length) {
    throw new Error('Final pre-entry check found an exchange position or open order. No new order was sent; the bot will pause for reconciliation.');
  }
  if (!finalSnapshot.account?.canTrade || num(finalSnapshot.account.availableBalance) < notionalUsd) {
    throw new Error('Final pre-entry check found insufficient available Demo margin or disabled trading permission. No order was sent.');
  }

  await deps.binanceRequest('POST', '/fapi/v1/leverage', {
    symbol: plan.symbol,
    leverage: plan.leverage,
  }, true, credentials);

  const tradeId = String(Date.now());
  const entryClientOrderId = `TSBOTEN${tradeId}`;
  addLog('INFO', `Qualified ${signal.symbol} ${side} signal (score ${signal.score}, heuristic confidence ${signal.confidence}). Preparing a ${notionalUsd.toFixed(2)} USDT Binance Demo order.`);
  const entryResult = await deps.binanceRequest('POST', '/fapi/v1/order', {
    symbol: plan.symbol,
    side: plan.side,
    type: 'MARKET',
    quantity: plan.quantity,
    newClientOrderId: entryClientOrderId,
    newOrderRespType: 'RESULT',
  }, true, credentials);
  const executedQty = num(entryResult?.executedQty);
  if (!(executedQty > 0)) {
    throw new Error(`Binance did not confirm an executed quantity for ${plan.symbol}; response status: ${entryResult?.status || 'unknown'}. No active trade was added to the journal.`);
  }
  const executedPrice = num(entryResult?.avgPrice) > 0 ? num(entryResult.avgPrice) : entry;
  const actualNotional = executedQty * executedPrice;
  const trade: TradeRecord = {
    id: tradeId,
    symbol: plan.symbol,
    side,
    status: 'OPEN',
    notionalUsd: actualNotional,
    quantity: String(entryResult.executedQty),
    leverage: plan.leverage,
    entryPrice: executedPrice,
    markPrice: executedPrice,
    stopPrice: stop,
    targetPrice: target,
    unrealizedPnl: 0,
    realizedPnl: null,
    entryOrderId: entryResult.orderId ?? null,
    entryClientOrderId,
    stopAlgoId: null,
    stopClientAlgoId: `TSBOTSL${tradeId.slice(-13)}`,
    targetAlgoId: null,
    targetClientAlgoId: `TSBOTTP${tradeId.slice(-13)}`,
    openedAt: Date.now(),
    closedAt: null,
    closeReason: null,
  };

  // Persist the exchange fill before adding protective orders. If protection
  // cannot be established, the repair function attempts an emergency close.
  state.activeTrade = trade;
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, MAX_HISTORY);
  await persist();

  try {
    const tickSize = await getPriceTick(plan.symbol);
    const sl = await placeAlgoProtection(credentials, trade, 'SL', tickSize);
    trade.stopAlgoId = sl.algoId;
    trade.stopClientAlgoId = sl.clientAlgoId;
    const tp = await placeAlgoProtection(credentials, trade, 'TP', tickSize);
    trade.targetAlgoId = tp.algoId;
    trade.targetClientAlgoId = tp.clientAlgoId;
    state.activeTrade = { ...trade };
    const index = state.trades.findIndex(item => item.id === trade.id);
    if (index >= 0) state.trades[index] = { ...trade };
    state.message = `${plan.symbol} ${side} is open on Binance Futures Demo with exchange-side stop-loss and take-profit protection.`;
    addLog('TRADE', `BINANCE DEMO ENTRY FILLED: ${plan.symbol} ${side} · ${actualNotional.toFixed(2)} USDT · ${executedQty} contracts. Stop-loss and take-profit algo orders confirmed.`);
    await persist();
  } catch (error) {
    addLog('ERROR', `${plan.symbol} entry filled but one or both protective orders could not be installed: ${error instanceof Error ? error.message : 'Binance error'}`);
    const snapshot = await readExchangeSnapshot(credentials);
    const position = snapshot.positions.find(item => item.symbol === plan.symbol);
    if (position) {
      const ok = await ensureBothProtections(credentials, trade, snapshot.algoOrders);
      if (!ok && state.status !== 'ERROR') {
        state.status = 'PAUSED';
      }
    } else {
      await closeTradeJournal(credentials, trade, snapshot.algoOrders);
    }
  }
}

async function runCycle(): Promise<void> {
  if (loopBusy || !activeCredentials || !deps) return;
  if (state.status !== 'RUNNING' && !(state.status === 'PAUSED' && state.activeTrade)) return;
  loopBusy = true;
  try {
    const credentials = activeCredentials;
    const active = state.activeTrade;

    if (active) {
      const snapshot = await readExchangeSnapshot(credentials, active.symbol, false);
      const position = snapshot.positions.find(item => item.symbol === active.symbol);
      if (!position) {
        await closeTradeJournal(credentials, active, snapshot.algoOrders);
      } else {
        const actualSignedQty = num(position.positionAmt);
        const expectedLong = active.side === 'BUY';
        const actualLong = actualSignedQty > 0;
        if (actualSignedQty === 0 || actualLong !== expectedLong) {
          state.status = 'ERROR';
          state.message = `CRITICAL: Binance ${active.symbol} position side no longer matches the bot journal. Existing exchange orders were left untouched. Check the Demo account immediately.`;
          addLog('ERROR', state.message);
          stopLoop();
          await persist();
          return;
        }
        const expectedQty = Math.abs(num(active.quantity));
        const actualQty = Math.abs(actualSignedQty);
        const quantityChanged = expectedQty > 0 && Math.abs(actualQty - expectedQty) > Math.max(1e-8, expectedQty * 0.001);
        const updated: TradeRecord = {
          ...active,
          markPrice: num(position.markPrice) || active.markPrice,
          unrealizedPnl: num(position.unRealizedProfit ?? position.unrealizedProfit),
        };
        state.activeTrade = updated;
        if (quantityChanged && state.status === 'RUNNING') {
          state.status = 'PAUSED';
          state.message = `Exchange quantity changed for ${active.symbol}. New entries paused; existing close-position SL/TP orders remain active. Do not add manual trades to this symbol.`;
          addLog('WARN', state.message);
        }
        const index = state.trades.findIndex(item => item.id === updated.id);
        if (index >= 0) state.trades[index] = updated;
        const otherPositions = snapshot.positions.filter(item => item.symbol !== active.symbol);
        const botAlgoClientIds = new Set([active.stopClientAlgoId, active.targetClientAlgoId]);
        const botAlgoIds = new Set([active.stopAlgoId, active.targetAlgoId].filter(value => value !== null && value !== undefined).map(String));
        // The bot has no regular resting orders after a market entry. Any
        // regular order, even on the active symbol, is external activity.
        const unrelatedOrders = snapshot.orders;
        const unrelatedAlgoOrders = snapshot.algoOrders.filter(item =>
          !botAlgoClientIds.has(String(item.clientAlgoId || '')) &&
          !botAlgoIds.has(String(item.algoId ?? ''))
        );
        if (otherPositions.length || unrelatedOrders.length || unrelatedAlgoOrders.length) {
          state.status = 'PAUSED';
          const externalSymbols = [...new Set([
            ...otherPositions.map(item => item.symbol),
            ...unrelatedOrders.map(item => item.symbol),
            ...unrelatedAlgoOrders.map(item => item.symbol),
          ].filter(Boolean))];
          state.message = `External exchange activity detected${externalSymbols.length ? ` (${externalSymbols.join(', ')})` : ''}. New entries paused; existing ${active.symbol} protection remains active.`;
          addLog('WARN', state.message);
        }
        const protectedOk = await ensureBothProtections(credentials, updated, snapshot.algoOrders);
        if (!protectedOk && state.status === 'RUNNING') state.status = 'PAUSED';
        await persist();
      }
      if (!state.activeTrade && state.status === 'PAUSED') {
        stopLoop();
        activeCredentials = null;
      }
      return;
    }

    if (state.status !== 'RUNNING') {
      stopLoop();
      return;
    }
    if (!journalHealthy) {
      state.status = 'ERROR';
      state.message = 'Trade journal storage is unhealthy. New entries are disabled until the journal can be read and saved safely.';
      addLog('ERROR', state.message);
      stopLoop();
      return;
    }

    // Check live account positions cheaply between full scan cycles.
    const positionRows = await deps.binanceRequest('GET', '/fapi/v3/positionRisk', {}, true, credentials);
    const livePositions = (Array.isArray(positionRows) ? positionRows : []).filter(item => Math.abs(num(item.positionAmt)) > 0);
    if (livePositions.length) {
      state.status = 'PAUSED';
      state.message = `Safety pause: an exchange position appeared outside the bot (${livePositions.map(item => item.symbol).join(', ')}). No new order was sent.`;
      addLog('WARN', state.message);
      stopLoop();
      await persist();
      return;
    }

    if (state.lastScanAt && Date.now() - state.lastScanAt < SCAN_INTERVAL_MS) return;
    const snapshot = await readExchangeSnapshot(credentials, undefined, true);
    if (snapshot.positions.length || snapshot.orders.length || snapshot.algoOrders.length) {
      state.status = 'PAUSED';
      const held = snapshot.positions.map(item => item.symbol);
      const pending = [...snapshot.orders, ...snapshot.algoOrders].map(item => item.symbol).filter(Boolean);
      state.message = `Safety pause: Binance already has positions or open orders (${[...new Set([...held, ...pending])].join(', ')}). The bot will not add or duplicate trades. Review the exchange account and resume only after reconciliation.`;
      addLog('WARN', state.message);
      stopLoop();
      await persist();
      return;
    }

    state.message = 'Running the 15-minute signal scan and waiting for all entry filters.';
    let signals: Signal[];
    try {
      signals = await deps.getSignals();
    } catch (scanError) {
      state.lastScanAt = Date.now();
      state.message = `Market scan temporarily failed; the autonomous bot will retry automatically. ${scanError instanceof Error ? scanError.message : ''}`;
      addLog('WARN', state.message);
      return;
    }
    state.lastScanAt = Date.now();
    state.lastScanCount = signals.length;
    const candidate = qualifyingSignal(signals, state.config);
    state.lastCandidate = candidate
      ? { symbol: candidate.symbol, direction: candidate.direction, score: candidate.score }
      : null;

    if (!candidate) {
      state.message = `Scan complete: ${signals.length} markets reviewed; no setup passed all entry filters.`;
      addLog('INFO', state.message);
      return;
    }

    // Recheck the account and exchange immediately before placing an entry.
    const latest = await readExchangeSnapshot(credentials);
    if (latest.positions.length || latest.orders.length || latest.algoOrders.length) {
      state.status = 'PAUSED';
      state.message = 'Safety pause: an exchange position or open order appeared during pre-entry checks. No new order was sent.';
      addLog('WARN', state.message);
      stopLoop();
      return;
    }
    const availableBalance = num(latest.account?.availableBalance);
    if (!(availableBalance > 0) || !latest.account?.canTrade) {
      state.status = 'PAUSED';
      state.message = 'Safety pause: Binance Demo trading permission or available USDT balance is not confirmed.';
      addLog('WARN', state.message);
      stopLoop();
      return;
    }
    await openDemoTrade(credentials, candidate, availableBalance);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Autonomous Demo bot cycle failed.';
    if (state.activeTrade) {
      // Keep retrying exchange reconciliation for an open position. Its
      // exchange-side SL/TP orders remain the primary protection.
      state.status = 'PAUSED';
      state.message = `Exchange monitor temporarily failed: ${detail}. New entries are paused; monitoring will retry while this position remains open.`;
      addLog('WARN', state.message);
    } else {
      state.status = 'ERROR';
      state.message = detail;
      addLog('ERROR', state.message);
      stopLoop();
    }
    await persist();
  } finally {
    loopBusy = false;
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function sendError(res: Response, error: unknown, status = 400): void {
  res.status(status).json({
    success: false,
    message: error instanceof Error ? error.message : 'Autonomous Demo bot request failed.',
  });
}

export function registerAutonomousDemoBotRoutes(app: Express, dependencies: Dependencies): void {
  deps = dependencies;

  app.get('/api/quant/bot/state', async (req, res) => {
    try {
      deps!.getCredentials(req);
      await ensureLoaded();
      res.json(publicState());
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  app.post('/api/quant/bot/start', async (req, res) => {
    if (startRequestBusy) {
      return sendError(res, new Error('A bot start/reconciliation request is already in progress. Please wait for it to finish.'), 409);
    }
    startRequestBusy = true;
    try {
      await ensureLoaded();
      const credentials = deps!.getCredentials(req);
      if (state.status === 'RUNNING') {
        return res.json(publicState());
      }
      const requested = req.body || {};
      const riskPercent = Math.min(1, Math.max(0.1, num(requested.riskPercent) || defaultConfig.riskPercent));
      const maxNotionalUsd = Math.min(
        deps!.maxOrderUsd,
        100,
        Math.max(MIN_NOTIONAL_USD, num(requested.maxNotionalUsd) || defaultConfig.maxNotionalUsd)
      );
      const config: BotConfig = {
        riskPercent,
        maxNotionalUsd,
        leverage: 1,
        minScore: 65,
        minConfidence: 78,
      };

      if (!journalHealthy) throw new Error('The server trade journal is not healthy. Fix the journal file/storage before starting so existing exchange trades cannot be forgotten.');
      let snapshot = await readExchangeSnapshot(credentials);
      if (!snapshot.account?.canTrade) throw new Error('Binance Demo account does not report Futures trading permission enabled.');
      if (!(num(snapshot.account?.availableBalance) > 0)) throw new Error('Binance Demo has no available USDT margin.');
      const mode = await deps!.binanceRequest('GET', '/fapi/v1/positionSide/dual', {}, true, credentials);
      if (Boolean(mode?.dualSidePosition)) throw new Error('Binance Futures is in Hedge Mode. This bot currently requires One-way Mode; it will not change your account setting automatically.');

      if (state.activeTrade) {
        const existing = snapshot.positions.find(item => item.symbol === state.activeTrade!.symbol);
        if (!existing) {
          await closeTradeJournal(credentials, state.activeTrade, snapshot.algoOrders);
          // The first snapshot still contains the orders we just cancelled.
          // Re-read Binance before considering a fresh bot start.
          snapshot = await readExchangeSnapshot(credentials);
        } else {
          const actualQty = num(existing.positionAmt);
          const expectedLong = state.activeTrade.side === 'BUY';
          if ((actualQty > 0) !== expectedLong || Math.abs(Math.abs(actualQty) - num(state.activeTrade.quantity)) > Math.max(1e-8, num(state.activeTrade.quantity) * 0.001)) {
            throw new Error(`Existing ${state.activeTrade.symbol} Binance position does not match the stored bot trade size/side. Resume blocked; inspect the Demo account manually.`);
          }
          if (snapshot.positions.length > 1) throw new Error(`More than one exchange position exists (${snapshot.positions.map(item => item.symbol).join(', ')}). Bot resume blocked to prevent trade interference.`);
          const trackedClientIds = new Set([state.activeTrade.stopClientAlgoId, state.activeTrade.targetClientAlgoId]);
          const trackedAlgoIds = new Set([state.activeTrade.stopAlgoId, state.activeTrade.targetAlgoId].filter(value => value !== null && value !== undefined).map(String));
          const unrelatedRegular = snapshot.orders;
          const unrelatedAlgo = snapshot.algoOrders.filter(item =>
            !trackedClientIds.has(String(item.clientAlgoId || '')) &&
            !trackedAlgoIds.has(String(item.algoId ?? ''))
          );
          if (unrelatedRegular.length || unrelatedAlgo.length) throw new Error('Other open exchange orders exist. Cancel or reconcile them before resuming the bot.');
          const protectionReady = await ensureBothProtections(credentials, state.activeTrade, snapshot.algoOrders);
          if (!protectionReady) {
            if (state.status !== 'ERROR') state.status = 'PAUSED';
            throw new Error(state.message || 'Existing Binance Demo position could not be fully protected; resume blocked.');
          }
          activeCredentials = credentials;
          state.config = config;
          state.status = 'RUNNING';
          state.message = `Resumed management of existing ${state.activeTrade.symbol} Binance Demo position. No duplicate entry was sent; exchange-side SL/TP protection is confirmed.`;
          addLog('INFO', state.message);
          startLoop();
          return res.json(publicState());
        }
      }

      if (snapshot.positions.length || snapshot.orders.length || snapshot.algoOrders.length) {
        const symbols = [...new Set([
          ...snapshot.positions.map(item => item.symbol),
          ...snapshot.orders.map(item => item.symbol),
          ...snapshot.algoOrders.map(item => item.symbol),
        ].filter(Boolean))];
        throw new Error(`Start blocked: Binance Demo already has open positions or orders${symbols.length ? ` (${symbols.join(', ')})` : ''}. Close or cancel them on Binance first. The bot will not duplicate or take over an unknown trade.`);
      }

      state.config = config;
      state.status = 'RUNNING';
      state.message = 'Pre-start account check passed. Automatic Demo scanning is active; one exchange position maximum.';
      state.lastScanAt = null;
      state.lastCandidate = null;
      addLog('INFO', `AUTONOMOUS DEMO BOT STARTED. Available balance ${num(snapshot.account.availableBalance).toFixed(2)} USDT; risk budget ${riskPercent.toFixed(2)}%; notional cap ${maxNotionalUsd.toFixed(2)} USDT; leverage 1x.`);
      await persist();
      if (!journalHealthy) {
        state.status = 'ERROR';
        state.message = 'Bot start cancelled because the trade journal could not be saved safely.';
        activeCredentials = null;
        stopLoop();
        throw new Error(state.message);
      }
      activeCredentials = credentials;
      startLoop();
      res.json(publicState());
    } catch (error) {
      sendError(res, error, 409);
    } finally {
      startRequestBusy = false;
    }
  });

  app.post('/api/quant/bot/stop', async (req, res) => {
    try {
      const credentials = deps!.getCredentials(req);
      await ensureLoaded();
      state.status = 'PAUSED';
      state.message = state.activeTrade
        ? `New entries paused. Existing ${state.activeTrade.symbol} position stays open and protected by Binance Demo SL/TP orders until it closes.`
        : 'New entries paused. There is no bot-managed exchange position.';
      addLog('WARN', state.message);
      if (!state.activeTrade) {
        stopLoop();
        activeCredentials = null;
      } else {
        // Keep the server-side monitor alive for the existing position; no new entries while PAUSED.
        activeCredentials = credentials;
        if (!loop) startLoop();
      }
      await persist();
      res.json(publicState());
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  app.get('/api/quant/bot/history.csv', async (req, res) => {
    try {
      deps!.getCredentials(req);
      await ensureLoaded();
      const columns = ['id', 'symbol', 'side', 'status', 'notionalUsd', 'quantity', 'leverage', 'entryPrice', 'stopPrice', 'targetPrice', 'markPrice', 'unrealizedPnl', 'realizedPnl', 'entryOrderId', 'stopAlgoId', 'targetAlgoId', 'openedAt', 'closedAt', 'closeReason'];
      const rows = [columns, ...state.trades.map(trade => columns.map(key => (trade as any)[key]))];
      const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="turboscalp-binance-demo-trades.csv"');
      res.send(csv);
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  app.get('/api/quant/bot/logs.csv', async (req, res) => {
    try {
      deps!.getCredentials(req);
      await ensureLoaded();
      const rows = [['timestamp', 'level', 'message'], ...state.logs.map(event => [new Date(event.at).toISOString(), event.level, event.message])];
      const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="turboscalp-binance-demo-activity.csv"');
      res.send(csv);
    } catch (error) {
      sendError(res, error, 401);
    }
  });
}

export function pauseAllAutonomousDemoBots(reason: string): void {
  if (state.status === 'RUNNING') {
    state.status = 'PAUSED';
    state.message = state.activeTrade
      ? `New entries paused (${reason}). Existing exchange-side protection remains active.`
      : `Bot paused (${reason}).`;
    addLog('WARN', state.message);
    if (!state.activeTrade) {
      stopLoop();
      activeCredentials = null;
    }
  }
}

export function shutdownAutonomousDemoBot(): void {
  if (loop) clearInterval(loop);
  loop = null;
  activeCredentials = null;
  if (state.status === 'RUNNING' || state.status === 'PAUSED') {
    state.status = 'PAUSED';
    state.message = 'Server stopped. Binance Demo exchange-side protective orders remain on the exchange; reconnect and reconcile before resuming.';
    addLog('WARN', state.message);
  }
}
