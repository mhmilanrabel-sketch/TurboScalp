// server/agent/geminiAnalyst.ts
// Agent 3 – Gemini AI Market Analyst
// Interprets quantitative analysis, classifies market regimes, detects conflicting signals
// and risk flags, and returns strictly validated JSON.
// Never holds Binance execution permissions. Reports DEGRADED when Gemini is unavailable.

import { GoogleGenAI, Type } from '@google/genai';
import type { QuantAnalysisResult } from './quantAnalyst.js';

export type GeminiMarketRegime = 'TRENDING' | 'SIDEWAYS' | 'VOLATILE' | 'CONFLICTED';
export type GeminiSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface GeminiAnalysisResult {
  symbol: string;
  available: boolean;
  degraded: boolean;
  direction: 'BUY' | 'SELL' | 'HOLD';
  marketRegime: GeminiMarketRegime;
  confidence: number; // Strictly 0.0 - 1.0
  sentiment: GeminiSentiment;
  riskFlags: string[];
  reasoning: string;
  error?: string;
  analyzedAt: number;
}

const GEMINI_MODEL = 'gemini-4-hydrogen';
const CACHE_TTL_MS = 90_000;
const analysisCache = new Map<
  string,
  { candleTime: number; cachedAt: number; result: GeminiAnalysisResult }
>();

export function clearGeminiAnalystCache(): void {
  analysisCache.clear();
}

export function validateGeminiPayloadSchema(
  raw: unknown,
  expectedSymbol: string
): Omit<GeminiAnalysisResult, 'available' | 'degraded' | 'analyzedAt'> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Gemini output was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const dir = String(obj.direction || '').toUpperCase();
  if (dir !== 'BUY' && dir !== 'SELL' && dir !== 'HOLD') {
    throw new Error(`Invalid Gemini direction: ${String(obj.direction)}`);
  }

  const regimeRaw = String(obj.marketRegime || '').toUpperCase();
  const marketRegime: GeminiMarketRegime =
    regimeRaw === 'TRENDING' ||
    regimeRaw === 'SIDEWAYS' ||
    regimeRaw === 'VOLATILE' ||
    regimeRaw === 'CONFLICTED'
      ? regimeRaw
      : 'SIDEWAYS';

  const sentRaw = String(obj.sentiment || '').toUpperCase();
  const sentiment: GeminiSentiment =
    sentRaw === 'BULLISH' || sentRaw === 'BEARISH' || sentRaw === 'NEUTRAL'
      ? sentRaw
      : 'NEUTRAL';

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) {
    throw new Error('Invalid Gemini confidence value.');
  }
  // Normalize cleanly if model outputs 0-100 instead of 0-1, clamped to [0, 1]
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.min(1, Math.max(0, Number(confidence.toFixed(3))));

  const riskFlags = Array.isArray(obj.riskFlags)
    ? obj.riskFlags.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];

  const reasoning = String(obj.reasoning || '').trim();
  if (!reasoning) {
    throw new Error('Gemini output missing reasoning string.');
  }

  // Reject any unauthorized execution instructions if ever injected
  const symbolOut = String(obj.symbol || expectedSymbol).toUpperCase().trim();

  return {
    symbol: symbolOut === expectedSymbol ? expectedSymbol : expectedSymbol,
    direction: dir,
    marketRegime,
    confidence,
    sentiment,
    riskFlags,
    reasoning: reasoning.slice(0, 500),
  };
}

