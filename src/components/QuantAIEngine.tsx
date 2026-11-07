import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Signal = {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  score: number;
  confidence: number;
  price: number;
  change24h: number;
  quoteVolume: number;
  rsi: number;
  volumeRatio: number;
  volatilityPct: number;
  stopLoss: number | null;
  takeProfit: number | null;
  reasons: string[];
};

type TradeStatus = 'OPEN' | 'TP' | 'SL';

type PaperTrade = {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stop: number;
  target: number;
  notional: number;
  status: TradeStatus;
  pnl?: number;
  exitPrice?: number;
  openedAt: number;
  closedAt?: number;
};

const STORAGE_KEY = 'turboscalp.quant-paper-trades.v1';
const MAX_PAPER_NOTIONAL = 100;
const MIN_PAPER_NOTIONAL = 5;
const MIN_SCORE = 65;
const MIN_CONFIDENCE = 80;
const MIN_VOLUME = 250_000;
const MIN_VOLATILITY = 0.05;
const MAX_VOLATILITY = 2.5;
const MIN_REWARD_RISK = 1.5;
const MIN_STOP_DISTANCE = 0.001;
const MAX_STOP_DISTANCE = 0.025;
const COOLDOWN_MS = 30 * 60 * 1000;
const REENTRY_PAUSE_MS = 60 * 1000;
const ESTIMATED_ROUND_TRIP_FEE = 0.0008;

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  return value < 1
    ? '$' + value.toPrecision(5)
    : '$' + value.toLocaleString('en-US', { maximumFractionDigits: 4 });
};

const compact = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return value.toFixed(0);
};

const formatSignedPercent = (value: number): string =>
  `${value > 0 ? '+' : ''}${Number(value || 0).toFixed(2)}%`;

const formatTime = (timestamp?: number): string => {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatAge = (timestamp: number, now: number): string => {
  if (!timestamp) return 'Waiting for first scan';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const calculateNetPnl = (trade: PaperTrade, price: number): number => {
  if (!Number.isFinite(price) || price <= 0 || trade.entry <= 0) return 0;
  const move = trade.side === 'BUY'
    ? (price - trade.entry) / trade.entry
    : (trade.entry - price) / trade.entry;
  return trade.notional * move - trade.notional * ESTIMATED_ROUND_TRIP_FEE;
};

function loadPaperTrades(): PaperTrade[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((trade: any) =>
      trade &&
      typeof trade.id === 'string' &&
      typeof trade.symbol === 'string' &&
      (trade.side === 'BUY' || trade.side === 'SELL') &&
      ['OPEN', 'TP', 'SL'].includes(trade.status) &&
      Number.isFinite(Number(trade.entry)) &&
      Number.isFinite(Number(trade.stop)) &&
      Number.isFinite(Number(trade.target)) &&
      Number.isFinite(Number(trade.notional))
    ).slice(0, 100);
  } catch {
    return [];
  }
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Request failed (${response.status})`);
  }
  return data;
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-800/90 bg-[#0c1422] p-3.5 sm:p-4">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-2 truncate text-xl font-black tracking-tight sm:text-2xl ${tone}`}>{value}</p>
      <p className="mt-1 truncate text-[10px] text-slate-500">{detail}</p>
    </div>
  );
}

function SignalBadge({ direction }: { direction: Signal['direction'] }) {
  const classes = direction === 'BUY'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : direction === 'SELL'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
      : 'border-slate-700 bg-slate-800/70 text-slate-400';

  return (
    <span className={`inline-flex min-w-[58px] justify-center rounded-md border px-2 py-1 text-[9px] font-black tracking-wide ${classes}`}>
      {direction}
    </span>
  );
}

