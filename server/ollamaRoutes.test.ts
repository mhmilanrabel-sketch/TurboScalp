import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  analyzeWithOllama,
  getOllamaConfig,
  getOllamaStatus,
  isOllamaBusy,
  OllamaServiceError,
  registerOllamaRoutes,
  validateOllamaInput,
  type OllamaHttpClient,
} from './ollamaRoutes.js';

function startTestApp(httpClient: OllamaHttpClient, allowOrigin = true) {
  const app = express();
  app.use(express.json());
  registerOllamaRoutes(app, {
    httpClient,
    validateMutationOrigin: () => allowOrigin,
  });

  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('getOllamaConfig defaults to http://127.0.0.1:11434, qwen3.5:4b, and 300000ms', () => {
  const prevUrl = process.env.OLLAMA_BASE_URL;
  const prevModel = process.env.OLLAMA_MODEL;
  const prevTimeout = process.env.OLLAMA_TIMEOUT_MS;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_TIMEOUT_MS;

  try {
    const cfg = getOllamaConfig();
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(cfg.model, 'qwen3.5:4b');
    assert.equal(cfg.timeoutMs, 300000);
  } finally {
    if (prevUrl !== undefined) process.env.OLLAMA_BASE_URL = prevUrl;
    if (prevModel !== undefined) process.env.OLLAMA_MODEL = prevModel;
    if (prevTimeout !== undefined) process.env.OLLAMA_TIMEOUT_MS = prevTimeout;
  }
});

test('validateOllamaInput enforces USDT symbol, positive price, finite score, and rejects invalid numeric features', () => {
  const valid = validateOllamaInput({
    symbol: ' btcusdt ',
    quant: {
      direction: 'BUY',
      score: 78,
      price: 95000.5,
      rsi: 58.2,
      ema9: null,
      volume24h: 1500000000,
    },
  });

  assert.equal(valid.symbol, 'BTCUSDT');
  assert.equal(valid.quant.score, 78);
  assert.equal(valid.quant.price, 95000.5);
  assert.equal(valid.quant.rsi, 58.2);
  assert.equal(valid.quant.volume24h, 1500000000);
  assert.equal(valid.quant.ema9, undefined);

  assert.throws(
    () => validateOllamaInput({ symbol: 'BTCUSD', quant: { price: 95000, score: 70 } }),
    (err: any) => err instanceof OllamaServiceError && err.statusCode === 400 && err.code === 'INVALID_SYMBOL'
  );

  assert.throws(
    () => validateOllamaInput({ symbol: 'BTCUSDT', quant: { price: -1, score: 70 } }),
    (err: any) => err instanceof OllamaServiceError && err.statusCode === 400 && err.code === 'MISSING_FEATURES'
  );

  assert.throws(
    () => validateOllamaInput({ symbol: 'BTCUSDT', quant: { price: 95000 } }),
    (err: any) => err instanceof OllamaServiceError && err.statusCode === 400 && err.code === 'MISSING_FEATURES'
  );

  assert.throws(
    () => validateOllamaInput({ symbol: 'BTCUSDT', quant: { price: 95000, score: 'bad' } }),
    (err: any) => err instanceof OllamaServiceError && err.statusCode === 400 && err.code === 'INVALID_FEATURE'
  );
});

test('validateOllamaInput sanitizes optional closed-trade learning context', () => {
  const valid = validateOllamaInput({
    symbol: 'BTCUSDT',
    quant: { direction: 'BUY', score: 78, price: 95000 },
    learning: {
      overall: { sampleCount: 10, wins: 6, losses: 3, flats: 1, winRatePct: 66.7, avgNetPnl: 2.35 },
      symbol: { sampleCount: 4, wins: 2, losses: 1, flats: 1, winRatePct: 66.7, avgNetPnl: 0.42 },
      recentOutcomes: [
        { side: 'BUY', outcome: 'WIN' },
        { side: 'SELL', outcome: 'LOSS' },
        { side: 'IGNORE', outcome: 'WIN' },
      ],
    },
  });
  assert.equal(valid.learning?.overall.sampleCount, 10);
  assert.equal(valid.learning?.symbol.winRatePct, 66.7);
  assert.deepEqual(valid.learning?.recentOutcomes, [
    { side: 'BUY', outcome: 'WIN' },
    { side: 'SELL', outcome: 'LOSS' },
  ]);

  const invalid = validateOllamaInput({
    symbol: 'BTCUSDT',
    quant: { direction: 'BUY', score: 78, price: 95000 },
    learning: {
      overall: { sampleCount: 2, wins: 3, losses: 0, flats: 0, winRatePct: 150, avgNetPnl: 0 },
      symbol: { sampleCount: 1, wins: 1, losses: 0, flats: 0, winRatePct: 100, avgNetPnl: 0 },
      recentOutcomes: [{ side: 'BUY', outcome: 'WIN' }],
    },
  });
  assert.equal(invalid.learning, undefined);
});

test('getOllamaStatus reports READY, MODEL_NOT_INSTALLED, and OFFLINE accurately', async () => {
  const ready = await getOllamaStatus({
    get: async () => ({ data: { models: [{ name: 'qwen3.5:4b' }] } }) as any,
    post: async () => ({}) as any,
  });
  assert.equal(ready.success, true);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.model, 'qwen3.5:4b');

  const missing = await getOllamaStatus({
    get: async () => ({ data: { models: [{ name: 'llama3.2:3b' }] } }) as any,
    post: async () => ({}) as any,
  });
  assert.equal(missing.success, true);
  assert.equal(missing.status, 'MODEL_NOT_INSTALLED');

  const offline = await getOllamaStatus({
    get: async () => {
      const err: any = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    post: async () => ({}) as any,
  });
  assert.equal(offline.success, false);
  assert.equal(offline.status, 'OFFLINE');
});

test('analyzeWithOllama sends think:false, num_ctx:2048, num_predict:160 and enforces single-concurrency 429 lock released in finally', async () => {
  let capturedBody: any = null;
  let capturedConfig: any = null;
  let releaseUpstream!: () => void;
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });

  const slowClient: OllamaHttpClient = {
    get: async () => ({ data: { models: [{ name: 'qwen3.5:4b' }] } }) as any,
    post: async (_url, body, cfg) => {
      capturedBody = body;
      capturedConfig = cfg;
      await upstreamGate;
      return {
        data: {
          model: 'qwen3.5:4b',
          message: {
            content: JSON.stringify({
              symbol: 'ETHUSDT',
              decision: 'BUY',
              marketRegime: 'TRENDING_UP',
              sentiment: 'NOT_PROVIDED',
              confidence: 0.72,
              riskFlags: ['Elevated intraday ATR'],
              rationale: 'EMA alignment and positive MACD support upward momentum.',
            }),
          },
        },
      } as any;
    },
  };

  const { server, baseUrl } = await startTestApp(slowClient);
  try {
    const firstPromise = fetch(`${baseUrl}/api/agent/ollama/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'ETHUSDT',
        quant: { direction: 'BUY', score: 81, price: 3250, rsi: 61.5 },
        learning: {
          overall: { sampleCount: 10, wins: 6, losses: 3, flats: 1, winRatePct: 66.7, avgNetPnl: 2.35 },
          symbol: { sampleCount: 4, wins: 2, losses: 1, flats: 1, winRatePct: 66.7, avgNetPnl: 0.42 },
          recentOutcomes: [{ side: 'BUY', outcome: 'WIN' }],
        },
      }),
    });

    // Wait a tick so first request enters slow upstream call
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(isOllamaBusy(), true);

    const secondRes = await fetch(`${baseUrl}/api/agent/ollama/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'BTCUSDT',
        quant: { direction: 'SELL', score: 75, price: 94000 },
      }),
    });
    assert.equal(secondRes.status, 429);
    const secondJson: any = await secondRes.json();
    assert.equal(secondJson.code, 'OLLAMA_BUSY');

    releaseUpstream();
    const firstRes = await firstPromise;
    assert.equal(firstRes.status, 200);
    const firstJson: any = await firstRes.json();
    assert.equal(firstJson.success, true);
    assert.equal(firstJson.cached, false);
    assert.equal(firstJson.analysis.symbol, 'ETHUSDT');
    assert.equal(firstJson.analysis.decision, 'BUY');
    assert.equal(isOllamaBusy(), false);

    assert.equal(capturedBody.think, false);
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.keep_alive, '10m');
    assert.equal(capturedBody.options.temperature, 0);
    assert.equal(capturedBody.options.num_ctx, 2048);
    assert.equal(capturedBody.options.num_predict, 160);
    const sentContext = JSON.parse(capturedBody.messages[1].content);
    assert.equal(sentContext.historicalLearning.overall.sampleCount, 10);
    assert.equal(sentContext.historicalLearning.symbol.winRatePct, 66.7);
    assert.deepEqual(sentContext.historicalLearning.recentOutcomes, [
      { side: 'BUY', outcome: 'WIN' },
    ]);
    assert.equal(capturedConfig.timeout, 300000);
  } finally {
    server.close();
  }
});

