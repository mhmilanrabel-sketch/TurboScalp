// server/autonomousDemoBot.ts
// ─────────────────────────────────────────────────────────────
// Autonomous scalping bot for Binance USD-M Futures DEMO.
// Pushes every order to https://demo-fapi.binance.com
// ─────────────────────────────────────────────────────────────
import type { Express, Request, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

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
async function readExchangeSnapshot(symbol?: string) {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  const positions: any[] = await deps.binanceRequest(
    'GET',
    '/fapi/v2/positionRisk',
    symbol ? { symbol } : {},
    true,
    activeCredentials,
  );
  return Array.isArray(positions) ? positions : [];
}

async function getPriceTick(symbol: string): Promise<number> {
  if (!deps || !activeCredentials) return 0;
  const info: any = await deps.binanceRequest(
    'GET',
    '/fapi/v1/exchangeInfo',
    {},
    false,
    activeCredentials,
  );
  const sym = info?.symbols?.find((s: any) => s.symbol === symbol);
  const filter = sym?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
  const tick = Number(filter?.tickSize || '0.0001');
  return tick > 0 ? tick : 0.0001;
}

function roundTrigger(price: number, tick: number): string {
  if (!tick) return String(price);
  const precision = Math.max(0, Math.round(-Math.log10(tick)));
  return price.toFixed(precision);
}

async function placeAlgoProtection(
  symbol: string,
  side: 'BUY' | 'SELL',
  triggerPrice: string,
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
  clientAlgoId: string,
  quantity: string,
) {
  if (!deps || !activeCredentials) throw new Error('No credentials');
  return deps.binanceRequest(
    'POST',
    '/fapi/v1/algoOrder',
    {
      algoType: 'CONDITIONAL',
      symbol,
      side,
      type,
      triggerPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      quantity,
      clientAlgoId,
      reduceOnly: 'true',
      timeInForce: 'GTC',
    },
    true,
    activeCredentials,
  );
}

async function cancelOurAlgoOrders(symbol: string) {
  if (!deps || !activeCredentials) return;
  try {
    await deps.binanceRequest(
      'DELETE',
      '/fapi/v1/algoOrder',
      { symbol },
      true,
      activeCredentials,
    );
  } catch (error: any) {
    if (error?.response?.status !== 404) {
      console.warn('cancelOurAlgoOrders failed:', error?.message);
    }
  }
}

async function getRealizedNetPnl(symbol: string, sinceMs: number): Promise<number> {
  if (!deps || !activeCredentials) return 0;
  try {
    const trades: any[] = await deps.binanceRequest(
      'GET',
      '/fapi/v1/userTrades',
      { symbol, startTime: sinceMs, limit: 50 },
      true,
      activeCredentials,
    );
    if (!Array.isArray(trades)) return 0;
    return trades.reduce(
      (sum, t) => sum + num(t.realizedPnl) - num(t.commission),
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
  const realized = await getRealizedNetPnl(trade.symbol, trade.openedAt);
  trade.status = 'CLOSED';
  trade.closedAt = Date.now();
  trade.closeReason = reason;
  trade.realizedPnl = realized;
  cooldowns.set(trade.symbol, Date.now() + SAME_SYMBOL_COOLDOWN_MS);
  if (state.activeTrade?.id === trade.id) state.activeTrade = null;
  addLog(
    'TRADE',
    `${trade.symbol} closed (${reason}) — realized PnL $${realized.toFixed(2)}`,
  );
}

async function ensureBothProtections(trade: TradeRecord) {
  if (!deps || !activeCredentials) return;
  try {
    const open: any[] = await deps.binanceRequest(
      'GET',
      '/fapi/v1/algoOpenOrders',
      { symbol: trade.symbol },
      true,
      activeCredentials,
    );
    const clientIds = new Set(
      (Array.isArray(open) ? open : []).map((o: any) => o.clientAlgoId),
    );
    const tick = await getPriceTick(trade.symbol);
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

    if (!clientIds.has(trade.stopClientAlgoId) && trade.stopPrice > 0) {
      const resp: any = await placeAlgoProtection(
        trade.symbol,
        exitSide,
        roundTrigger(trade.stopPrice, tick),
        'STOP_MARKET',
        trade.stopClientAlgoId,
        trade.quantity,
      );
      trade.stopAlgoId = resp?.algoId ?? null;
      addLog('INFO', `${trade.symbol} re-armed STOP at ${trade.stopPrice}`);
    }

    if (!clientIds.has(trade.targetClientAlgoId) && trade.targetPrice > 0) {
      const resp: any = await placeAlgoProtection(
        trade.symbol,
        exitSide,
        roundTrigger(trade.targetPrice, tick),
        'TAKE_PROFIT_MARKET',
        trade.targetClientAlgoId,
        trade.quantity,
      );
      trade.targetAlgoId = resp?.algoId ?? null;
      addLog('INFO', `${trade.symbol} re-armed TP at ${trade.targetPrice}`);
    }
  } catch (error: any) {
    console.warn('ensureBothProtections failed:', error?.message);
  }
}

// ── Signal selection ───────────────────────────────────────
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
    addLog('WARN', `${signal.symbol} plan too small — skipped`);
    return;
  }

  try {
    await deps.binanceRequest(
      'POST',
      '/fapi/v1/leverage',
      { symbol: plan.symbol, leverage: plan.leverage },
      true,
      activeCredentials,
    );
  } catch (err: any) {
    addLog('WARN', `Leverage set failed for ${plan.symbol}: ${err?.message}`);
  }

  const entryClientOrderId = `ts-entry-${newId()}`;
  const order: any = await deps.binanceRequest(
    'POST',
    '/fapi/v1/order',
    {
      symbol: plan.symbol,
      side: plan.side,
      type: 'MARKET',
      quantity: plan.quantity,
      newClientOrderId: entryClientOrderId,
      newOrderRespType: 'RESULT',
    },
    true,
    activeCredentials,
  );

  const entryPrice = num(order?.avgPrice) || num(signal.price);
  const stopPrice = num(signal.stopLoss);
  const targetPrice = num(signal.takeProfit);
  const exitSide = plan.side === 'BUY' ? 'SELL' : 'BUY';
  const tick = await getPriceTick(plan.symbol);

  const stopClientAlgoId = `ts-stop-${newId()}`;
  const targetClientAlgoId = `ts-tp-${newId()}`;

  let stopAlgoId: any = null;
  let targetAlgoId: any = null;

  try {
    const stop: any = await placeAlgoProtection(
      plan.symbol,
      exitSide,
      roundTrigger(stopPrice, tick),
      'STOP_MARKET',
      stopClientAlgoId,
      plan.quantity,
    );
    stopAlgoId = stop?.algoId ?? null;
  } catch (err: any) {
    addLog('ERROR', `${plan.symbol} STOP_MARKET failed: ${err?.message}`);
  }

  try {
    const tp: any = await placeAlgoProtection(
      plan.symbol,
      exitSide,
      roundTrigger(targetPrice, tick),
      'TAKE_PROFIT_MARKET',
      targetClientAlgoId,
      plan.quantity,
    );
    targetAlgoId = tp?.algoId ?? null;
  } catch (err: any) {
    addLog('ERROR', `${plan.symbol} TAKE_PROFIT_MARKET failed: ${err?.message}`);
  }

  const trade: TradeRecord = {
    id: newId(),
    symbol: plan.symbol,
    side: plan.side,
    status: 'OPEN',
    notionalUsd: plan.notionalUsd,
    quantity: plan.quantity,
    leverage: plan.leverage,
    entryPrice,
    markPrice: entryPrice,
    stopPrice,
    targetPrice,
    unrealizedPnl: 0,
    realizedPnl: null,
    entryOrderId: order?.orderId ?? null,
    entryClientOrderId,
    stopAlgoId,
    stopClientAlgoId,
    targetAlgoId,
    targetClientAlgoId,
    openedAt: Date.now(),
    closedAt: null,
    closeReason: null,
  };

  state.activeTrade = trade;
  state.trades.push(trade);
  addLog(
    'TRADE',
    `OPENED ${trade.side} ${trade.symbol} qty=${trade.quantity} entry≈${entryPrice} SL=${stopPrice} TP=${targetPrice}`,
  );
  await persist();
}

// ── Main cycle ─────────────────────────────────────────────
async function runCycle() {
  if (loopBusy || !deps) return;
  loopBusy = true;
  try {
    await ensureLoaded();
    if (state.status !== 'RUNNING' || !activeCredentials || !journalHealthy)
      return;

    if (state.activeTrade) {
      const positions = await readExchangeSnapshot(state.activeTrade.symbol);
      const pos = positions.find(
        (p: any) => p.symbol === state.activeTrade!.symbol,
      );
      const amt = num(pos?.positionAmt);
      if (Math.abs(amt) < 1e-12) {
        await closeTradeJournal(state.activeTrade, 'CLOSED_ON_EXCHANGE');
      } else {
        state.activeTrade.markPrice = num(pos?.markPrice);
        state.activeTrade.unrealizedPnl = num(pos?.unRealizedProfit);
        await ensureBothProtections(state.activeTrade);
      }
      return;
    }

    const now = Date.now();
    if (state.lastScanAt && now - state.lastScanAt < SCAN_INTERVAL_MS) return;

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
  stopLoop();
  if (state.status === 'RUNNING') {
    state.status = 'PAUSED';
    state.message = 'Paused by server lifecycle.';
  }
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
      const creds = deps!.getCredentials(req);
      if (!creds.apiKey || !creds.apiSecret) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing demo API credentials' });
      }
      activeCredentials = creds;

      try {
        await deps!.binanceRequest(
          'GET',
          '/fapi/v3/account',
          {},
          true,
          activeCredentials,
        );
      } catch (err: any) {
        state.status = 'ERROR';
        state.message = `Demo account verification failed: ${err?.message}`;
        return res.status(400).json({
          success: false,
          error: 'Demo credentials rejected by Binance',
          detail: err?.message,
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
    stopLoop();
    state.status = 'STOPPED';
    state.message = 'Bot stopped by user.';
    addLog('INFO', 'Bot stopped.');
    await persist();
    res.json({ success: true, state: publicState() });
  });

  app.post('/api/autonomous-demo-bot/pause', async (_req, res) => {
    await ensureLoaded();
    if (state.status === 'RUNNING') state.status = 'PAUSED';
    stopLoop();
    addLog('INFO', 'Bot paused.');
    await persist();
    res.json({ success: true, state: publicState() });
  });

  addLog('INFO', 'Autonomous Demo Bot routes registered.');
}

// ── Re-exports (types) ─────────────────────────────────────
export type { BinanceRequest, Credentials, Dependencies, BotConfig };