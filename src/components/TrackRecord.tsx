import React, { useState } from 'react';
import { ClosedSignal, PerformanceStats } from '../types';
import {
  BarChart3,
  TrendingUp,
  Award,
  Shield,
  Download,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
} from 'lucide-react';

interface TrackRecordProps {
  closedTrades: ClosedSignal[];
  stats: PerformanceStats;
}

export const TrackRecord: React.FC<TrackRecordProps> = ({ closedTrades, stats }) => {
  const [filter, setFilter] = useState<'ALL' | 'WINS' | 'LOSSES'>('ALL');

  const filteredTrades = closedTrades.filter((t) => {
    if (filter === 'WINS') return t.pnlPercentage > 0;
    if (filter === 'LOSSES') return t.pnlPercentage < 0;
    return true;
  });

  const exportCsv = () => {
    const headers = 'ID,Symbol,Direction,Entry,Exit,PnL%,PnL$,Outcome,Duration,Time\n';
    const rows = closedTrades
      .map(
        (t) =>
          `${t.id},${t.symbol},${t.direction},${t.entryPrice},${t.exitPrice},${t.pnlPercentage}%,$${t.pnlUsd},${t.outcome},${t.holdingTime},${t.closedAt}`
      )
      .join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `binance-turboscalp-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Generate SVG points for Equity Curve
  let cumulative = 0;
  const equityPoints: number[] = [0];
  closedTrades.forEach((t) => {
    cumulative += t.pnlPercentage;
    equityPoints.push(cumulative);
  });

  const minEquity = Math.min(0, ...equityPoints);
  const maxEquity = Math.max(10, ...equityPoints);
  const equityRange = (maxEquity - minEquity) || 1;
  const chartHeight = 120;
  const chartWidth = 500;

  const getSvgY = (val: number) => {
    return chartHeight - ((val - minEquity) / equityRange) * (chartHeight - 20) - 10;
  };

  const svgPolyline = equityPoints
    .map((val, idx) => {
      const x = (idx / Math.max(1, equityPoints.length - 1)) * chartWidth;
      const y = getSvgY(val);
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="space-y-4">
      {/* Top Performance Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Win Rate */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
            Win Rate
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-400 font-mono">
              {stats.winRate}%
            </span>
            <span className="text-xs text-slate-400">
              ({stats.winningSignals}/{stats.totalSignals})
            </span>
          </div>
        </div>

        {/* Profit Factor */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
            Profit Factor
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-amber-400 font-mono">
              {stats.profitFactor}
            </span>
            <span
              className={`text-xs font-semibold ${
                stats.profitFactor >= 2
                  ? 'text-emerald-400'
                  : stats.profitFactor >= 1
                  ? 'text-amber-400'
                  : 'text-slate-400'
              }`}
            >
              {stats.profitFactor >= 2 ? 'Pro Grade' : stats.profitFactor >= 1 ? 'Positive Edge' : 'Calibrating'}
            </span>
          </div>
        </div>

        {/* Net Realized Profit */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
            Net Realized PnL
          </span>
          <div className="flex items-baseline gap-2">
            <span
              className={`text-2xl font-black font-mono ${
                stats.netProfitUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {stats.netProfitUsd >= 0 ? '+' : ''}${stats.netProfitUsd.toFixed(2)}
            </span>
            <span className="text-xs text-slate-400">
              ({stats.netProfitPercentage >= 0 ? '+' : ''}{stats.netProfitPercentage}%)
            </span>
          </div>
        </div>

        {/* Max Drawdown */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
            Max Drawdown
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-200 font-mono">
              {stats.maxDrawdownPercentage}%
            </span>
            <span className="text-xs text-slate-500 font-medium">Controlled Risk</span>
          </div>
        </div>
      </div>

      {/* Equity Curve SVG Banner */}
      {equityPoints.length > 1 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span>Cumulative Performance Curve (Equity Growth)</span>
            </h3>
            <span
              className={`text-xs font-mono font-bold ${
                stats.netProfitPercentage >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {stats.netProfitPercentage >= 0 ? '+' : ''}{stats.netProfitPercentage}% Total Return
            </span>
          </div>
          <div className="w-full h-[120px] bg-slate-950 rounded-xl p-2 overflow-hidden border border-slate-800/80">
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-full preserve-3d"
            >
              <line
                x1={0}
                y1={getSvgY(0)}
                x2={chartWidth}
                y2={getSvgY(0)}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeWidth={1}
              />
              <polyline
                fill="none"
                stroke="#10b981"
                strokeWidth={2.5}
                points={svgPolyline}
              />
            </svg>
          </div>
        </div>
      )}

      {/* Filterable Trades History Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900/95">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Closed Positions Log</h3>
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-800 text-slate-300">
              {filteredTrades.length} Trades
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  filter === 'ALL' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setFilter('WINS')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  filter === 'WINS' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Wins
              </button>
              <button
                onClick={() => setFilter('LOSSES')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  filter === 'LOSSES' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Losses
              </button>
            </div>

            <button
              onClick={exportCsv}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center gap-1.5 transition-all border border-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] font-semibold tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Symbol</th>
                <th className="py-3 px-3">Direction</th>
                <th className="py-3 px-3">Entry</th>
                <th className="py-3 px-3">Exit</th>
                <th className="py-3 px-3">PnL (%)</th>
                <th className="py-3 px-3">PnL ($)</th>
                <th className="py-3 px-3">Outcome</th>
                <th className="py-3 px-3">Hold Time</th>
                <th className="py-3 px-4 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredTrades.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-slate-500">
                    No closed trades recorded yet.
                  </td>
                </tr>
              ) : (
                filteredTrades.map((trade) => {
                  const isWin = trade.pnlPercentage > 0;
                  return (
                    <tr key={trade.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-bold text-white">{trade.symbol}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                            trade.direction === 'BUY (LONG)'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-rose-500/10 text-rose-400'
                          }`}
                        >
                          {trade.direction === 'BUY (LONG)' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                          {trade.direction}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-300">${trade.entryPrice.toLocaleString()}</td>
                      <td className="py-3 px-3 font-mono text-slate-300">${trade.exitPrice.toLocaleString()}</td>
                      <td className="py-3 px-3 font-mono font-bold">
                        <span className={isWin ? 'text-emerald-400' : 'text-rose-400'}>
                          {isWin ? '+' : ''}{trade.pnlPercentage.toFixed(2)}%
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono font-bold">
                        <span className={isWin ? 'text-emerald-400' : 'text-rose-400'}>
                          {isWin ? '+' : ''}${trade.pnlUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            trade.outcome === 'TP1' || trade.outcome === 'TP2' || trade.outcome === 'TP3'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : trade.outcome === 'SL'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {trade.outcome}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-slate-400 font-mono text-[11px]">{trade.holdingTime}</td>
                      <td className="py-3 px-4 text-right text-slate-500 font-mono text-[11px]">{trade.closedAt}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
