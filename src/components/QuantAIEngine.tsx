import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Direction = 'BUY' | 'SELL' | 'NEUTRAL';
type Signal = {
  symbol: string;
  direction: Direction;
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

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const STORAGE_KEY = 'turboscalp.quant-paper-trades.v2';
const MIN_NOTIONAL = 5;
const MAX_NOTIONAL = 100;
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1) return `$${value.toPrecision(5)}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
};

const compact = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
};

const signedPercent = (value: number) => `${value > 0 ? '+' : ''}${Number(value || 0).toFixed(2)}%`;

const formatTime = (timestamp?: number) => timestamp
  ? new Date(timestamp).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

const formatAge = (timestamp: number, now: number) => {
  if (!timestamp) return 'Waiting for first scan';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
};

const calculateNetPnl = (trade: PaperTrade, price: number) => {
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
    throw new Error(data.message || data.error || `Request failed (${response.status})`);
  }
  return data;
}

function SignalBadge({ direction }: { direction: Direction }) {
  const tone = direction === 'BUY'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : direction === 'SELL'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
      : 'border-slate-700 bg-slate-800 text-slate-400';
  return <span className={`inline-flex min-w-[58px] justify-center rounded-md border px-2 py-1 text-[8px] font-black tracking-wide ${tone}`}>{direction}</span>;
}

function Metric({
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
    <div className="min-w-0 rounded-xl border border-slate-800 bg-[#0b1421] p-3.5 sm:p-4">
      <p className="text-[8px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-2 truncate text-xl font-black tracking-tight sm:text-2xl ${tone}`}>{value}</p>
      <p className="mt-1 truncate text-[9px] text-slate-600">{detail}</p>
    </div>
  );
}