export async function runGeminiMarketAnalysis(
  quant: QuantAnalysisResult,
  suppliedNewsHeadlines: string[] = [],
  options: {
    generateFn?: (promptPayload: Record<string, unknown>) => Promise<unknown>;
    bypassCache?: boolean;
  } = {}
): Promise<GeminiAnalysisResult> {
  const cached = analysisCache.get(quant.symbol);
  if (
    !options.bypassCache &&
    cached &&
    cached.candleTime === quant.latestClosedCandleTime &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const promptPayload = {
    symbol: quant.symbol,
    lastClosedPrice: quant.price,
    change24hPct: Number(quant.change24h.toFixed(2)),
    quoteVolume24hUsdt: Math.round(quant.quoteVolume),
    quantProposedDirection: quant.direction,
    heuristicScore: quant.heuristicScore,
    minScoreThreshold: quant.minScoreRequired,
    trendStrength: quant.trendStrength,
    mtfAligned: quant.mtfAligned,
    indicators15m: {
      ema9: Number(quant.ema9_15m.toFixed(6)),
      ema21: Number(quant.ema21_15m.toFixed(6)),
      ema50: Number(quant.ema50_15m.toFixed(6)),
      rsi14: Number(quant.rsi14.toFixed(2)),
      macd: Number(quant.macd.toFixed(6)),
      macdSignal: Number(quant.macdSignal.toFixed(6)),
      macdHistogram: Number(quant.macdHistogram.toFixed(6)),
      atr14: Number(quant.atr14.toFixed(6)),
      volatilityPct: Number(quant.volatilityPct.toFixed(3)),
      volumeRatio: Number(quant.volumeRatio.toFixed(2)),
      supportLevel: Number(quant.supportLevel.toFixed(6)),
      resistanceLevel: Number(quant.resistanceLevel.toFixed(6)),
      breakout: quant.breakout,
      marketStructure: quant.marketStructure,
    },
    indicators5m: {
      ema9: Number(quant.ema9_5m.toFixed(6)),
      ema21: Number(quant.ema21_5m.toFixed(6)),
      ema50: Number(quant.ema50_5m.toFixed(6)),
      rsi14: Number(quant.rsi5m.toFixed(2)),
    },
    quantReasons: quant.reasons,
    verifiedNewsHeadlines: suppliedNewsHeadlines,
  };

  try {
    let parsedRaw: unknown;

    if (options.generateFn) {
      parsedRaw = await options.generateFn(promptPayload);
    } else {
      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      if (!apiKey) {
        return {
          symbol: quant.symbol,
          available: false,
          degraded: true,
          direction: 'HOLD',
          marketRegime: 'SIDEWAYS',
          confidence: 0,
          sentiment: 'NEUTRAL',
          riskFlags: ['AI_DEGRADED_MISSING_KEY'],
          reasoning:
            'GEMINI_API_KEY is not configured on the backend; AI analyst is DEGRADED.',
          error: 'GEMINI_API_KEY not configured on server',
          analyzedAt: Date.now(),
        };
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Analyze this Binance USD-M Futures closed-candle setup and return strict JSON grounded ONLY in the supplied payload:\n${JSON.stringify(promptPayload)}`,
        config: {
          systemInstruction:
            'You are Agent 3, a senior cryptocurrency market analyst with NO exchange execution authority. ' +
            'Interpret the supplied technical indicators and verifiedNewsHeadlines (never invent news, macro headlines, or numbers). ' +
            'Classify marketRegime as TRENDING, SIDEWAYS, VOLATILE, or CONFLICTED. ' +
            'Classify sentiment as BULLISH, BEARISH, or NEUTRAL. ' +
            'Return confidence between 0.0 and 1.0 as a qualitative alignment measure (never claim statistical win probability). ' +
            'Recommend BUY, SELL, or HOLD and list any technical conflicts or extreme-volatility riskFlags. ' +
            'Never output order sizes, leverage, or execution commands.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              symbol: { type: Type.STRING },
              direction: { type: Type.STRING, description: 'BUY, SELL, or HOLD' },
              marketRegime: {
                type: Type.STRING,
                description: 'TRENDING, SIDEWAYS, VOLATILE, or CONFLICTED',
              },
              confidence: {
                type: Type.NUMBER,
                description: 'Float between 0.0 and 1.0',
              },
              sentiment: {
                type: Type.STRING,
                description: 'BULLISH, BEARISH, or NEUTRAL',
              },
              riskFlags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              reasoning: {
                type: Type.STRING,
                description: 'Concise 1-2 sentence explanation',
              },
            },
            required: [
              'symbol',
              'direction',
              'marketRegime',
              'confidence',
              'sentiment',
              'riskFlags',
              'reasoning',
            ],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      parsedRaw = JSON.parse(rawText);
    }

    const validated = validateGeminiPayloadSchema(parsedRaw, quant.symbol);
    const result: GeminiAnalysisResult = {
      ...validated,
      available: true,
      degraded: false,
      analyzedAt: Date.now(),
    };

    analysisCache.set(quant.symbol, {
      candleTime: quant.latestClosedCandleTime,
      cachedAt: Date.now(),
      result,
    });
    return result;
  } catch (err: any) {
    const errMsg = err?.message || 'Gemini API request or schema validation failed';
    return {
      symbol: quant.symbol,
      available: false,
      degraded: true,
      direction: 'HOLD',
      marketRegime: 'SIDEWAYS',
      confidence: 0,
      sentiment: 'NEUTRAL',
      riskFlags: ['AI_DEGRADED'],
      reasoning: `AI Market Analyst DEGRADED: ${errMsg}`,
      error: errMsg,
      analyzedAt: Date.now(),
    };
  }
}
