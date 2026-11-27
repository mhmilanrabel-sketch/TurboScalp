// server/agent/executionManager.ts
// Agent 5 – Automated Execution Agent (Binance USD-M Futures DEMO ONLY)
// Strict safeguards:
//   - Never executes without Risk Manager approval
//   - Unique clientOrderId; queries exchange order status before any retry
//   - Derives actual executedQty and avgFillPrice from exchange fill response
//   - Handles One-Way vs Hedge position modes cleanly
//   - Uses POST /fapi/v1/algoOrder (CONDITIONAL STOP_MARKET / TAKE_PROFIT_MARKET)
//     with triggerPrice, workingType=MARK_PRICE, closePosition=true (no quantity or reduceOnly)
//   - Never uses deprecated /fapi/v1/order for conditional exits
//   - Verifies both Algo orders on GET /fapi/v1/openAlgoOrders
//   - Full emergency rollback: cancel surviving Algo, MARKET close remaining position,
//     verify flat, pause automated entries, and emit CRITICAL alert + Telegram notification.

import {
  appendAgentLog,
  hasClientOrderId,
  notifyTelegramEvent,
  recordCriticalError,
  recordTradeClosed,
  recordTradeOpened,
  type AgentTradeRecord,
} from './agentStorage.js';
import type { GeminiAnalysisResult } from './geminiAnalyst.js';
import type { QuantAnalysisResult } from './quantAnalyst.js';
import {
  floorToStep,
  roundPriceToTick,
  type ApprovedOrderPlan,
  type ExchangeSymbolFilter,
  type RiskDecision,
} from './riskManager.js';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';
export type DemoCredentials = { apiKey: string; apiSecret: string };

export type BinanceRequestFn = <T = any>(
  method: HttpMethod,
  endpoint: string,
  params?: Record<string, any>,
  signed?: boolean,
  credentials?: DemoCredentials
) => Promise<T>;

export interface ExecutionContext {
  credentials: DemoCredentials;
  binanceRequest: BinanceRequestFn;
  inFlightSymbols: Set<string>;
  onPauseRequired: (reason: string) => void;
}

export interface ExecutionOutcome {
  success: boolean;
  tradeRecord: AgentTradeRecord | null;
  error?: string;
}

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function extractFillMetrics(
  orderResp: any,
  fallbackPrice: number
): {
  orderId: number | string | null;
  status: string;
  executedQty: number;
  avgPrice: number;
} {
  const executedQty = toNum(orderResp?.executedQty);
  const directAvg = toNum(orderResp?.avgPrice);
  const cumQuote = toNum(orderResp?.cumQuote ?? orderResp?.cumQuoteQty);
  const derivedAvg =
    directAvg > 0
      ? directAvg
      : executedQty > 0 && cumQuote > 0
        ? cumQuote / executedQty
        : fallbackPrice;

  return {
    orderId: orderResp?.orderId ?? null,
    status: String(orderResp?.status || 'UNKNOWN'),
    executedQty,
    avgPrice: derivedAvg,
  };
}

export function buildProtectiveAlgoParams(params: {
  symbol: string;
  entrySide: 'BUY' | 'SELL';
  positionMode: 'ONE_WAY' | 'HEDGE';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: string;
  clientAlgoId: string;
}): Record<string, string> {
  const closeSide = params.entrySide === 'BUY' ? 'SELL' : 'BUY';
  // Binance rule: with closePosition=true, do NOT send quantity or reduceOnly.
  // Use triggerPrice (not deprecated stopPrice) and workingType=MARK_PRICE.
  return {
    algoType: 'CONDITIONAL',
    symbol: params.symbol,
    side: closeSide,
    positionSide: params.positionMode === 'HEDGE' ? params.positionSide : 'BOTH',
    type: params.type,
    triggerPrice: params.triggerPrice,
    workingType: 'MARK_PRICE',
    closePosition: 'true',
    clientAlgoId: params.clientAlgoId,
  };
}

export async function fetchOpenAlgoOrdersSafe(
  binanceRequest: BinanceRequestFn,
  credentials: DemoCredentials,
  symbol?: string
): Promise<any[]> {
  const query = symbol ? { symbol } : {};
  const resp = await binanceRequest<any[]>(
    'GET',
    '/fapi/v1/openAlgoOrders',
    query,
    true,
    credentials
  );

  if (!Array.isArray(resp)) {
    throw new Error('Binance returned an invalid open algo orders response.');
  }

  return resp;
}

export async function cancelAlgoOrderSafe(
  binanceRequest: BinanceRequestFn,
  credentials: DemoCredentials,
  symbol: string,
  algoId?: number | string | null,
  clientAlgoId?: string
): Promise<boolean> {
  if (!algoId && !clientAlgoId) return false;
  try {
    const params: Record<string, any> = { symbol };
    if (algoId) params.algoId = algoId;
    else if (clientAlgoId) params.clientAlgoId = clientAlgoId;
    await binanceRequest('DELETE', '/fapi/v1/algoOrder', params, true, credentials);
    return true;
  } catch {
    return false;
  }
}

