
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

type PaperTrade = {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stop: number;
  target: number;
  notional: number;
  status: 'OPEN' | 'TP' | 'SL';
  pnl?: number;
};

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value)) return '—';

  return value < 1
    ? '$' + value.toPrecision(5)
    : '$' + value.toLocaleString('en-US', {
        maximumFractionDigits: 4,
      });
};

const compact = (value: number): string => {
  if (!Number.isFinite(value)) return '—';

  if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';

  return value.toFixed(0);
};

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    throw new Error(
      data.message || `Request failed (${response.status})`
    );
  }

  return data;
}

export function QuantAIEngine() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [markets, setMarkets] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('score');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [bot, setBot] = useState(false);
  const [size, setSize] = useState('25');
  const [maxOpen, setMaxOpen] = useState('3');

  const [trades, setTrades] = useState<PaperTrade[]>([]);

  const [selected, setSelected] = useState<Signal | null>(null);
  const [explain, setExplain] = useState('');
  const [busyExplain, setBusyExplain] = useState(false);

  const busy = useRef(false);
  const mounted = useRef(true);

  const scan = useCallback(async () => {
    if (busy.current) return;

    busy.current = true;
    setLoading(true);
    setError('');

    try {
      const [universeResponse, scanResponse] = await Promise.all([
        fetch('/api/quant/universe', {
          cache: 'no-store',
        }),
        fetch('/api/quant/scan?limit=40&minVolume=250000', {
          cache: 'no-store',
        }),
      ]);

      const [universeData, scanData] = await Promise.all([
        readJson(universeResponse),
        readJson(scanResponse),
      ]);

      if (!mounted.current) return;

      setMarkets(Number(universeData.count) || 0);
      setSignals(
        Array.isArray(scanData.signals)
          ? scanData.signals
          : []
      );
    } catch (err) {
      if (!mounted.current) return;

      setError(
        err instanceof Error
          ? err.message
          : 'Quant scanner unavailable'
      );
    } finally {
      busy.current = false;

      if (mounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;

    void scan();

    const interval = setInterval(() => {
      void scan();
    }, 60000);

    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [scan]);

  const rows = useMemo(() => {
    const filtered = signals.filter(signal =>
      signal.symbol.toLowerCase().includes(search.toLowerCase())
    );

    return filtered.sort((a, b) => {
      if (sort === 'volume') {
        return b.quoteVolume - a.quoteVolume;
      }

      if (sort === 'change') {
        return b.change24h - a.change24h;
      }

      return Math.abs(b.score) - Math.abs(a.score);
    });
  }, [signals, search, sort]);

  const openTrades = trades.filter(
    trade => trade.status === 'OPEN'
  );

  const closedTrades = trades.filter(
    trade => trade.status !== 'OPEN'
  );

  const totalPnl = closedTrades.reduce(
    (total, trade) => total + (trade.pnl || 0),
    0
  );

  const discuss = async (signal: Signal) => {
    setSelected(signal);
    setExplain('');
    setBusyExplain(true);

    try {
      const response = await fetch('/api/quant/discuss', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          analysis: signal,
        }),
      });

      const data = await readJson(response);

      setExplain(
        data.discussion ||
        data.message ||
        'No explanation available.'
      );
    } catch (err) {
      setExplain(
        err instanceof Error
          ? err.message
          : 'Unable to load signal explanation.'
      );
    } finally {
      setBusyExplain(false);
    }
  };

  useEffect(() => {
    if (!bot) return;

    const interval = setInterval(() => {
      setTrades(previous => {
        let next = previous.map(trade => {
          if (trade.status !== 'OPEN') return trade;

          const signal = signals.find(
            item => item.symbol === trade.symbol
          );

          if (!signal || signal.price <= 0) return trade;

          const hitStop =
            trade.side === 'BUY'
              ? signal.price <= trade.stop
              : signal.price >= trade.stop;

          const hitTarget =
            trade.side === 'BUY'
              ? signal.price >= trade.target
              : signal.price <= trade.target;

          if (!hitStop && !hitTarget) return trade;

          const exitPrice = hitStop
            ? trade.stop
            : trade.target;

          const movement =
            trade.side === 'BUY'
              ? (exitPrice - trade.entry) / trade.entry
              : (trade.entry - exitPrice) / trade.entry;

          return {
            ...trade,
            status: hitStop ? 'SL' : 'TP',
            pnl: trade.notional * movement,
          } as PaperTrade;
        });

        const currentOpen = next.filter(
          trade => trade.status === 'OPEN'
        ).length;

        const openLimit = Math.min(
          5,
          Math.max(1, Number(maxOpen) || 1)
        );

        if (currentOpen >= openLimit) {
          return next;
        }

        const candidate = signals.find(signal =>
          signal.direction !== 'NEUTRAL' &&
          Math.abs(signal.score) >= 55 &&
          signal.confidence >= 72 &&
          signal.volatilityPct > 0.03 &&
          signal.volatilityPct < 4 &&
          signal.price > 0 &&
          !next.some(
            trade =>
              trade.symbol === signal.symbol &&
              trade.status === 'OPEN'
          )
        );

        if (!candidate) return next;

        const side = candidate.direction as 'BUY' | 'SELL';

        const notional = Math.min(
          100,
          Math.max(5, Number(size) || 25)
        );

        const stop =
          candidate.stopLoss ||
          candidate.price * (side === 'BUY' ? 0.99 : 1.01);

        const target =
          candidate.takeProfit ||
          candidate.price * (side === 'BUY' ? 1.02 : 0.98);

        const newTrade: PaperTrade = {
          id: Date.now(),
          symbol: candidate.symbol,
          side,
          entry: candidate.price,
          stop,
          target,
          notional,
          status: 'OPEN',
        };

        return [newTrade, ...next].slice(0, 100);
      });
    }, 15000);

    return () => clearInterval(interval);
  }, [bot, signals, size, maxOpen]);

  return (
    <section className="rounded-2xl border border-cyan-500/25 bg-[#0d1726] p-4 md:p-5 space-y-4">

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-black tracking-widest text-cyan-300">
            QUANT AI LAB
          </h2>

          <p className="mt-1 text-[10px] text-slate-400">
            Binance USDⓈ-M USDT perpetual markets ·
            multi-factor 15m scanner
          </p>
        </div>

        <div className="flex gap-2">
          <span className="rounded bg-slate-900 px-3 py-2 text-[10px] text-cyan-300">
            {markets} pairs
          </span>

          <button
            onClick={() => void scan()}
            disabled={loading}
            className="rounded-lg border border-slate-700 px-3 py-2 text-[10px] disabled:opacity-50"
          >
            {loading ? 'SCANNING…' : 'RESCAN ↻'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          ['ANALYSED', signals.length],
          ['BUY', signals.filter(s => s.direction === 'BUY').length],
          ['SELL', signals.filter(s => s.direction === 'SELL').length],
          ['OPEN PAPER', openTrades.length],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded-lg border border-slate-800 bg-slate-900 p-3"
          >
            <p className="text-[9px] text-slate-500">{label}</p>
            <p className="mt-1 text-lg font-black text-white">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search any contract…"
          className="min-w-[180px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
        />

        <select
          value={sort}
          onChange={event => setSort(event.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
        >
          <option value="score">Strongest score</option>
          <option value="volume">Highest volume</option>
          <option value="change">24h change</option>
        </select>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[760px] text-left text-[10px]">
          <thead className="bg-slate-950 text-slate-500">
            <tr>
              {[
                'PAIR',
                'PRICE',
                '24H',
                'VOLUME',
                'RSI',
                'SCORE',
                'SIGNAL',
                'REVIEW',
              ].map(heading => (
                <th key={heading} className="p-3">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map(signal => (
              <tr
                key={signal.symbol}
                className="border-t border-slate-800"
              >
                <td className="p-3 font-bold text-white">
                  {signal.symbol}
                </td>

                <td className="p-3">
                  {formatPrice(signal.price)}
                </td>

                <td
                  className={`p-3 ${
                    signal.change24h >= 0
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }`}
                >
                  {signal.change24h.toFixed(2)}%
                </td>

                <td className="p-3">
                  {compact(signal.quoteVolume)}
                </td>

                <td className="p-3">
                  {signal.rsi.toFixed(1)}
                </td>

                <td className="p-3 font-bold">
                  {signal.score > 0 ? '+' : ''}
                  {signal.score}
                </td>

                <td
                  className={`p-3 font-bold ${
                    signal.direction === 'BUY'
                      ? 'text-emerald-400'
                      : signal.direction === 'SELL'
                        ? 'text-rose-400'
                        : 'text-slate-400'
                  }`}
                >
                  {signal.direction}
                </td>

                <td className="p-3">
                  <button
                    onClick={() => void discuss(signal)}
                    className="text-cyan-300 underline"
                  >
                    Discuss
                  </button>
                </td>
              </tr>
            ))}

            {!loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="p-6 text-center text-slate-500"
                >
                  No matching signals found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">

        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-3">
          <div className="flex justify-between">
            <h3 className="text-xs font-black text-white">
              AUTONOMOUS PAPER BOT
            </h3>

            <span className="text-[9px] text-amber-300">
              NO EXCHANGE ORDERS
            </span>
          </div>

          <p className="text-[10px] text-slate-400">
            Simulates entries from scanner signals every
            15 seconds. Uses scanner stop-loss and
            take-profit levels. Paper trading only.
            This does not submit Binance orders.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-slate-400">
              Notional / trade USDT
              <input
                type="number"
                min="5"
                max="100"
                value={size}
                onChange={event => setSize(event.target.value)}
                className="mt-1 w-full rounded bg-slate-900 p-2 text-white"
              />
            </label>

            <label className="text-[10px] text-slate-400">
              Max open trades
              <input
                type="number"
                min="1"
                max="5"
                value={maxOpen}
                onChange={event => setMaxOpen(event.target.value)}
                className="mt-1 w-full rounded bg-slate-900 p-2 text-white"
              />
            </label>
          </div>

          <button
            onClick={() => setBot(value => !value)}
            className={`w-full rounded-lg p-3 text-xs font-black ${
              bot
                ? 'border border-rose-500/40 bg-rose-500/10 text-rose-300'
                : 'bg-cyan-400 text-slate-950'
            }`}
          >
            {bot ? 'STOP PAPER BOT' : 'START PAPER BOT'}
          </button>

          <div className="flex justify-between text-[10px]">
            <span className="text-slate-400">
              Closed trades: {closedTrades.length}
            </span>

            <span
              className={
                totalPnl >= 0
                  ? 'text-emerald-300'
                  : 'text-rose-300'
              }
            >
              Simulated PnL: {formatPrice(totalPnl)}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-2">
          <h3 className="text-xs font-black text-white">
            AI / SIGNAL DISCUSSION
          </h3>

          {selected ? (
            <>
              <p className="text-sm font-bold text-cyan-300">
                {selected.symbol} · {selected.direction} ·
                score {selected.score}
              </p>

              <p className="text-[10px] text-slate-400">
                {selected.reasons.join(' · ')}
              </p>

              <p className="text-[10px] leading-relaxed text-slate-200">
                {busyExplain
                  ? 'Reviewing indicators…'
                  : explain}
              </p>
            </>
          ) : (
            <p className="text-[10px] text-slate-500">
              Choose Discuss on a signal to review its
              evidence and limitations.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 p-4">
        <h3 className="mb-2 text-xs font-black text-white">
          PAPER TRADE JOURNAL
        </h3>

        {trades.slice(0, 10).map(trade => (
          <div
            key={trade.id}
            className="flex flex-wrap justify-between gap-2 border-b border-slate-800 py-2 text-[10px]"
          >
            <span>
              {trade.symbol} {trade.side} ·
              {trade.notional} USDT
            </span>

            <span>
              Entry {formatPrice(trade.entry)} /
              SL {formatPrice(trade.stop)} /
              TP {formatPrice(trade.target)}
            </span>

            <span
              className={
                trade.status === 'OPEN'
                  ? 'text-amber-300'
                  : (trade.pnl || 0) >= 0
                    ? 'text-emerald-300'
                    : 'text-rose-300'
              }
            >
              {trade.status}
              {trade.pnl !== undefined
                ? ' · ' + formatPrice(trade.pnl)
                : ''}
            </span>
          </div>
        ))}

        {!trades.length && (
          <p className="text-[10px] text-slate-500">
            No simulated trades yet.
          </p>
        )}
      </div>

      <p className="text-[9px] leading-relaxed text-slate-500">
        Composite score uses EMA 9/21/50 trend, Wilder RSI,
        MACD momentum, 20-candle breakout, relative volume
        and ATR volatility. Score is not a probability.
        Backtest with fees, funding, slippage and
        out-of-sample data before risking capital.
      </p>

    </section>
  );
}
