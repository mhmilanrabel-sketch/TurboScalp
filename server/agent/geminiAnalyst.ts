// server/agent/geminiAnalyst.ts
// Agent 3 – Gemini AI Market Analyst
// Delegates all Gemini SDK calls, quota limits (12/day), persistence, RetryInfo backoff,
// feature-versioned closed-candle caching, and 3-candidate batching to geminiRequestManager.ts.
// Never holds Binance execution permissions. Never sends Binance secrets to Gemini.

import {
  analyzeCandidatesWithManager,
  classifyGeminiError,
  clearGeminiAnalysisCacheOnly,
  ensureGeminiManagerLoaded,
  GEMINI_DEFAULT_PRIMARY_MODEL,
  getCachedGeminiAnalysis,
  getGeminiQuotaStatus,
  recheckGeminiAvailability,
  setGeminiAwaitingCandidatesCount,
  validateGeminiPayloadSchema,
  verifyFallbackModelSupport,
  type BatchAnalysisOutcome,
  type GeminiAnalysisResult,
  type GeminiBatchGeneratorFn,
  type GeminiErrorCategory,
  type GeminiFallbackStatus,
  type GeminiManagerStatus,
  type GeminiMarketRegime,
  type GeminiModelVerifierFn,
  type GeminiPrimaryStatus,
  type GeminiQuotaStatusSnapshot,
  type GeminiRequestManagerOptions,
  type GeminiSentiment,
} from './geminiRequestManager.js';
import type { QuantAnalysisResult } from './quantAnalyst.js';

export type {
  BatchAnalysisOutcome,
  GeminiAnalysisResult,
  GeminiBatchGeneratorFn,
  GeminiErrorCategory,
  GeminiFallbackStatus,
  GeminiManagerStatus,
  GeminiMarketRegime,
  GeminiModelVerifierFn,
  GeminiPrimaryStatus,
  GeminiQuotaStatusSnapshot,
  GeminiRequestManagerOptions,
  GeminiSentiment,
};

export {
  classifyGeminiError,
  ensureGeminiManagerLoaded,
  GEMINI_DEFAULT_PRIMARY_MODEL,
  getCachedGeminiAnalysis,
  getGeminiQuotaStatus,
  recheckGeminiAvailability,
  setGeminiAwaitingCandidatesCount,
  validateGeminiPayloadSchema,
  verifyFallbackModelSupport,
};

export function clearGeminiAnalystCache(): void {
  clearGeminiAnalysisCacheOnly();
}

export async function analyzeQualifiedCandidatesBatch(
  qualifiedCandidates: QuantAnalysisResult[],
  options: GeminiRequestManagerOptions = {}
): Promise<BatchAnalysisOutcome> {
  // Never waste Gemini quota on non-actionable HOLD markets unless explicitly passed in single-symbol mode
  const actionable = qualifiedCandidates.filter((q) => q.direction !== 'HOLD');
  if (actionable.length === 0) {
    setGeminiAwaitingCandidatesCount(0);
    await ensureGeminiManagerLoaded();
    return {
      resultsBySymbol: new Map(),
      requestsDispatched: 0,
      cacheHits: 0,
      awaitingAnalysisCount: 0,
      quotaStatus: getGeminiQuotaStatus(options.nowMs),
    };
  }

  return analyzeCandidatesWithManager(actionable, options);
}

export async function runGeminiMarketAnalysis(
  quant: QuantAnalysisResult,
  suppliedNewsHeadlines: string[] = [],
  options: Omit<GeminiRequestManagerOptions, 'suppliedNewsBySymbol' | 'batchGenerateFn'> & {
    generateFn?: (promptPayload: Record<string, unknown>) => Promise<unknown>;
  } = {}
): Promise<GeminiAnalysisResult> {
  const { generateFn, ...restOpts } = options;
  const outcome = await analyzeCandidatesWithManager([quant], {
    ...restOpts,
    suppliedNewsBySymbol:
      suppliedNewsHeadlines.length > 0
        ? { [quant.symbol]: suppliedNewsHeadlines }
        : undefined,
    ...(generateFn
      ? {
          batchGenerateFn: async ({ candidates }) => {
            const singlePayload = candidates[0] ?? {};
            const raw = await generateFn(singlePayload);
            return { analyses: [raw] };
          },
        }
      : {}),
  });

  return (
    outcome.resultsBySymbol.get(quant.symbol) ?? {
      symbol: quant.symbol,
      available: false,
      degraded: true,
      quotaExhausted: outcome.quotaStatus.status === 'QUOTA_EXHAUSTED',
      modelUsed: outcome.quotaStatus.model,
      usedFallback: false,
      errorCategory: outcome.quotaStatus.lastErrorCategory,
      direction: 'HOLD',
      marketRegime: 'SIDEWAYS',
      confidence: 0,
      sentiment: 'NEUTRAL',
      riskFlags: ['AI_DEGRADED'],
      reasoning:
        outcome.quotaStatus.quotaMessage ||
        'AI Market Analyst did not produce a valid response.',
      error: outcome.quotaStatus.lastApiError || 'No analysis produced',
      analyzedAt: Date.now(),
    }
  );
}