test('POST /api/agent/ollama/analyze returns 503 when Ollama is down and releases lock cleanly', async () => {
  const downClient: OllamaHttpClient = {
    get: async () => ({ data: {} }) as any,
    post: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    },
  };

  await assert.rejects(
    () =>
      analyzeWithOllama(
        { symbol: 'BTCUSDT', quant: { direction: 'BUY', score: 74, price: 95000 } },
        downClient
      ),
    (err: any) => err instanceof OllamaServiceError && err.statusCode === 503 && err.code === 'OLLAMA_UNAVAILABLE'
  );
  assert.equal(isOllamaBusy(), false);
});

test('POST /api/agent/ollama/analyze enforces validateMutationOrigin when supplied', async () => {
  const okClient: OllamaHttpClient = {
    get: async () => ({ data: {} }) as any,
    post: async () => ({ data: {} }) as any,
  };
  const { server, baseUrl } = await startTestApp(okClient, false);
  try {
    const res = await fetch(`${baseUrl}/api/agent/ollama/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'BTCUSDT',
        quant: { direction: 'BUY', score: 74, price: 95000 },
      }),
    });
    assert.equal(res.status, 403);
    const json: any = await res.json();
    assert.equal(json.code, 'ORIGIN_REJECTED');
  } finally {
    server.close();
  }
});
