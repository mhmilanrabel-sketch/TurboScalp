import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { FuturesPermissionDiagnostics } from '../utils/permissionDiagnostics';

interface PermissionDiagnosticsCardProps {
  apiConnected: boolean;
  canTrade: boolean;
  diagnostics: FuturesPermissionDiagnostics | null;
  checking: boolean;
  onCheckPermission: () => void | Promise<void>;
  compact?: boolean;
}

export const PermissionDiagnosticsCard: React.FC<PermissionDiagnosticsCardProps> = ({
  apiConnected,
  canTrade,
  diagnostics,
  checking,
  onCheckPermission,
  compact = false,
}) => {
  const authenticated = diagnostics
    ? diagnostics.apiAuthenticated
    : apiConnected;
  const effectiveCanTrade = diagnostics ? diagnostics.canTrade : canTrade;
  const orderTestPassed = Boolean(diagnostics?.orderTestPassed);

  const authLabel = authenticated ? 'AUTHENTICATED' : 'DISCONNECTED';
  const canTradeLabel =
    authenticated && effectiveCanTrade ? 'ENABLED' : 'DISABLED';
  const orderTestLabel = orderTestPassed ? 'PASSED' : 'FAILED';

  const tradingConfirmed = Boolean(
    authenticated && effectiveCanTrade && orderTestPassed
  );

  const bannerTone = tradingConfirmed
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
    : !authenticated
      ? 'border-slate-700 bg-slate-900/70 text-slate-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-200';

  const headline = diagnostics
    ? diagnostics.classificationMessage
    : authenticated
      ? effectiveCanTrade
        ? 'Run CHECK FUTURES TRADING PERMISSION to confirm POST /fapi/v1/order/test.'
        : 'FUTURES ACCOUNT TRADING DISABLED.'
      : 'Connect Binance Demo API to verify account and Futures order permissions.';

  const lastVerifiedText = diagnostics?.lastVerifiedAt
    ? new Date(diagnostics.lastVerifiedAt).toLocaleString()
    : 'Not verified yet';

  return (
    <div
      data-testid="permission-diagnostics-card"
      className={`rounded-xl border border-slate-800 bg-[#080f1b] ${
        compact ? 'p-3.5 space-y-3' : 'p-4 space-y-3.5'
      }`}
    >
      <div
        className={`flex flex-col gap-2.5 ${
          compact ? '' : 'sm:flex-row sm:items-center sm:justify-between'
        } border-b border-slate-800/80 pb-3`}
      >
        <div className="flex items-start gap-2 min-w-0">
          {tradingConfirmed ? (
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <h3 className="text-xs font-bold tracking-wide text-white">
              FUTURES TRADING PERMISSION DIAGNOSTICS
            </h3>
            <p className="text-[11px] text-slate-400">
              Non-executing check on demo-fapi.binance.com · Last verified:{' '}
              <span className="text-slate-200 tabular-nums">{lastVerifiedText}</span>
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void onCheckPermission()}
          disabled={checking}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-[11px] font-bold tracking-wide text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer ${
            compact ? 'w-full' : ''
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'CHECKING...' : 'CHECK FUTURES TRADING PERMISSION'}
        </button>
      </div>

      {/* Three Separate Explicit Diagnostic Statuses */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-slate-400">
            API AUTHENTICATION
          </p>
          <p
            data-testid="diag-api-auth"
            className={`mt-1 text-xs font-black tracking-wide ${
              authenticated ? 'text-emerald-400' : 'text-amber-300'
            }`}
          >
            {authLabel}
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-slate-400">
            FUTURES ACCOUNT CAN TRADE
          </p>
          <p
            data-testid="diag-can-trade"
            className={`mt-1 text-xs font-black tracking-wide ${
              authenticated && effectiveCanTrade
                ? 'text-emerald-400'
                : 'text-rose-400'
            }`}
          >
            {canTradeLabel}
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-slate-400">
            DEMO FUTURES ORDER TEST
          </p>
          <p
            data-testid="diag-order-test"
            className={`mt-1 text-xs font-black tracking-wide ${
              orderTestPassed ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {orderTestLabel}
          </p>
        </div>
      </div>

      {/* Classification Banner & Actual Binance Error Details */}
      <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-1 ${bannerTone}`}>
        <div className="flex items-start gap-2">
          {tradingConfirmed ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-bold tracking-wide">{headline}</p>
            {diagnostics?.orderTestMessage && (
              <p className="text-[11px] text-slate-300 break-words">
                Binance response: {diagnostics.orderTestMessage}
                {diagnostics.orderTestCode !== null && (
                  <span className="ml-1.5 font-mono font-bold text-rose-300">
                    [Code {diagnostics.orderTestCode}]
                  </span>
                )}
              </p>
            )}
            {!tradingConfirmed && (
              <p className="text-[11px] text-slate-400">
                Wallet balance availability does not confirm trading permissions. Automated and live-session Demo execution stay disabled until both account trading and POST /fapi/v1/order/test are confirmed.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
