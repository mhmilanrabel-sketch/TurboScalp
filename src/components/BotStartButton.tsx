import React from 'react';
import { Play, RefreshCw } from 'lucide-react';

type BotStartButtonProps = {
  loading: boolean;
  accountLoading: boolean;
  canTrade: boolean;
  availableBalance: number | string;
  hasActiveTrade: boolean;
  paused: boolean;
  onStart: () => void;
};

/**
 * Keep Start clickable while the UI's account snapshot is stale or still
 * refreshing. The authenticated server remains the authoritative safety gate.
 */
export function BotStartButton({
  loading,
  accountLoading,
  canTrade,
  availableBalance,
  hasActiveTrade,
  paused,
  onStart,
}: BotStartButtonProps) {
  const available = Number(availableBalance);
  const hasPositiveBalance = Number.isFinite(available) && available > 0;

  let readinessMessage =
    'The server will re-check Binance Demo permissions, margin, position mode and open orders before any order is sent.';
  let warning = false;

  if (accountLoading) {
    readinessMessage =
      'Account refresh is running. Start remains clickable; the server will perform a fresh Binance pre-flight check.';
    warning = true;
  } else if (!canTrade) {
    readinessMessage =
      'The latest account snapshot reports Futures trading permission disabled. The server will verify again and return the exact reason; no order is sent unless every server check passes.';
    warning = true;
  } else if (!hasPositiveBalance) {
    readinessMessage =
      'Available USDT margin is zero or unavailable in the latest snapshot. The server will block execution unless fresh positive margin is confirmed.';
    warning = true;
  }

  const label = hasActiveTrade || paused
    ? 'RESUME / RECONCILE BOT'
    : 'START AUTONOMOUS DEMO BOT';

  return (
    <div className="min-w-[240px] flex-1 space-y-2">
      <button
        type="button"
        onClick={onStart}
        disabled={loading}
        aria-label={label}
        aria-busy={loading}
        title="Request a Binance Futures Demo bot start. Server-side safety checks remain enforced."
        className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-[9px] font-black text-slate-950 transition hover:bg-cyan-300 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
      >
        {loading ? <RefreshCw className="animate-spin" size={14} /> : <Play size={14} />}
        {loading ? 'CHECKING BINANCE & STARTING…' : label}
      </button>
      <p className={`px-1 text-[8px] leading-relaxed ${warning ? 'text-amber-200' : 'text-slate-500'}`}>
        {readinessMessage}
      </p>
      <p className="px-1 text-[7px] font-bold uppercase tracking-wider text-slate-600">
        Demo orders only · Backend pre-flight required · Live trading disabled
      </p>
    </div>
  );
}
