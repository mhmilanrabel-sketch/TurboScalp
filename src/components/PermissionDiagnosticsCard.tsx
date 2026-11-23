import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  BINANCE_DEMO_REST_ENDPOINT,
  type FuturesPermissionDiagnostics,
} from '../utils/permissionDiagnostics';

interface PermissionDiagnosticsCardProps {
  apiConnected: boolean;
  canTrade: boolean;
  diagnostics: FuturesPermissionDiagnostics | null;
  checking: boolean;
  onCheckPermission: () => void | Promise<void>;
  compact?: boolean;
}

export const PermissionDiagnosticsCard: React.FC<
  PermissionDiagnosticsCardProps
> = ({
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
  const accountConfigCanTrade =
    diagnostics !== null
      ? diagnostics.accountConfigCanTrade
      : authenticated
        ? canTrade
        : null;
  const orderTestPassed = Boolean(diagnostics?.orderTestPassed);

  const authLabel = authenticated ? 'VERIFIED' : 'DISCONNECTED';

  let permLabel: 'ENABLED' | 'DISABLED' | 'UNKNOWN' | 'ERROR' | 'DISCONNECTED' =
    'DISCONNECTED';
  if (!authenticated) {
    permLabel = 'DISCONNECTED';
  } else if (diagnostics) {
    permLabel = diagnostics.accountPermissionStatus;
  } else {
    permLabel = canTrade ? 'ENABLED' : 'UNKNOWN';
  }

  const orderTestLabel = diagnostics
    ? diagnostics.orderTestStatus
    : authenticated
      ? 'NOT TESTED'
      : 'FAILED';

  const tradingConfirmed = Boolean(
    authenticated &&
      diagnostics?.tradingConfirmed &&
      accountConfigCanTrade === true &&
      orderTestPassed
  );

  const bannerTone = tradingConfirmed
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
    : !authenticated
      ? 'border-slate-700 bg-slate-900/70 text-slate-300'
      : permLabel === 'UNKNOWN'
        ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
        : 'border-rose-500/40 bg-rose-500/10 text-rose-200';

  const headline = diagnostics
    ? diagnostics.classificationMessage
    : authenticated
      ? 'Run CHECK FUTURES TRADING PERMISSION to query /fapi/v3/account (balances), /fapi/v1/accountConfig (trading permission), and POST /fapi/v1/order/test.'
      : 'Connect Binance Demo API to inspect /fapi/v3/account, /fapi/v1/accountConfig, and order validation.';

  const lastVerifiedText = diagnostics?.lastVerifiedAt
    ? new Date(diagnostics.lastVerifiedAt).toLocaleString()
    : 'Not verified yet';

  const restEndpoint =
    diagnostics?.restEndpoint || BINANCE_DEMO_REST_ENDPOINT;
  const envLabel = diagnostics?.environment || 'USD_M_FUTURES_DEMO';

  const permToneClass =
    permLabel === 'ENABLED'
      ? 'text-emerald-400'
      : permLabel === 'UNKNOWN'
        ? 'text-amber-300'
        : 'text-rose-400';

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
            <p className="text-[11px] text-slate-400 break-words">
              Env:{' '}
              <span className="font-mono text-cyan-300">
                {envLabel} ({restEndpoint})
              </span>{' '}
              · Last verified:{' '}
              <span
                data-testid="diag-last-verified"
                className="text-slate-200 tabular-nums"
              >
                {lastVerifiedText}
              </span>
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

      {/* Three Separate Explicit Diagnostic Results */}
      <div
        className={`grid grid-cols-1 gap-2.5 ${
          compact ? '' : 'md:grid-cols-3'
        }`}
      >
        <div className="min-w-0 rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
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
          <p className="mt-1 text-[10px] text-slate-500">
            Signed HMAC · HttpOnly session
          </p>
        </div>

        <div className="min-w-0 rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-slate-400">
            FUTURES ACCOUNT TRADING PERMISSION
          </p>
          <p
            data-testid="diag-account-permission"
            className={`mt-1 text-xs font-black tracking-wide ${permToneClass}`}
          >
            {permLabel}
          </p>
          <p className="mt-1 text-[10px] font-mono text-slate-400 tabular-nums break-words">
            accountConfigCanTrade:{' '}
            <span
              data-testid="diag-config-cantrade"
              className={
                accountConfigCanTrade === true
                  ? 'text-emerald-300'
                  : accountConfigCanTrade === false
                    ? 'text-rose-300'
                    : 'text-amber-300'
              }
            >
              {accountConfigCanTrade === true
                ? 'TRUE'
                : accountConfigCanTrade === false
                  ? 'FALSE'
                  : 'UNKNOWN'}
            </span>
          </p>
        </div>

        <div className="min-w-0 rounded-lg border border-slate-800 bg-[#070d17] px-3 py-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-slate-400">
            DEMO ORDER REQUEST VALIDATION
          </p>
          <p
            data-testid="diag-order-test"
            className={`mt-1 text-xs font-black tracking-wide ${
              orderTestPassed ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {orderTestLabel}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            POST /fapi/v1/order/test (non-executing)
          </p>
        </div>
      </div>

      {/* Authoritative Source & Endpoint Investigation Breakdown */}
      <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-2 ${bannerTone}`}>
        <div className="flex items-start gap-2">
          {tradingConfirmed ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="font-bold tracking-wide" data-testid="diag-classification">
              {headline}
            </p>

            <div className="rounded border border-slate-800/80 bg-[#070d17]/90 px-2.5 py-2 font-mono text-[10px] text-slate-300 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                <span>Binance V3 account configuration fields:</span>
                <span data-testid="diag-v3-status" className="text-slate-300">
                  Not provided (accountCanTrade: null)
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                <span>Authoritative trading permission source:</span>
                <span data-testid="diag-auth-source" className="text-cyan-300">
                  /fapi/v1/accountConfig
                </span>
              </div>

              {diagnostics && (
                <>
                  <div className="border-t border-slate-800/80 pt-1 mt-1 flex flex-wrap items-center justify-between gap-2">
                    <span>GET /fapi/v3/account</span>
                    <span>
                      {diagnostics.accountEndpointOk
                        ? `walletBalance=${Number(diagnostics.walletBalance ?? 0).toFixed(2)} · available=${Number(diagnostics.availableBalance ?? 0).toFixed(2)} USDT`
                        : `FAILED${diagnostics.accountErrorCode !== null ? ` [Code ${diagnostics.accountErrorCode}]` : ''}: ${diagnostics.accountErrorMessage || 'Error'}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>GET /fapi/v1/accountConfig</span>
                    <span>
                      {diagnostics.accountConfigEndpointOk
                        ? `canTrade=${
                            diagnostics.accountConfigCanTrade === null
                              ? 'UNKNOWN'
                              : String(diagnostics.accountConfigCanTrade).toUpperCase()
                          }${
                            diagnostics.dualSidePosition !== null &&
                            diagnostics.dualSidePosition !== undefined
                              ? ` · dualSidePosition=${diagnostics.dualSidePosition}`
                              : ''
                          }${
                            diagnostics.feeTier !== null &&
                            diagnostics.feeTier !== undefined
                              ? ` · feeTier=${diagnostics.feeTier}`
                              : ''
                          }`
                        : `FAILED${diagnostics.accountConfigErrorCode !== null ? ` [Code ${diagnostics.accountConfigErrorCode}]` : ''}: ${diagnostics.accountConfigErrorMessage || 'Error'}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>POST /fapi/v1/order/test</span>
                    <span className="break-words">
                      {diagnostics.orderTestPassed
                        ? 'PASSED (non-executing parameter validation)'
                        : `FAILED${diagnostics.orderTestCode !== null ? ` [Code ${diagnostics.orderTestCode}]` : ''}: ${diagnostics.orderTestMessage}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                    <span>permissionStatus</span>
                    <span className="text-slate-200 break-all">{diagnostics.permissionStatus}</span>
                  </div>
                </>
              )}
            </div>

            <p className="text-[11px] text-slate-400">
              {tradingConfirmed
                ? 'Account permission (/fapi/v1/accountConfig) and non-executing order validation passed. Automatic trading remains disabled until separately enabled by the user.'
                : 'Automatic trading and actual Demo order execution stay disabled until /fapi/v1/accountConfig reports canTrade=true and POST /fapi/v1/order/test passes.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