function CandlestickChart({
  candles,
  trade,
  currentPrice,
}: {
  candles: Candle[];
  trade: PaperTrade | null;
  currentPrice: number | null;
}) {
  const width = 1000;
  const height = 340;
  const left = 58;
  const right = 870;
  const top = 20;
  const bottom = 282;
  const plotWidth = right - left;
  const plotHeight = bottom - top;

  if (!candles.length) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-slate-800 bg-[#080f1b] text-center">
        <div><p className="text-[11px] font-bold text-slate-300">Waiting for Demo candle data</p><p className="mt-2 text-[9px] text-slate-600">The 15-minute chart will appear after the first successful candle request.</p></div>
      </div>
    );
  }

  const prices = candles.flatMap(candle => [candle.low, candle.high]);
  if (trade) prices.push(trade.stop, trade.entry, trade.target);
  if (currentPrice && currentPrice > 0) prices.push(currentPrice);
  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  const spread = Math.max(maxPrice - minPrice, maxPrice * 0.001, Number.EPSILON);
  minPrice -= spread * 0.08;
  maxPrice += spread * 0.08;
  const y = (price: number) => bottom - ((price - minPrice) / (maxPrice - minPrice)) * plotHeight;
  const step = plotWidth / Math.max(candles.length, 1);
  const bodyWidth = clamp(step * 0.56, 3, 10);

  const levels = trade ? [
    { key: 'stop', label: 'STOP', value: trade.stop, stroke: '#fb7185', dash: '5 5' },
    { key: 'entry', label: 'ENTRY', value: trade.entry, stroke: '#38bdf8', dash: '3 5' },
    { key: 'target', label: 'TARGET', value: trade.target, stroke: '#34d399', dash: '5 5' },
  ] : [];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#080f1b] p-2 sm:p-3">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Binance Demo 15 minute candlestick chart with paper trade entry, stop and target levels" className="h-auto w-full">
        {[0, 1, 2, 3, 4].map(index => {
          const value = maxPrice - ((maxPrice - minPrice) * index) / 4;
          const yy = top + (plotHeight * index) / 4;
          return (
            <g key={`grid-${index}`}>
              <line x1={left} x2={right} y1={yy} y2={yy} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 6" />
              <text x="884" y={yy + 3} fill="#64748b" fontSize="10">{formatPrice(value)}</text>
            </g>
          );
        })}

        {candles.map((candle, index) => {
          const x = left + step * index + step / 2;
          const rising = candle.close >= candle.open;
          const color = rising ? '#34d399' : '#fb7185';
          const openY = y(candle.open);
          const closeY = y(candle.close);
          const bodyY = Math.min(openY, closeY);
          const bodyHeight = Math.max(2, Math.abs(closeY - openY));
          return (
            <g key={`${candle.time}-${index}`} className="transition-all duration-500">
              <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1.4" />
              <rect x={x - bodyWidth / 2} y={bodyY} width={bodyWidth} height={bodyHeight} rx="1" fill={color} opacity="0.88" />
              {index === candles.length - 1 && <circle cx={x} cy={y(candle.close)} r="4" fill={color} className="animate-pulse" />}
            </g>
          );
        })}

        {levels.map(level => (
          <g key={level.key}>
            <line x1={left} x2={right} y1={y(level.value)} y2={y(level.value)} stroke={level.stroke} strokeWidth="1.3" strokeDasharray={level.dash} opacity="0.95" />
            <text x="884" y={y(level.value) - 5} fill={level.stroke} fontSize="9" fontWeight="700">{level.label}</text>
          </g>
        ))}

        {currentPrice && currentPrice > 0 && (
          <g>
            <line x1={left} x2={right} y1={y(currentPrice)} y2={y(currentPrice)} stroke="#22d3ee" strokeWidth="1" strokeDasharray="2 4" opacity="0.8" />
            <circle cx={right} cy={y(currentPrice)} r="3.5" fill="#22d3ee" className="animate-pulse" />
            <text x="884" y={y(currentPrice) + 11} fill="#67e8f9" fontSize="9" fontWeight="700">LAST</text>
          </g>
        )}

        <text x={left} y="318" fill="#64748b" fontSize="10">{new Date(candles[0].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>
        <text x={right} y="318" textAnchor="end" fill="#64748b" fontSize="10">{new Date(candles[candles.length - 1].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 pb-1 text-[8px] font-bold uppercase tracking-wider text-slate-600">
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-emerald-400" /> Bullish</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-rose-400" /> Bearish</span>
        <span className="flex items-center gap-1.5"><i className="h-px w-4 bg-cyan-300" /> Latest</span>
        {trade && <><span className="text-sky-300">Entry</span><span className="text-rose-300">Stop</span><span className="text-emerald-300">Target</span></>}
      </div>
    </div>
  );
}

export function QuantAIEngine() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [marketCount, setMarketCount] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [lastScanAt, setLastScanAt] = useState(0);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'score' | 'confidence' | 'volume' | 'change'>('score');
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');

  const [bot, setBot] = useState(false);
  const [notional, setNotional] = useState('25');
  const [botMessage, setBotMessage] = useState('Paused. Start the paper bot to allow one qualified simulated position at a time.');
  const [trades, setTrades] = useState<PaperTrade[]>(loadPaperTrades);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');
  const [chartUpdatedAt, setChartUpdatedAt] = useState(0);
  const [activeQuoteUpdatedAt, setActiveQuoteUpdatedAt] = useState(0);
  const [activeQuoteError, setActiveQuoteError] = useState('');
  const [clock, setClock] = useState(Date.now());

  const scanBusy = useRef(false);
  const processedScanAt = useRef(0);

  const scan = useCallback(async () => {
    if (scanBusy.current) return;
    scanBusy.current = true;
    setScanLoading(true);
    setScanError('');
    try {
      const [universeResponse, scanResponse] = await Promise.all([
        fetch('/api/quant/universe', { cache: 'no-store' }),
        fetch('/api/quant/scan?limit=40&minVolume=250000', { cache: 'no-store' }),
      ]);
      const [universeData, scanData] = await Promise.all([
        readJson(universeResponse),
        readJson(scanResponse),
      ]);
      const nextSignals = Array.isArray(scanData.signals) ? scanData.signals as Signal[] : [];
      setMarketCount(Number(universeData.count) || 0);
      setScannedCount(Number(scanData.scannedCount) || nextSignals.length);
      setSignals(nextSignals);
      setLastScanAt(Date.now());
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Market scan unavailable.');
    } finally {
      scanBusy.current = false;
      setScanLoading(false);
    }
  }, []);

  // The entire UI uses this one scanner. It refreshes automatically; there is
  // deliberately no second/manual scanner button elsewhere in the dashboard.
  useEffect(() => {
    void scan();
    const timer = window.setInterval(() => void scan(), bot ? 30_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [scan, bot]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades.slice(0, 100)));
    } catch {
      // The paper journal remains available for the current page session.
    }
  }, [trades]);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = signals.filter(signal => signal.symbol.toLowerCase().includes(query));
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
  const chartSymbol = activeTrade?.symbol || selectedSymbol || signals[0]?.symbol || 'BTCUSDT';
  const chartSignal = signals.find(signal => signal.symbol === chartSymbol) || null;
  const currentPrice = chartSignal?.price || candles[candles.length - 1]?.close || null;
  const activePnl = activeTrade && currentPrice ? calculateNetPnl(activeTrade, currentPrice) : null;

  const buyCount = signals.filter(signal => signal.direction === 'BUY').length;
  const sellCount = signals.filter(signal => signal.direction === 'SELL').length;
  const realizedPnl = closedTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const wins = closedTrades.filter(trade => (trade.pnl || 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : null;
  const scanFresh = !!lastScanAt && clock - lastScanAt < 90_000;

  // Refresh the displayed chart automatically. The current paper symbol gets
  // the faster update cadence while a position is open.
  useEffect(() => {
    let cancelled = false;
    const loadCandles = async (initial = false) => {
      if (initial) setChartLoading(true);
      try {
        const response = await fetch(`/api/quant/candles/${encodeURIComponent(chartSymbol)}?limit=80`, { cache: 'no-store' });
        const data = await readJson(response);
        if (cancelled) return;
        const next = Array.isArray(data.candles) ? data.candles as Candle[] : [];
        setCandles(next);
        setChartUpdatedAt(Date.now());
        setChartError('');
      } catch (error) {
        if (!cancelled) setChartError(error instanceof Error ? error.message : 'Chart data unavailable.');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    };

    void loadCandles(true);
    const timer = window.setInterval(() => void loadCandles(false), activeTrade ? 10_000 : 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `candles.length` is intentionally not a dependency; the chart refresh loop
    // is controlled by the selected symbol and the active-position state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartSymbol, Boolean(activeTrade)]);

  // Re-analyse an open symbol more frequently than the full market scan so its
  // simulated exit and displayed P&L do not depend on its scanner rank.
  useEffect(() => {
    if (!activeTrade) {
      setActiveQuoteUpdatedAt(0);
      setActiveQuoteError('');
      return;
    }

    let cancelled = false;
    const refreshActiveSymbol = async () => {
      try {
        const response = await fetch(`/api/quant/analyze/${encodeURIComponent(activeTrade.symbol)}`, { cache: 'no-store' });
        const data = await readJson(response);
        if (cancelled || !data.signal) return;
        setSignals(previous => {
          const withoutActive = previous.filter(item => item.symbol !== activeTrade.symbol);
          return [data.signal as Signal, ...withoutActive]
            .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
            .slice(0, 40);
        });
        setActiveQuoteUpdatedAt(Date.now());
        setActiveQuoteError('');
      } catch (error) {
        if (!cancelled) setActiveQuoteError(error instanceof Error ? error.message : 'Active price refresh failed.');
      }
    };

    void refreshActiveSymbol();
    const timer = window.setInterval(() => void refreshActiveSymbol(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTrade?.symbol]);

  // Close a paper position when a fresh observed Demo quote reaches SL or TP.
  useEffect(() => {
    if (!signals.length) return;
    const quoteBySymbol = new Map(signals.map(signal => [signal.symbol, signal.price]));
    const observedAt = Date.now();
    setTrades(previous => previous.map(trade => {
      if (trade.status !== 'OPEN') return trade;
      const price = quoteBySymbol.get(trade.symbol);
      if (!price || !Number.isFinite(price) || price <= 0) return trade;
      const hitStop = trade.side === 'BUY' ? price <= trade.stop : price >= trade.stop;
      const hitTarget = trade.side === 'BUY' ? price >= trade.target : price <= trade.target;
      if (!hitStop && !hitTarget) return trade;
      return {
        ...trade,
        status: hitStop ? 'SL' : 'TP',
        exitPrice: price,
        closedAt: observedAt,
        pnl: calculateNetPnl(trade, price),
      };
    }));
  }, [signals]);

  // Evaluate entries once per completed scanner refresh only. One open paper
  // position across the whole bot, with a symbol cooldown to avoid rapid repeats.
  useEffect(() => {
    if (!bot || !lastScanAt || !signals.length || processedScanAt.current === lastScanAt) return;
    processedScanAt.current = lastScanAt;
    const observedAt = Date.now();
    setBotMessage('Bot is running. Reviewing the latest automatic scan for a qualified setup.');

    setTrades(previous => {
      if (previous.some(trade => trade.status === 'OPEN')) return previous;
      const lastClosedAt = previous.reduce((latest, trade) => Math.max(latest, trade.closedAt || 0), 0);
      if (lastClosedAt && observedAt - lastClosedAt < REENTRY_PAUSE_MS) return previous;

      const coolingSymbols = new Set(previous
        .filter(trade => trade.closedAt && observedAt - trade.closedAt < COOLDOWN_MS)
        .map(trade => trade.symbol));

      const candidates = signals.filter(signal => {
        if (signal.direction === 'NEUTRAL' || signal.price <= 0) return false;
        if (Math.abs(signal.score) < MIN_SCORE || signal.confidence < MIN_CONFIDENCE) return false;
        if (signal.quoteVolume < MIN_VOLUME || coolingSymbols.has(signal.symbol)) return false;
        if (signal.volatilityPct < MIN_VOLATILITY || signal.volatilityPct > MAX_VOLATILITY) return false;
        const stop = Number(signal.stopLoss);
        const target = Number(signal.takeProfit);
        if (!Number.isFinite(stop) || !Number.isFinite(target)) return false;

        const isLong = signal.direction === 'BUY';
        const levelsValid = isLong
          ? stop < signal.price && target > signal.price
          : target < signal.price && stop > signal.price;
        if (!levelsValid) return false;

        const risk = Math.abs(signal.price - stop);
        const reward = Math.abs(target - signal.price);
        const stopDistance = risk / signal.price;
        const rewardRisk = reward / Math.max(risk, Number.EPSILON);
        return stopDistance >= MIN_STOP_DISTANCE &&
          stopDistance <= MAX_STOP_DISTANCE &&
          rewardRisk >= MIN_REWARD_RISK;
      });

      candidates.sort((a, b) =>
        (Math.abs(b.score) * 0.65 + b.confidence * 0.35) -
        (Math.abs(a.score) * 0.65 + a.confidence * 0.35)
      );

      const candidate = candidates[0];
      if (!candidate) {
        return previous;
      }

      const value = clamp(Number(notional) || 25, MIN_NOTIONAL, MAX_NOTIONAL);
      const nextTrade: PaperTrade = {
        id: `${observedAt}-${candidate.symbol}`,
        symbol: candidate.symbol,
        side: candidate.direction as 'BUY' | 'SELL',
        entry: candidate.price,
        stop: Number(candidate.stopLoss),
        target: Number(candidate.takeProfit),
        notional: value,
        status: 'OPEN',
        openedAt: observedAt,
      };
      return [nextTrade, ...previous].slice(0, 100);
    });
  }, [bot, lastScanAt, signals, notional]);

  useEffect(() => {
    if (activeTrade) {
      setBotMessage(`Paper position open: ${activeTrade.symbol} ${activeTrade.side}. No Binance order was sent.`);
    }
  }, [activeTrade?.id]);

  const toggleBot = () => {
    if (bot) {
      setBot(false);
      setBotMessage('New entries paused. Any existing paper position continues to be monitored while this page is open.');
    } else {
      // Require a new scan after start, rather than entering from an old snapshot.
      processedScanAt.current = lastScanAt;
      setBot(true);
      setBotMessage('Bot started. Waiting for the next automatic scan to find a qualified setup.');
    }
  };

  const riskReward = activeTrade
    ? Math.abs(activeTrade.target - activeTrade.entry) / Math.max(Math.abs(activeTrade.entry - activeTrade.stop), Number.EPSILON)
    : 0;
  const progress = activeTrade && currentPrice
    ? activeTrade.side === 'BUY'
      ? clamp((currentPrice - activeTrade.stop) / (activeTrade.target - activeTrade.stop), 0, 1)
      : clamp((activeTrade.stop - currentPrice) / (activeTrade.stop - activeTrade.target), 0, 1)
    : 0;
  const chartAge = chartUpdatedAt ? formatAge(chartUpdatedAt, clock) : 'Waiting for chart';
  const scannerIntervalLabel = bot ? '30s' : '60s';

  return (
    <section className="relative space-y-5 overflow-hidden rounded-[24px] border border-slate-800 bg-[#080f1b] p-3 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.25)] sm:p-5 lg:p-6">
      <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-cyan-500/[0.06] blur-3xl" />

      <div className="relative flex flex-col justify-between gap-4 border-b border-slate-800/90 pb-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.75)]" />
            <p className="text-[8px] font-black uppercase tracking-[0.24em] text-cyan-300">Single scanner · Single chart · Paper-only execution</p>
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">QUANT AI LAB</h2>
          <p className="mt-1 text-[9px] leading-relaxed text-slate-500">Binance USD-M Futures Demo market data · USDT perpetuals · 15-minute technical analysis</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[8px] font-black tracking-wide ${scanFresh ? 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300' : 'border-amber-500/25 bg-amber-500/[0.07] text-amber-300'}`}>
            <i className={`h-1.5 w-1.5 rounded-full ${scanFresh ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {scanLoading ? 'SCANNING' : scanFresh ? 'AUTO SCAN ACTIVE' : 'WAITING FOR SCAN'}
          </span>
          <span className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[8px] font-bold text-slate-400">NEXT CYCLE · {scannerIntervalLabel}</span>
        </div>
      </div>

      <div className="relative grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Metric label="Demo markets" value={compact(marketCount)} detail="USDⓈ-M perpetual universe" />
        <Metric label="Markets scanned" value={String(scannedCount)} detail="Latest 15m scanner pass" />
        <Metric label="Buy signals" value={String(buyCount)} detail="EMA · RSI · MACD · volume" tone="text-emerald-300" />
        <Metric label="Sell signals" value={String(sellCount)} detail="EMA · RSI · MACD · volume" tone="text-rose-300" />
        <Metric label="Open paper trades" value={`${openTrades.length}/1`} detail="One position maximum" tone="text-cyan-200" />
      </div>

      {scanError && <div className="relative rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-3 text-[9px] text-rose-200">Scanner error: {scanError}</div>}

      <div className="relative grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)]">
        <div className="min-w-0 rounded-2xl border border-slate-800 bg-[#0b1421] p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[10px] font-black tracking-[0.14em] text-white">DEMO PRICE CHART</h3>
                <span className="rounded bg-slate-800 px-2 py-1 text-[7px] font-bold text-slate-400">15M CANDLES</span>
              </div>
              <p className="mt-1 text-[8px] text-slate-600">{chartSymbol} · Binance USD-M Futures Demo · {chartAge.toLowerCase()}</p>
            </div>
            <div className="text-right">
              <p className="text-[8px] uppercase tracking-wider text-slate-600">Latest observed price</p>
              <p className="mt-1 text-base font-black text-white">{currentPrice ? formatPrice(currentPrice) : '—'}</p>
              {chartSignal && <p className={`mt-1 text-[8px] font-bold ${chartSignal.change24h >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{signedPercent(chartSignal.change24h)} · 24H</p>}
            </div>
          </div>
          {chartLoading && candles.length === 0 ? (
            <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-slate-800 bg-[#080f1b] text-[9px] text-slate-500">Loading Demo candles…</div>
          ) : (
            <CandlestickChart candles={candles} trade={activeTrade?.symbol === chartSymbol ? activeTrade : null} currentPrice={currentPrice} />
          )}
          {chartError && <p className="mt-2 text-[8px] text-rose-300">Chart feed: {chartError}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[8px] text-slate-600">
            <span>Chart auto-refresh: {activeTrade ? '10 seconds' : '30 seconds'}</span>
            <span>{chartLoading ? 'Updating chart…' : 'Automatic updates enabled'}</span>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <div className="rounded-2xl border border-cyan-500/20 bg-[linear-gradient(145deg,rgba(8,35,49,0.65),rgba(11,20,33,0.98)_58%)] p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-[8px] font-black uppercase tracking-[0.18em] text-cyan-300">Autonomous paper engine</p><h3 className="mt-1 text-sm font-black text-white">PAPER BOT</h3></div>
              <span className={`rounded-md border px-2 py-1 text-[8px] font-black ${bot ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>{bot ? '● RUNNING' : '○ PAUSED'}</span>
            </div>
            <p className="mt-3 text-[9px] leading-relaxed text-slate-400">One simulated position maximum. The bot waits for every filter to pass and never submits Binance exchange orders.</p>
            <label className="mt-4 block text-[8px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Paper notional · USDT
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-[#070d17] px-3">
                <span className="text-xs font-bold text-slate-500">$</span>
                <input type="number" min={MIN_NOTIONAL} max={MAX_NOTIONAL} step="1" value={notional} disabled={bot} onChange={event => setNotional(event.target.value)} className="w-full bg-transparent py-2.5 text-xs font-bold text-white outline-none disabled:opacity-60" />
                <span className="text-[8px] text-slate-600">5–100</span>
              </div>
            </label>
            <button onClick={toggleBot} className={`mt-4 w-full rounded-xl px-4 py-3 text-[9px] font-black tracking-[0.14em] transition ${bot ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15' : 'bg-cyan-400 text-[#04111a] shadow-[0_8px_26px_rgba(34,211,238,0.12)] hover:bg-cyan-300'}`}>
              {bot ? 'PAUSE NEW PAPER ENTRIES' : 'START AUTONOMOUS PAPER BOT →'}
            </button>
            <p className="mt-3 min-h-[30px] text-[8px] leading-relaxed text-slate-500">{botMessage}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-700/70 pt-3">
              <div><p className="text-[7px] uppercase tracking-wider text-slate-600">Closed trades</p><p className="mt-1 text-lg font-black text-white">{closedTrades.length}</p></div>
              <div><p className="text-[7px] uppercase tracking-wider text-slate-600">Win rate</p><p className="mt-1 text-lg font-black text-cyan-200">{winRate === null ? '—' : `${winRate.toFixed(1)}%`}</p></div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-[#0b1421] p-4">
            <div className="flex items-center justify-between gap-2"><h3 className="text-[9px] font-black tracking-[0.14em] text-white">ACTIVE PAPER POSITION</h3><span className="text-[7px] text-slate-600">{activeTrade ? 'MONITORING' : 'NO POSITION'}</span></div>
            {activeTrade ? (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2"><div><p className="text-sm font-black text-white">{activeTrade.symbol}</p><p className={`mt-1 text-[8px] font-black ${activeTrade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{activeTrade.side === 'BUY' ? 'LONG / BUY' : 'SHORT / SELL'} · {activeTrade.notional.toFixed(2)} USDT</p></div><SignalBadge direction={activeTrade.side} /></div>
                <div><p className="text-[8px] text-slate-600">ESTIMATED NET OPEN P&L</p><p className={`mt-1 text-2xl font-black ${activePnl === null ? 'text-slate-500' : activePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{activePnl === null ? '—' : `${activePnl >= 0 ? '+' : ''}${formatPrice(activePnl)}`}</p></div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[7px] text-slate-600">ENTRY</p><p className="mt-1 text-[9px] font-bold text-white">{formatPrice(activeTrade.entry)}</p></div>
                  <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[7px] text-slate-600">CURRENT</p><p className="mt-1 text-[9px] font-bold text-cyan-200">{currentPrice ? formatPrice(currentPrice) : '—'}</p></div>
                  <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[7px] text-slate-600">STOP LOSS</p><p className="mt-1 text-[9px] font-bold text-rose-300">{formatPrice(activeTrade.stop)}</p></div>
                  <div className="rounded-lg bg-[#070d17] p-2.5"><p className="text-[7px] text-slate-600">TAKE PROFIT</p><p className="mt-1 text-[9px] font-bold text-emerald-300">{formatPrice(activeTrade.target)}</p></div>
                </div>
                <div className="flex items-center justify-between text-[7px] font-bold uppercase tracking-wider"><span className="text-rose-300">SL</span><span className="text-slate-600">Price range to target</span><span className="text-emerald-300">TP</span></div>
                <div className="relative h-2 overflow-hidden rounded-full bg-slate-800"><div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 transition-all duration-700" style={{ width: `${progress * 100}%` }} /><span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.9)] transition-all duration-700" style={{ left: `${progress * 100}%` }} /></div>
                <div className="flex justify-between text-[8px]"><span className="text-rose-300">{formatPrice(activeTrade.stop)}</span><span className="font-bold text-cyan-200">R:R {riskReward.toFixed(2)} : 1</span><span className="text-emerald-300">{formatPrice(activeTrade.target)}</span></div>
                <p className="text-[8px] leading-relaxed text-slate-600">Opened {formatTime(activeTrade.openedAt)} · quote check {activeQuoteUpdatedAt ? formatAge(activeQuoteUpdatedAt, clock).toLowerCase() : 'waiting'}{activeQuoteError ? ` · ${activeQuoteError}` : ''}</p>
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-slate-800 px-3 py-6 text-center"><p className="text-[10px] font-bold text-slate-300">No open paper position</p><p className="mt-2 text-[8px] leading-relaxed text-slate-600">Start the bot to let it wait for a filtered setup. It will not force an entry when conditions are weak.</p></div>
            )}
          </div>
        </aside>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1421]">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-800 p-4 sm:flex-row sm:items-center sm:px-5">
          <div><div className="flex items-center gap-2"><h3 className="text-[10px] font-black tracking-[0.14em] text-white">MARKET SCANNER</h3><span className="rounded bg-slate-800 px-2 py-1 text-[7px] font-bold text-slate-400">{rows.length} RESULTS</span></div><p className="mt-1 text-[8px] text-slate-600">Single 15-minute scanner · click a market to load its chart</p></div>
          <div className="flex gap-2">
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search pair…" className="min-w-0 w-full rounded-lg border border-slate-700 bg-[#070d17] px-3 py-2 text-[9px] text-white outline-none placeholder:text-slate-600 focus:border-cyan-500/60 sm:w-36" />
            <select value={sort} onChange={event => setSort(event.target.value as typeof sort)} className="rounded-lg border border-slate-700 bg-[#070d17] px-2 py-2 text-[9px] text-slate-300 outline-none focus:border-cyan-500/60"><option value="score">Score</option><option value="confidence">Confidence</option><option value="volume">Volume</option><option value="change">24h</option></select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[740px] text-left text-[9px]">
            <thead className="bg-[#080f1b] text-[7px] font-bold uppercase tracking-[0.13em] text-slate-600"><tr><th className="px-4 py-3">Market</th><th className="px-3 py-3">Price</th><th className="px-3 py-3">24h</th><th className="px-3 py-3">Quote volume</th><th className="px-3 py-3">RSI</th><th className="px-3 py-3">Score</th><th className="px-3 py-3">Signal</th><th className="px-4 py-3 text-right">Chart</th></tr></thead>
            <tbody>
              {rows.map(signal => (
                <tr key={signal.symbol} onClick={() => setSelectedSymbol(signal.symbol)} className={`cursor-pointer border-t border-slate-800/70 transition hover:bg-cyan-500/[0.04] ${chartSymbol === signal.symbol ? 'bg-cyan-500/[0.04]' : ''}`}>
                  <td className="whitespace-nowrap px-4 py-3"><p className="font-black text-white">{signal.symbol}</p><p className="mt-1 text-[7px] text-slate-600">{Number(signal.confidence || 0).toFixed(0)} heuristic confidence</p></td>
                  <td className="whitespace-nowrap px-3 py-3 font-bold text-slate-200">{formatPrice(signal.price)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 font-bold ${signal.change24h >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{signedPercent(signal.change24h)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{compact(signal.quoteVolume)}</td>
                  <td className="px-3 py-3 text-slate-400">{Number(signal.rsi || 0).toFixed(1)}</td>
                  <td className="px-3 py-3"><p className="font-black text-slate-200">{signal.score > 0 ? '+' : ''}{signal.score}</p><div className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${signal.direction === 'BUY' ? 'bg-emerald-400' : signal.direction === 'SELL' ? 'bg-rose-400' : 'bg-slate-500'}`} style={{ width: `${clamp(Math.abs(signal.score), 0, 100)}%` }} /></div></td>
                  <td className="px-3 py-3"><SignalBadge direction={signal.direction} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-right"><span className="text-[8px] font-bold text-cyan-300">{chartSymbol === signal.symbol ? 'SELECTED' : 'VIEW CHART ↗'}</span></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-[9px] text-slate-500">{scanLoading ? 'Scanning Demo markets…' : 'No matching signals found.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-3 text-[8px] text-slate-600"><span>{formatAge(lastScanAt, clock)}</span><span>Automatic scan every {scannerIntervalLabel} · no duplicate scanner</span><span>15m technical signals · not predictions</span></div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1421]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div><h3 className="text-[10px] font-black tracking-[0.14em] text-white">PAPER TRADE JOURNAL</h3><p className="mt-1 text-[8px] text-slate-600">Saved in this browser · latest 100 simulated trades</p></div>
          <div className="flex items-center gap-3 text-[8px]"><span className="text-slate-500">{trades.length} records</span><span className={`font-bold ${realizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{realizedPnl >= 0 ? '+' : ''}{formatPrice(realizedPnl)} realized</span></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[8px]">
            <thead className="bg-[#080f1b] text-[7px] font-bold uppercase tracking-[0.12em] text-slate-600"><tr><th className="px-4 py-3">Opened</th><th className="px-3 py-3">Market</th><th className="px-3 py-3">Side</th><th className="px-3 py-3">Entry</th><th className="px-3 py-3">Exit / current</th><th className="px-3 py-3">Notional</th><th className="px-4 py-3 text-right">Result</th></tr></thead>
            <tbody>
              {trades.slice(0, 12).map(trade => {
                const isOpen = trade.status === 'OPEN';
                const mark = isOpen && trade.symbol === activeTrade?.symbol ? currentPrice : null;
                const pnl = isOpen ? (mark ? calculateNetPnl(trade, mark) : null) : trade.pnl ?? 0;
                return (
                  <tr key={trade.id} className="border-t border-slate-800/70">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatTime(trade.openedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-black text-white">{trade.symbol}</td>
                    <td className={`px-3 py-3 font-black ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.side}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-300">{formatPrice(trade.entry)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-300">{trade.exitPrice ? formatPrice(trade.exitPrice) : isOpen && mark ? formatPrice(mark) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-400">{trade.notional.toFixed(2)} USDT</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">{isOpen ? <span className="font-bold text-amber-300">OPEN{pnl === null ? '' : ` · ${pnl >= 0 ? '+' : ''}${formatPrice(pnl)}`}</span> : <span className={`font-bold ${(pnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.status} · {(pnl || 0) >= 0 ? '+' : ''}{formatPrice(pnl || 0)}</span>}</td>
                  </tr>
                );
              })}
              {!trades.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-[9px] text-slate-500">No paper trades yet. The journal will update when a qualified setup is simulated.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-2 border-t border-slate-800/80 pt-4 text-[8px] leading-relaxed text-slate-600 sm:flex-row">
        <p className="max-w-4xl">Model note: score and confidence are technical heuristics, not verified win probabilities. Paper P&L includes an estimated 0.08% round-trip fee. Funding, spread, slippage and order execution latency are not simulated. Data refresh and paper monitoring require this browser page to remain open.</p>
        <p className="shrink-0 font-bold uppercase tracking-wider text-slate-500">No exchange orders · Local paper journal</p>
      </div>
    </section>
  );
}