export function QuantAIEngine() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [markets, setMarkets] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('score');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  const [activeQuoteUpdatedAt, setActiveQuoteUpdatedAt] = useState(0);
  const [activeQuoteError, setActiveQuoteError] = useState('');
  const [clock, setClock] = useState(Date.now());

  const [bot, setBot] = useState(false);
  const [size, setSize] = useState('25');
  const [botMessage, setBotMessage] = useState('Bot is paused. Start it to allow one qualified paper entry at a time.');
  const [trades, setTrades] = useState<PaperTrade[]>(loadPaperTrades);

  const [selected, setSelected] = useState<Signal | null>(null);
  const [explain, setExplain] = useState('');
  const [busyExplain, setBusyExplain] = useState(false);

  const scanBusy = useRef(false);
  const mounted = useRef(true);

  const scan = useCallback(async () => {
    if (scanBusy.current) return;
    scanBusy.current = true;
    setLoading(true);
    setError('');

    try {
      const [universeResponse, scanResponse] = await Promise.all([
        fetch('/api/quant/universe', { cache: 'no-store' }),
        fetch('/api/quant/scan?limit=40&minVolume=250000', { cache: 'no-store' }),
      ]);
      const [universeData, scanData] = await Promise.all([
        readJson(universeResponse),
        readJson(scanResponse),
      ]);

      if (!mounted.current) return;
      setMarkets(Number(universeData.count) || 0);
      setSignals(Array.isArray(scanData.signals) ? scanData.signals : []);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Quant scanner unavailable');
    } finally {
      scanBusy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void scan();
    const interval = window.setInterval(() => void scan(), bot ? 30_000 : 60_000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [scan, bot]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades.slice(0, 100)));
    } catch {
      // The journal remains usable for this session if browser storage is unavailable.
    }
  }, [trades]);

  const rows = useMemo(() => {
    const filtered = signals.filter(signal =>
      signal.symbol.toLowerCase().includes(search.trim().toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      if (sort === 'volume') return b.quoteVolume - a.quoteVolume;
      if (sort === 'change') return b.change24h - a.change24h;
      if (sort === 'confidence') return b.confidence - a.confidence;
      return Math.abs(b.score) - Math.abs(a.score);
    });
  }, [signals, search, sort]);

  const openTrades = useMemo(() => trades.filter(trade => trade.status === 'OPEN'), [trades]);
  const closedTrades = useMemo(() => trades.filter(trade => trade.status !== 'OPEN'), [trades]);
  const activeTrade = openTrades[0] || null;
  const activeSignal = activeTrade
    ? signals.find(signal => signal.symbol === activeTrade.symbol) || null
    : null;
  const currentTradePrice = activeSignal?.price || null;
  const unrealizedPnl = activeTrade && currentTradePrice
    ? calculateNetPnl(activeTrade, currentTradePrice)
    : null;
  const realizedPnl = closedTrades.reduce((total, trade) => total + (trade.pnl || 0), 0);
  const wins = closedTrades.filter(trade => (trade.pnl || 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : null;
  const buyCount = signals.filter(signal => signal.direction === 'BUY').length;
  const sellCount = signals.filter(signal => signal.direction === 'SELL').length;
  const snapshotFresh = !!lastUpdatedAt && clock - lastUpdatedAt < 90_000;

  // Monitor the active symbol directly instead of relying only on the top-40
  // scanner batch. The server already exposes /api/quant/analyze/:symbol.
  useEffect(() => {
    const symbol = activeTrade?.symbol;
    setActiveQuoteUpdatedAt(0);
    setActiveQuoteError('');
    if (!symbol) return;

    let cancelled = false;
    const refreshActiveQuote = async () => {
      try {
        const response = await fetch(`/api/quant/analyze/${encodeURIComponent(symbol)}`, {
          cache: 'no-store',
        });
        const data = await readJson(response);
        if (cancelled || !data.signal) return;

        setSignals(previous => {
          const withoutSymbol = previous.filter(item => item.symbol !== symbol);
          return [data.signal as Signal, ...withoutSymbol]
            .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
            .slice(0, 40);
        });
        setActiveQuoteUpdatedAt(Date.now());
        setActiveQuoteError('');
      } catch (err) {
        if (!cancelled) {
          setActiveQuoteError(err instanceof Error ? err.message : 'Active symbol refresh failed');
        }
      }
    };

    void refreshActiveQuote();
    const interval = window.setInterval(() => void refreshActiveQuote(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTrade?.symbol]);

  const activeQuoteFresh = !!activeQuoteUpdatedAt && clock - activeQuoteUpdatedAt < 30_000;

  const discuss = async (signal: Signal) => {
    setSelected(signal);
    setExplain('');
    setBusyExplain(true);
    try {
      const response = await fetch('/api/quant/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server route expects the symbol field.
        body: JSON.stringify({ symbol: signal.symbol }),
      });
      const data = await readJson(response);
      setExplain(data.discussion || data.message || 'No explanation available.');
    } catch (err) {
      setExplain(err instanceof Error ? err.message : 'Unable to load signal explanation.');
    } finally {
      setBusyExplain(false);
    }
  };

  // Every new scanner snapshot updates open paper positions. Stopping the bot
  // pauses new entries; it does not silently abandon already-open simulations.
  useEffect(() => {
    if (!signals.length || !lastUpdatedAt) return;
    const now = Date.now();
    const signalMap = new Map(signals.map(signal => [signal.symbol, signal]));

    setTrades(previous => {
      let next = previous.map(trade => {
        if (trade.status !== 'OPEN') return trade;
        const signal = signalMap.get(trade.symbol);
        if (!signal || !Number.isFinite(signal.price) || signal.price <= 0) return trade;

        const hitStop = trade.side === 'BUY'
          ? signal.price <= trade.stop
          : signal.price >= trade.stop;
        const hitTarget = trade.side === 'BUY'
          ? signal.price >= trade.target
          : signal.price <= trade.target;

        if (!hitStop && !hitTarget) return trade;

        // Use the observed scanner quote, not the theoretical SL/TP trigger price.
        const exitPrice = signal.price;
        return {
          ...trade,
          status: hitStop ? 'SL' as const : 'TP' as const,
          exitPrice,
          closedAt: now,
          pnl: calculateNetPnl(trade, exitPrice),
        };
      });

      if (!bot || now - lastUpdatedAt > 90_000 || next.some(trade => trade.status === 'OPEN')) {
        return next;
      }

      // Avoid an immediate second entry after an exit and apply per-symbol cooldown.
      const latestClose = next.reduce((latest, trade) =>
        Math.max(latest, trade.closedAt || 0), 0);
      if (latestClose && now - latestClose < REENTRY_PAUSE_MS) return next;

      const cooldownSymbols = new Set(
        next
          .filter(trade => trade.closedAt && now - trade.closedAt < COOLDOWN_MS)
          .map(trade => trade.symbol)
      );

      const candidates = signals.filter(signal => {
        if (signal.direction === 'NEUTRAL') return false;
        if (!Number.isFinite(signal.price) || signal.price <= 0) return false;
        if (Math.abs(signal.score) < MIN_SCORE || signal.confidence < MIN_CONFIDENCE) return false;
        if (signal.quoteVolume < MIN_VOLUME) return false;
        if (signal.volatilityPct < MIN_VOLATILITY || signal.volatilityPct > MAX_VOLATILITY) return false;
        if (cooldownSymbols.has(signal.symbol)) return false;

        const stop = Number(signal.stopLoss);
        const target = Number(signal.takeProfit);
        if (!Number.isFinite(stop) || !Number.isFinite(target)) return false;

        const buy = signal.direction === 'BUY';
        const correctlyPlaced = buy
          ? stop < signal.price && target > signal.price
          : target < signal.price && stop > signal.price;
        if (!correctlyPlaced) return false;

        const riskDistance = Math.abs(signal.price - stop) / signal.price;
        if (riskDistance < MIN_STOP_DISTANCE || riskDistance > MAX_STOP_DISTANCE) return false;
        const rewardRisk = Math.abs(target - signal.price) / Math.abs(signal.price - stop);
        return rewardRisk >= MIN_REWARD_RISK;
      });

      candidates.sort((a, b) =>
        (Math.abs(b.score) * 0.65 + b.confidence * 0.35) -
        (Math.abs(a.score) * 0.65 + a.confidence * 0.35)
      );

      const candidate = candidates[0];
      if (!candidate) return next;

      const notional = clamp(Number(size) || 25, MIN_PAPER_NOTIONAL, MAX_PAPER_NOTIONAL);
      const side = candidate.direction as 'BUY' | 'SELL';
      const newTrade: PaperTrade = {
        id: `${now}-${candidate.symbol}`,
        symbol: candidate.symbol,
        side,
        entry: candidate.price,
        stop: Number(candidate.stopLoss),
        target: Number(candidate.takeProfit),
        notional,
        status: 'OPEN',
        openedAt: now,
      };
      return [newTrade, ...next].slice(0, 100);
    });
  }, [signals, bot, lastUpdatedAt, size]);

  const toggleBot = () => {
    if (bot) {
      setBot(false);
      setBotMessage('New entries paused. Existing open paper positions will continue to be monitored while this page is running.');
    } else {
      setBot(true);
      setBotMessage('Bot enabled. It will wait for a qualified setup; no exchange orders are sent.');
    }
  };

  const riskReward = activeTrade
    ? Math.abs(activeTrade.target - activeTrade.entry) / Math.max(Math.abs(activeTrade.entry - activeTrade.stop), Number.EPSILON)
    : 0;
  const progress = activeTrade && currentTradePrice
    ? activeTrade.side === 'BUY'
      ? clamp((currentTradePrice - activeTrade.stop) / (activeTrade.target - activeTrade.stop), 0, 1)
      : clamp((activeTrade.stop - currentTradePrice) / (activeTrade.stop - activeTrade.target), 0, 1)
    : 0;

  return (
    <section className="relative space-y-5 overflow-hidden rounded-[24px] border border-slate-800 bg-[#080e19] p-3 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.28)] sm:p-5 lg:p-6">
      <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-cyan-500/[0.07] blur-3xl" />

      {/* Header */}
      <div className="relative flex flex-col justify-between gap-4 border-b border-slate-800/90 pb-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.8)]" />
            <p className="text-[9px] font-black uppercase tracking-[0.24em] text-cyan-300">TurboScalp · Intelligence Terminal</p>
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">QUANT AI LAB</h2>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-slate-500 sm:text-[11px]">
            Binance Futures Demo market analysis · USDT perpetuals · 15-minute signal framework
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[9px] font-bold tracking-wide ${snapshotFresh ? 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300' : 'border-amber-500/25 bg-amber-500/[0.07] text-amber-300'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${snapshotFresh ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {snapshotFresh ? 'SCANNER FRESH' : 'SCANNER STALE'}
          </div>
          <div className="rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-[9px] font-bold text-slate-300">PAPER · NO ORDERS</div>
          <button
            onClick={() => void scan()}
            disabled={loading}
            className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[9px] font-black tracking-wide text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? 'SCANNING…' : '↻ RESCAN'}
          </button>
        </div>
      </div>

      {/* Snapshot metrics */}
      <div className="relative grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard label="Universe" value={compact(markets)} detail="Contracts available" />
        <MetricCard label="Buy setups" value={String(buyCount)} detail="Current scanner snapshot" tone="text-emerald-300" />
        <MetricCard label="Sell setups" value={String(sellCount)} detail="Current scanner snapshot" tone="text-rose-300" />
        <MetricCard label="Realized P&L" value={`${realizedPnl >= 0 ? '+' : ''}${formatPrice(realizedPnl)}`} detail={`${closedTrades.length} closed simulations`} tone={realizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'} />
        <MetricCard label="Win rate" value={winRate === null ? '—' : `${winRate.toFixed(1)}%`} detail={closedTrades.length ? `${wins} wins / ${closedTrades.length} closed` : 'Awaiting closed trades'} tone="text-cyan-200" />
      </div>

      {error && (
        <div className="relative flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3 text-[10px] text-rose-200">
          <span className="font-black">!</span>
          <div><p className="font-bold">Scanner request failed</p><p className="mt-1 text-rose-200/70">{error}</p></div>
        </div>
      )}

      {/* Main workspace */}
      <div className="relative grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(290px,0.8fr)]">
        {/* Market scanner */}
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1320]">
          <div className="flex flex-col justify-between gap-3 border-b border-slate-800 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[11px] font-black tracking-[0.12em] text-white">MARKET SCANNER</h3>
                <span className="rounded bg-slate-800 px-1.5 py-1 text-[8px] font-bold text-slate-400">{rows.length} RESULTS</span>
              </div>
              <p className="mt-1 text-[9px] text-slate-500">Ranked setups from the latest REST snapshot</p>
            </div>
            <div className="flex gap-2">
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Find pair…"
                className="min-w-0 w-full rounded-lg border border-slate-700 bg-[#070d17] px-3 py-2 text-[10px] text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-500/60 sm:w-36"
              />
              <select
                value={sort}
                onChange={event => setSort(event.target.value)}
                className="rounded-lg border border-slate-700 bg-[#070d17] px-2 py-2 text-[10px] text-slate-300 outline-none focus:border-cyan-500/60"
              >
                <option value="score">Score</option>
                <option value="confidence">Confidence</option>
                <option value="volume">Volume</option>
                <option value="change">24h change</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-[10px]">
              <thead className="bg-[#080e18] text-[8px] font-bold uppercase tracking-[0.13em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Contract</th>
                  <th className="px-3 py-3">Last scan</th>
                  <th className="px-3 py-3">24h</th>
                  <th className="px-3 py-3">Volume</th>
                  <th className="px-3 py-3">RSI</th>
                  <th className="px-3 py-3">AI score</th>
                  <th className="px-3 py-3">Bias</th>
                  <th className="px-4 py-3 text-right">Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((signal, index) => {
                  const scoreWidth = clamp(Math.abs(signal.score), 0, 100);
                  const scoreTone = signal.direction === 'BUY'
                    ? 'bg-emerald-400'
                    : signal.direction === 'SELL'
                      ? 'bg-rose-400'
                      : 'bg-slate-500';
                  return (
                    <tr key={signal.symbol} className={`border-t border-slate-800/70 transition hover:bg-cyan-500/[0.035] ${index === 0 ? 'bg-cyan-500/[0.025]' : ''}`}>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="font-black text-slate-100">{signal.symbol}</div>
                        <div className="mt-1 text-[8px] text-slate-600">{Number(signal.confidence || 0).toFixed(0)}% confidence</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-semibold text-slate-200">{formatPrice(signal.price)}</td>
                      <td className={`whitespace-nowrap px-3 py-3 font-bold ${signal.change24h >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{formatSignedPercent(signal.change24h)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-slate-400">{compact(signal.quoteVolume)}</td>
                      <td className="px-3 py-3 text-slate-400">{Number(signal.rsi || 0).toFixed(1)}</td>
                      <td className="min-w-[92px] px-3 py-3">
                        <div className="font-black text-slate-200">{signal.score > 0 ? '+' : ''}{signal.score}</div>
                        <div className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-slate-800">
                          <div className={`h-full rounded-full ${scoreTone}`} style={{ width: `${scoreWidth}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-3"><SignalBadge direction={signal.direction} /></td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button onClick={() => void discuss(signal)} className="rounded-md border border-cyan-500/20 px-2.5 py-1.5 text-[9px] font-bold text-cyan-300 transition hover:border-cyan-400/50 hover:bg-cyan-500/10">Analyze ↗</button>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-[10px] text-slate-500">{loading ? 'Loading market snapshot…' : 'No matching scanner signals. Try another pair or rescan.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-3 text-[9px] text-slate-600">
            <span>{formatAge(lastUpdatedAt, clock)}</span>
            <span>Scanner refresh: {bot ? '30 seconds while bot is enabled' : '60 seconds while bot is paused'}</span>
          </div>
        </div>

        {/* Paper bot controls */}
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="rounded-2xl border border-cyan-500/20 bg-[linear-gradient(145deg,rgba(8,35,49,0.72),rgba(11,19,32,0.98)_55%)] p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-cyan-300">Autonomous execution</p>
                <h3 className="mt-1 text-sm font-black text-white">PAPER BOT</h3>
              </div>
              <span className={`rounded-md border px-2 py-1 text-[8px] font-black tracking-wide ${bot ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>
                {bot ? '● RUNNING' : '○ PAUSED'}
              </span>
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
              One open paper position maximum. Entries require score, confidence, volume, volatility, valid SL/TP and at least 1.5:1 reward-to-risk. Runs only while this page stays open.
            </p>

            <label className="mt-4 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Position notional · USDT
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-[#070d17] px-3">
                <span className="text-xs font-bold text-slate-500">$</span>
                <input
                  type="number"
                  min={MIN_PAPER_NOTIONAL}
                  max={MAX_PAPER_NOTIONAL}
                  step="1"
                  value={size}
                  disabled={bot}
                  onChange={event => setSize(event.target.value)}
                  className="w-full bg-transparent py-2.5 text-xs font-bold text-white outline-none disabled:cursor-not-allowed disabled:opacity-60"
                />
                <span className="text-[9px] text-slate-600">5–100</span>
              </div>
            </label>

            <button
              onClick={toggleBot}
              className={`mt-4 w-full rounded-xl px-4 py-3 text-[10px] font-black tracking-[0.14em] transition ${bot ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15' : 'bg-cyan-400 text-[#04111a] shadow-[0_8px_26px_rgba(34,211,238,0.12)] hover:bg-cyan-300'}`}
            >
              {bot ? 'PAUSE NEW ENTRIES' : 'START PAPER BOT  →'}
            </button>

            <p className="mt-3 min-h-[30px] text-[9px] leading-relaxed text-slate-500">{botMessage}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-700/70 pt-3">
              <div><p className="text-[8px] uppercase tracking-wider text-slate-600">Open positions</p><p className="mt-1 text-lg font-black text-white">{openTrades.length}<span className="text-[10px] font-medium text-slate-600"> / 1</span></p></div>
              <div><p className="text-[8px] uppercase tracking-wider text-slate-600">Closed trades</p><p className="mt-1 text-lg font-black text-white">{closedTrades.length}</p></div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-[#0b1320] p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[10px] font-black tracking-[0.12em] text-white">SIGNAL REVIEW</h3>
              <span className="text-[8px] text-slate-600">RULE-BASED COMMENTARY</span>
            </div>
            {selected ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-black text-cyan-200">{selected.symbol}</p>
                  <SignalBadge direction={selected.direction} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-slate-900/80 p-2"><p className="text-[8px] text-slate-600">Score</p><p className="mt-1 text-xs font-black text-white">{selected.score}</p></div>
                  <div className="rounded-lg bg-slate-900/80 p-2"><p className="text-[8px] text-slate-600">Confidence</p><p className="mt-1 text-xs font-black text-white">{selected.confidence}%</p></div>
                  <div className="rounded-lg bg-slate-900/80 p-2"><p className="text-[8px] text-slate-600">RSI</p><p className="mt-1 text-xs font-black text-white">{Number(selected.rsi || 0).toFixed(1)}</p></div>
                </div>
                <div>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-slate-600">Scanner factors</p>
                  <p className="mt-1 text-[9px] leading-relaxed text-slate-400">{Array.isArray(selected.reasons) && selected.reasons.length ? selected.reasons.join(' · ') : 'No factor details returned.'}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070d17] p-3">
                  <p className="text-[8px] font-bold uppercase tracking-wider text-cyan-300">Rule-based interpretation</p>
                  <p className="mt-2 whitespace-pre-wrap text-[9px] leading-relaxed text-slate-300">{busyExplain ? 'Reviewing the signal…' : explain || 'No explanation received yet.'}</p>
                </div>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-slate-800 bg-slate-900/30 p-4 text-[9px] leading-relaxed text-slate-500">Select “Analyze” on a market row to inspect its factors and request a rule-based explanation. It is commentary, not a trade guarantee.</p>
            )}
          </div>
        </aside>
      </div>

      {/* Active paper position */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1320]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div>
            <h3 className="text-[10px] font-black tracking-[0.14em] text-white">ACTIVE PAPER POSITION</h3>
            <p className="mt-1 text-[9px] text-slate-500">Entry, stop and target levels from the scanner signal</p>
          </div>
          {activeTrade ? (
            <span className={`rounded-md border px-2 py-1 text-[8px] font-black ${activeTrade.side === 'BUY' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>
              {activeTrade.side === 'BUY' ? '▲ LONG' : '▼ SHORT'} · {activeTrade.symbol}
            </span>
          ) : (
            <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[8px] font-bold text-slate-500">NO OPEN POSITION</span>
          )}
        </div>

        {activeTrade ? (
          <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1fr_1.15fr]">
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-slate-600">Estimated net unrealized P&L</p>
                  <p className={`mt-1 text-2xl font-black tracking-tight ${unrealizedPnl === null ? 'text-slate-500' : unrealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {unrealizedPnl === null ? '—' : `${unrealizedPnl >= 0 ? '+' : ''}${formatPrice(unrealizedPnl)}`}
                  </p>
                </div>
                <div className="text-right"><p className="text-[8px] text-slate-600">Latest REST analysis price</p><p className="mt-1 text-sm font-bold text-white">{currentTradePrice ? formatPrice(currentTradePrice) : 'Waiting…'}</p></div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[8px] text-slate-600">Entry</p><p className="mt-1 text-[10px] font-bold text-white">{formatPrice(activeTrade.entry)}</p></div>
                <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[8px] text-slate-600">Stop loss</p><p className="mt-1 text-[10px] font-bold text-rose-300">{formatPrice(activeTrade.stop)}</p></div>
                <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[8px] text-slate-600">Take profit</p><p className="mt-1 text-[10px] font-bold text-emerald-300">{formatPrice(activeTrade.target)}</p></div>
                <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[8px] text-slate-600">Reward / risk</p><p className="mt-1 text-[10px] font-bold text-cyan-200">{riskReward.toFixed(2)} : 1</p></div>
              </div>
            </div>

            <div className="flex flex-col justify-center">
              <div className="flex items-center justify-between text-[8px] font-bold uppercase tracking-wider">
                <span className="text-rose-300">Stop</span>
                <span className="text-slate-500">Price progress to target</span>
                <span className="text-emerald-300">Target</span>
              </div>
              <div className="relative mt-4 h-2.5 rounded-full bg-rose-500/25">
                <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500/70 via-amber-400/70 to-emerald-400/80" style={{ width: `${progress * 100}%` }} />
                <div className="absolute top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.8)] transition-all duration-500" style={{ left: `${progress * 100}%` }} />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-[9px]">
                <span className="text-rose-300">{formatPrice(activeTrade.stop)}</span>
                <span className="font-bold text-cyan-200">{currentTradePrice ? `${(progress * 100).toFixed(0)}% of level range` : 'Awaiting quote'}</span>
                <span className="text-emerald-300">{formatPrice(activeTrade.target)}</span>
              </div>
              <p className="mt-4 text-[9px] leading-relaxed text-slate-500">Opened {formatTime(activeTrade.openedAt)} · {activeTrade.notional.toFixed(2)} USDT notional · estimated fee included in P&L. Active-symbol REST refresh: {activeQuoteFresh ? formatAge(activeQuoteUpdatedAt, clock).toLowerCase() : 'stale / waiting for refresh'}. {activeQuoteError ? `Refresh error: ${activeQuoteError}` : ''}</p>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center sm:p-8">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-lg text-slate-500">⌁</div>
            <p className="mt-3 text-[11px] font-bold text-slate-300">No active paper position</p>
            <p className="mx-auto mt-1 max-w-md text-[9px] leading-relaxed text-slate-500">The bot will only simulate an entry when a scanner signal passes all configured filters. No signal is not a reason to force a trade.</p>
          </div>
        )}
      </div>

      {/* Journal */}
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1320]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div>
            <h3 className="text-[10px] font-black tracking-[0.14em] text-white">PAPER TRADE JOURNAL</h3>
            <p className="mt-1 text-[9px] text-slate-500">Saved in this browser · latest 100 simulations</p>
          </div>
          <div className="flex items-center gap-3 text-[9px]">
            <span className="text-slate-500">{trades.length} records</span>
            <span className={realizedPnl >= 0 ? 'font-bold text-emerald-300' : 'font-bold text-rose-300'}>{realizedPnl >= 0 ? '+' : ''}{formatPrice(realizedPnl)} realized</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[740px] text-left text-[9px]">
            <thead className="bg-[#080e18] text-[8px] font-bold uppercase tracking-[0.12em] text-slate-600">
              <tr>
                <th className="px-4 py-3">Opened</th>
                <th className="px-3 py-3">Pair</th>
                <th className="px-3 py-3">Side</th>
                <th className="px-3 py-3">Entry</th>
                <th className="px-3 py-3">Exit / current</th>
                <th className="px-3 py-3">Notional</th>
                <th className="px-4 py-3 text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 12).map(trade => {
                const isOpen = trade.status === 'OPEN';
                const current = isOpen && trade.symbol === activeTrade?.symbol ? currentTradePrice : null;
                const result = isOpen
                  ? (current ? calculateNetPnl(trade, current) : null)
                  : trade.pnl ?? 0;
                return (
                  <tr key={trade.id} className="border-t border-slate-800/70">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatTime(trade.openedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-black text-white">{trade.symbol}</td>
                    <td className={`px-3 py-3 font-black ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.side}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-300">{formatPrice(trade.entry)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-300">{trade.exitPrice ? formatPrice(trade.exitPrice) : isOpen && current ? formatPrice(current) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-400">{trade.notional.toFixed(2)} USDT</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {isOpen ? (
                        <span className="font-bold text-amber-300">OPEN{result === null ? '' : ` · ${result >= 0 ? '+' : ''}${formatPrice(result)}`}</span>
                      ) : (
                        <span className={`font-bold ${result !== null && result >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.status} · {result !== null && result >= 0 ? '+' : ''}{formatPrice(result || 0)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!trades.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-[9px] text-slate-500">No paper trades yet. The journal will populate when a qualified setup is simulated.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-800/80 pt-4 text-[8px] leading-relaxed text-slate-600 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-3xl">Model note: score and confidence are scanner metrics, not verified win probabilities. Prices refresh through REST analysis (not a WebSocket tick stream). Paper P&L uses an estimated 0.08% round-trip fee; funding, spread, slippage and execution latency are not simulated.</p>
        <p className="shrink-0 font-bold uppercase tracking-wider text-slate-500">No Binance orders · Browser-side paper journal</p>
      </div>
    </section>
  );
}