async function detectPositionMode(
  binanceRequest: BinanceRequestFn,
  credentials: DemoCredentials
): Promise<'ONE_WAY' | 'HEDGE'> {
  try {
    const dual = await binanceRequest<any>(
      'GET',
      '/fapi/v1/positionSide/dual',
      {},
      true,
      credentials
    );
    return dual?.dualSidePosition === true ? 'HEDGE' : 'ONE_WAY';
  } catch {
    return 'ONE_WAY';
  }
}

export async function executeApprovedOrder(
  decision: RiskDecision,
  quant: QuantAnalysisResult,
  aiResult: GeminiAnalysisResult,
  filter: ExchangeSymbolFilter,
  ctx: ExecutionContext
): Promise<ExecutionOutcome> {
  const plan = decision.orderPlan;
  if (!decision.approved || !plan) {
    return {
      success: false,
      tradeRecord: null,
      error: 'Execution rejected: missing Risk Manager approval.',
    };
  }

  if (
    ctx.inFlightSymbols.has(plan.symbol) ||
    hasClientOrderId(plan.clientOrderId)
  ) {
    return {
      success: false,
      tradeRecord: null,
      error: `Duplicate execution blocked for ${plan.symbol} (${plan.clientOrderId}).`,
    };
  }

  ctx.inFlightSymbols.add(plan.symbol);
  const tradeId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const stopClientAlgoId = `SL_${tradeId.slice(3, 15)}`;
  const targetClientAlgoId = `TP_${tradeId.slice(3, 15)}`;

  try {
    const positionMode = await detectPositionMode(
      ctx.binanceRequest,
      ctx.credentials
    );
    const positionSide: 'BOTH' | 'LONG' | 'SHORT' =
      positionMode === 'HEDGE'
        ? plan.side === 'BUY'
          ? 'LONG'
          : 'SHORT'
        : 'BOTH';

    // Enforce leverage <= 2x on Binance Demo before entry
    await ctx.binanceRequest(
      'POST',
      '/fapi/v1/leverage',
      { symbol: plan.symbol, leverage: plan.leverage },
      true,
      ctx.credentials
    );

    const entryParams: Record<string, any> = {
      symbol: plan.symbol,
      side: plan.side,
      type: 'MARKET',
      quantity: plan.quantity,
      newClientOrderId: plan.clientOrderId,
      newOrderRespType: 'RESULT',
    };
    if (positionMode === 'HEDGE') {
      entryParams.positionSide = positionSide;
    }

    let entryResp: any;
    try {
      entryResp = await ctx.binanceRequest<any>(
        'POST',
        '/fapi/v1/order',
        entryParams,
        true,
        ctx.credentials
      );
    } catch (submitErr: any) {
      // Do not blindly retry an ambiguous market order: check clientOrderId status on Binance first
      try {
        entryResp = await ctx.binanceRequest<any>(
          'GET',
          '/fapi/v1/order',
          { symbol: plan.symbol, origClientOrderId: plan.clientOrderId },
          true,
          ctx.credentials
        );
        appendAgentLog(
          'AGENT_5_EXECUTION',
          'WARN',
          `Recovered ambiguous entry order ${plan.clientOrderId} via exchange query.`,
          plan.symbol
        );
      } catch {
        throw submitErr;
      }
    }

    const fill = extractFillMetrics(entryResp, plan.entryPrice);
    if (fill.executedQty <= 0) {
      throw new Error(
        `Entry order ${plan.clientOrderId} returned executedQty=0 (status=${fill.status}).`
      );
    }

    const actualQtyStr = floorToStep(fill.executedQty, filter.stepSize);
    const actualNumericQty = Number(actualQtyStr) || fill.executedQty;
    const isPartial =
      Math.abs(actualNumericQty - plan.numericQuantity) > filter.stepSize * 0.5;
    const actualNotional = Number((actualNumericQty * fill.avgPrice).toFixed(4));

    // Recalculate protective trigger prices relative to actual fill price while preserving stop/TP distance
    const slDist = Math.abs(plan.entryPrice - Number(plan.stopPrice));
    const tpDist = Math.abs(Number(plan.takeProfitPrice) - plan.entryPrice);
    const adjustedStop = roundPriceToTick(
      plan.side === 'BUY' ? fill.avgPrice - slDist : fill.avgPrice + slDist,
      filter.tickSize
    );
    const adjustedTp = roundPriceToTick(
      plan.side === 'BUY' ? fill.avgPrice + tpDist : fill.avgPrice - tpDist,
      filter.tickSize
    );

    const stopParams = buildProtectiveAlgoParams({
      symbol: plan.symbol,
      entrySide: plan.side,
      positionMode,
      positionSide,
      type: 'STOP_MARKET',
      triggerPrice: adjustedStop,
      clientAlgoId: stopClientAlgoId,
    });

    const tpParams = buildProtectiveAlgoParams({
      symbol: plan.symbol,
      entrySide: plan.side,
      positionMode,
      positionSide,
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: adjustedTp,
      clientAlgoId: targetClientAlgoId,
    });

    let stopAlgoId: number | string | null = null;
    let targetAlgoId: number | string | null = null;
    let protectionError = '';

    try {
      const stopResp = await ctx.binanceRequest<any>(
        'POST',
        '/fapi/v1/algoOrder',
        stopParams,
        true,
        ctx.credentials
      );
      stopAlgoId = stopResp?.algoId ?? null;

      const tpResp = await ctx.binanceRequest<any>(
        'POST',
        '/fapi/v1/algoOrder',
        tpParams,
        true,
        ctx.credentials
      );
      targetAlgoId = tpResp?.algoId ?? null;

      // Verify BOTH protective orders are genuinely open via GET /fapi/v1/openAlgoOrders
      const openAlgos = await fetchOpenAlgoOrdersSafe(
        ctx.binanceRequest,
        ctx.credentials,
        plan.symbol
      );
      const slVerified = openAlgos.some(
        (o) =>
          o.clientAlgoId === stopClientAlgoId ||
          (stopAlgoId && String(o.algoId) === String(stopAlgoId))
      );
      const tpVerified = openAlgos.some(
        (o) =>
          o.clientAlgoId === targetClientAlgoId ||
          (targetAlgoId && String(o.algoId) === String(targetAlgoId))
      );

      if (!slVerified || !tpVerified) {
        protectionError = `Protective exit verification failed on openAlgoOrders (SL=${slVerified}, TP=${tpVerified}).`;
      }
    } catch (algoErr: any) {
      protectionError = algoErr?.message || 'Algo protective order rejected.';
    }

    const baseRecord: AgentTradeRecord = {
      id: tradeId,
      symbol: plan.symbol,
      side: plan.side,
      positionMode,
      positionSide,
      status: 'OPEN',
      executionStatus: isPartial ? 'PARTIAL_PROTECTED' : 'FILLED_PROTECTED',
      requestedQuantity: plan.quantity,
      executedQuantity: actualQtyStr,
      leverage: plan.leverage,
      notionalUsd: actualNotional,
      riskUsd: Number((actualNumericQty * slDist).toFixed(4)),
      entryPrice: fill.avgPrice,
      exitPrice: null,
      markPrice: fill.avgPrice,
      stopPrice: Number(adjustedStop),
      takeProfitPrice: Number(adjustedTp),
      entryOrderId: fill.orderId,
      entryClientOrderId: plan.clientOrderId,
      stopAlgoId,
      stopClientAlgoId,
      targetAlgoId,
      targetClientAlgoId,
      emergencyOrderId: null,
      stopStatus: protectionError ? 'FAILED' : 'ARMED',
      takeProfitStatus: protectionError ? 'FAILED' : 'ARMED',
      unrealizedPnl: 0,
      realizedPnl: null,
      tradingFees: 0,
      fundingFees: 0,
      commission: 0,
      netPnl: null,
      openedAt: Date.now(),
      closedAt: null,
      closeReason: null,
      signalSnapshot: {
        quantDirection: quant.direction,
        heuristicScore: quant.heuristicScore,
        trendStrength: quant.trendStrength,
        rsi14: quant.rsi14,
        ema9: quant.ema9_15m,
        ema21: quant.ema21_15m,
        ema50: quant.ema50_15m,
        atr14: quant.atr14,
        volatilityPct: quant.volatilityPct,
        volumeRatio: quant.volumeRatio,
        breakout: quant.breakout,
        mtfAligned: quant.mtfAligned,
        marketRegime: aiResult.marketRegime,
        aiDirection: aiResult.direction,
        aiSentiment: aiResult.sentiment,
        aiConfidence: aiResult.confidence,
        aiRiskFlags: aiResult.riskFlags,
        stopDistancePct: plan.stopDistancePct,
      },
    };

    if (protectionError) {
      // Protective Exit Failure Protocol:
      // 1. Cancel whichever bot-owned Algo protective order succeeded
      await cancelAlgoOrderSafe(
        ctx.binanceRequest,
        ctx.credentials,
        plan.symbol,
        stopAlgoId,
        stopClientAlgoId
      );
      await cancelAlgoOrderSafe(
        ctx.binanceRequest,
        ctx.credentials,
        plan.symbol,
        targetAlgoId,
        targetClientAlgoId
      );

      // 2. Safely close actual remaining position via MARKET
      const closeSide = plan.side === 'BUY' ? 'SELL' : 'BUY';
      const emergencyClientId = `EMG_${tradeId.slice(3, 15)}`;
      const closeParams: Record<string, any> = {
        symbol: plan.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: actualQtyStr,
        newClientOrderId: emergencyClientId,
        newOrderRespType: 'RESULT',
      };
      if (positionMode === 'HEDGE') {
        closeParams.positionSide = positionSide;
      } else {
        closeParams.reduceOnly = 'true';
      }

      let emergencyOrderId: number | string | null = null;
      let verifiedFlat = false;
      try {
        const closeResp = await ctx.binanceRequest<any>(
          'POST',
          '/fapi/v1/order',
          closeParams,
          true,
          ctx.credentials
        );
        emergencyOrderId = closeResp?.orderId ?? null;
        // 3. Verify resulting position state on exchange
        const posRisk = await ctx.binanceRequest<any[]>(
          'GET',
          '/fapi/v3/positionRisk',
          { symbol: plan.symbol },
          true,
          ctx.credentials
        );
        const remaining = (Array.isArray(posRisk) ? posRisk : []).find(
          (p) =>
            p.symbol === plan.symbol &&
            (positionMode === 'ONE_WAY' || p.positionSide === positionSide)
        );
        verifiedFlat = Math.abs(toNum(remaining?.positionAmt)) <= 1e-12;
      } catch (closeErr: any) {
        protectionError += ` | Emergency close failed: ${closeErr?.message || 'unknown'}`;
      }

      baseRecord.emergencyOrderId = emergencyOrderId;
      baseRecord.status = 'EMERGENCY_CLOSED';
      baseRecord.executionStatus = verifiedFlat
        ? 'ROLLBACK_CLOSED'
        : 'UNCERTAIN_RECOVERY_NEEDED';

      await recordTradeOpened(baseRecord);
      await recordTradeClosed(baseRecord.id, {
        status: 'EMERGENCY_CLOSED',
        exitPrice: fill.avgPrice,
        realizedPnl: 0,
        tradingFees: 0,
        closeReason: verifiedFlat
          ? `ROLLBACK_FLAT: ${protectionError}`
          : `CRITICAL_OPEN_EXPOSURE: ${protectionError}`,
        executionStatus: baseRecord.executionStatus,
      });

      // 4. Pause new automated entries + 5. Create CRITICAL activity alert & Telegram
      ctx.onPauseRequired(
        `Protective exit failed on ${plan.symbol}; automated entries paused`
      );
      recordCriticalError(
        'PROTECTIVE_EXIT_ROLLBACK',
        `${protectionError} (verifiedFlat=${verifiedFlat})`,
        plan.symbol
      );
      void notifyTelegramEvent(
        'CRITICAL_FAILURE',
        `CRITICAL protective exit failure on ${plan.symbol}: ${protectionError}. Emergency close flat=${verifiedFlat}. New entries PAUSED.`
      );

      return {
        success: false,
        tradeRecord: baseRecord,
        error: protectionError,
      };
    }

    await recordTradeOpened(baseRecord);

    appendAgentLog(
      'AGENT_5_EXECUTION',
      'TRADE',
      `DEMO ENTRY ${plan.side} ${actualQtyStr} ${plan.symbol} @ $${fill.avgPrice.toFixed(4)} (${plan.leverage}x) | SL Algo #${stopAlgoId} ($${adjustedStop}) | TP Algo #${targetAlgoId} ($${adjustedTp})${isPartial ? ' [PARTIAL FILL]' : ''}`,
      plan.symbol
    );

    void notifyTelegramEvent(
      'DEMO_ORDER_EXECUTED',
      `EXECUTED ${plan.side} ${actualQtyStr} ${plan.symbol} @ $${fill.avgPrice.toFixed(4)} ($${actualNotional.toFixed(2)}, ${plan.leverage}x)`
    );
    void notifyTelegramEvent(
      'SL_CONFIRMED',
      `SL ARMED ${plan.symbol}: Algo #${stopAlgoId} trigger=$${adjustedStop} (MARK_PRICE)`
    );
    void notifyTelegramEvent(
      'TP_CONFIRMED',
      `TP ARMED ${plan.symbol}: Algo #${targetAlgoId} trigger=$${adjustedTp} (MARK_PRICE)`
    );

    return {
      success: true,
      tradeRecord: baseRecord,
    };
  } catch (err: any) {
    const msg = err?.message || 'Execution error';
    recordCriticalError('ENTRY_EXECUTION', msg, plan.symbol);
    void notifyTelegramEvent(
      'CRITICAL_FAILURE',
      `Execution failed for ${plan.symbol}: ${msg}`
    );
    return {
      success: false,
      tradeRecord: null,
      error: msg,
    };
  } finally {
    ctx.inFlightSymbols.delete(plan.symbol);
  }
}
