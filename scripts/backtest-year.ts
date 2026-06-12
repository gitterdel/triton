/**
 * Backtest de LARGO PLAZO (hasta 12 meses) con datos gratuitos:
 *  - velas 1h de Binance (data-api.binance.vision, sin key)
 *  - Fear & Greed histórico de alternative.me (gratis, serie completa)
 *
 * Mismo motor real (decide/applyRisk/applyFill). Además de las métricas
 * globales, trocea el período en ventanas RODANTES DE 7 DÍAS para responder
 * la pregunta de competición: "¿qué da este bot en una semana?"
 *
 * Uso: npx tsx scripts/backtest-year.ts [días]   (default 365)
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { config } from "../src/config.js";
import { decide } from "../src/strategy/engine.js";
import { applyRisk } from "../src/risk/manager.js";
import { applyFill, simulatedFee } from "../src/state/portfolio.js";
import type { MarketContext, Portfolio, TokenSignal } from "../src/types.js";
import { taSnapshot } from "../src/strategy/ta.js";

const DAYS = Number(process.argv[2] ?? 365);
// Walk-forward: desplaza la ventana N días hacia el pasado (0 = hasta hoy).
// Permite afinar parámetros en una época y validarlos en otra NO vista.
const OFFSET = Number(process.env.TEST_WINDOW_OFFSET_DAYS ?? 0);
const END_MS = Date.now() - OFFSET * 86_400_000;
const WARMUP = 169;
const NEED = DAYS * 24 + WARMUP;

interface Candle {
  t: number;
  price: number;
  vol: number; // volumen de la vela (USDT)
}

async function fetchBinance(sym: string): Promise<Candle[] | null> {
  const cache = OFFSET ? `data/bn-cache-${sym}-${DAYS}-o${OFFSET}.json` : `data/bn-cache-${sym}-${DAYS}.json`;
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 12 * 3600_000) {
    return JSON.parse(readFileSync(cache, "utf-8"));
  }
  const out: Candle[] = [];
  let start = END_MS - NEED * 3600_000;
  try {
    while (out.length < NEED + 10 && start < END_MS) {
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=1000&startTime=${start}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const batch = (await res.json()) as any[];
      if (!batch.length) break;
      for (const k of batch) if (k[0] < END_MS) out.push({ t: k[0], price: +k[4], vol: +k[7] });
      start = batch[batch.length - 1][0] + 3600_000;
      if (batch.length < 1000) break;
    }
  } catch {
    return null;
  }
  if (out.length < NEED * 0.95) return null; // histórico incompleto (ej. delistado)
  mkdirSync("data", { recursive: true });
  writeFileSync(cache, JSON.stringify(out));
  return out;
}

async function fetchFngHistory(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${DAYS + OFFSET + 10}&format=json`, {
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json()) as { data: { value: string; timestamp: string }[] };
    for (const d of data.data) {
      map.set(new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10), Number(d.value));
    }
  } catch {
    console.warn("F&G alternative.me no disponible — usando 50");
  }
  return map;
}

// vol24h rodante a partir de volúmenes de vela 1h
function rolling24hVol(c: Candle[], i: number): number {
  let v = 0;
  for (let j = Math.max(0, i - 24); j < i; j++) v += c[j].vol;
  return v;
}

async function main() {
  console.log(`Backtest LARGO: ${DAYS} días (datos Binance + F&G alternative.me)`);
  const series = new Map<string, Candle[]>();
  for (const sym of Object.keys(config.watchlist)) {
    const s = await fetchBinance(sym);
    if (!s) {
      console.log(`  ${sym}: histórico Binance insuficiente — EXCLUIDO del test largo`);
      continue;
    }
    series.set(sym, s);
    console.log(`  ${sym}: ${s.length} velas`);
  }
  const fng = await fetchFngHistory();
  const len = Math.min(...[...series.values()].map((s) => s.length));

  const portfolio: Portfolio = {
    cashUsd: config.paperStartingUsd,
    positions: [],
    realizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlDate: "",
    history: [],
    peakEquityUsd: config.paperStartingUsd,
  };

  const equity: number[] = [];
  let peak = config.paperStartingUsd;
  let maxDd = 0;

  for (let i = WARMUP; i < len; i++) {
    const signals: TokenSignal[] = [];
    let ts = 0;
    for (const [sym, c] of series) {
      ts = c[i].t;
      const vol24 = rolling24hVol(c, i);
      const vol24prev = rolling24hVol(c, i - 24);
      signals.push({
        symbol: sym,
        cmcId: 0,
        priceUsd: c[i].price,
        percentChange1h: (c[i].price / c[i - 1].price - 1) * 100,
        percentChange24h: (c[i].price / c[i - 24].price - 1) * 100,
        percentChange7d: (c[i].price / c[i - 168].price - 1) * 100,
        volume24h: vol24,
        volumeChange24h: vol24prev > 0 ? (vol24 / vol24prev - 1) * 100 : 0,
        marketCap: 0,
        timestamp: new Date(ts).toISOString(),
      });
    }
    const day = new Date(ts).toISOString().slice(0, 10);
    if (portfolio.dailyPnlDate !== day) {
      portfolio.dailyPnlDate = day;
      portfolio.dailyPnlUsd = 0;
    }
    const high48h: Record<string, number> = {};
    const low48h: Record<string, number> = {};
    const high168h: Record<string, number> = {};
    const range24hPct: Record<string, number> = {};
    for (const [sym, c] of series) {
      let h48 = 0, lo = Infinity, h168 = 0, h24 = 0, l24 = Infinity;
      for (let j = i - 168; j < i; j++) {
        h168 = Math.max(h168, c[j].price);
        if (j >= i - 48) {
          h48 = Math.max(h48, c[j].price);
          lo = Math.min(lo, c[j].price);
        }
        if (j >= i - 24) {
          h24 = Math.max(h24, c[j].price);
          l24 = Math.min(l24, c[j].price);
        }
      }
      high48h[sym] = h48;
      low48h[sym] = lo;
      high168h[sym] = h168;
      range24hPct[sym] = l24 > 0 && l24 < Infinity ? ((h24 - l24) / l24) * 100 : 0;
    }
    for (const s of signals) s.range24hPct = range24hPct[s.symbol]; // H8/H9 adaptativos
    const ta: NonNullable<MarketContext["ta"]> = {};
    for (const [sym, c] of series) {
      const t = taSnapshot(c.slice(Math.max(0, i - 25), i).map((p) => p.price));
      if (t) ta[sym] = t;
    }
    // TEST_DONCHIAN: máximo de N días por símbolo, SOLO con ventana completa
    // (ventana parcial = máximos artificialmente bajos = falsas rupturas)
    const DONCH_N = Number(process.env.TEST_DONCHIAN ?? 0);
    let donchianHighUsd: Record<string, number> | undefined;
    if (DONCH_N > 0 && i >= DONCH_N * 24) {
      donchianHighUsd = {};
      for (const [sym, c] of series) {
        let h = 0;
        for (let j = i - DONCH_N * 24; j < i; j++) h = Math.max(h, c[j].price);
        donchianHighUsd[sym] = h;
      }
    }
    const day7ago = new Date(ts - 7 * 86_400_000).toISOString().slice(0, 10);
    const fgNow = fng.get(day) ?? 50;
    const ctx: MarketContext = {
      signals,
      fearGreedValue: fgNow,
      fearGreedDelta7d: fng.has(day) && fng.has(day7ago) ? fgNow - (fng.get(day7ago) as number) : undefined,
      fearGreedLabel: "",
      trending: [],
      high48h,
      low48h,
      high168h,
      range24hPct,
      donchianHighUsd,
      ta,
    };
    const decisions = decide(ctx, portfolio);
    const { orders } = applyRisk(decisions, portfolio, signals, ts);
    for (const order of orders) {
      applyFill(portfolio, { order, executedAt: new Date(ts).toISOString(), fee: simulatedFee(order) });
    }
    const total =
      portfolio.cashUsd +
      portfolio.positions.reduce((s, p) => {
        const c = series.get(p.symbol)!;
        return s + p.qty * c[i].price;
      }, 0);
    equity.push(total);
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, (peak - total) / peak);
  }

  const start = config.paperStartingUsd;
  const final = equity[equity.length - 1];

  // Benchmark
  let bh = 0;
  for (const c of series.values()) bh += (c[len - 1].price / c[WARMUP].price - 1) * 100 / series.size;

  // Ventanas rodantes de 7 días (168h) — la distribución de "semanas de carrera"
  const weekly: number[] = [];
  for (let i = 168; i < equity.length; i += 24) {
    weekly.push((equity[i] / equity[i - 168] - 1) * 100);
  }
  weekly.sort((a, b) => a - b);
  const q = (p: number) => weekly[Math.floor(weekly.length * p)] ?? 0;
  const posWeeks = weekly.filter((w) => w > 0).length;

  const closed = portfolio.history.filter((f) => f.order.side === "SELL");
  const wins = closed.filter((f) => (f.realizedPnlUsd ?? 0) > 0).length;

  const first = [...series.values()][0];
  const winFrom = new Date(first[WARMUP].t).toISOString().slice(0, 10);
  const winTo = new Date(first[len - 1].t).toISOString().slice(0, 10);
  console.log("\n========== RESULTADO LARGO PLAZO ==========");
  console.log(`Período         : ${DAYS} días (${winFrom} → ${winTo}${OFFSET ? `, offset ${OFFSET}d` : ""}) | tokens: ${[...series.keys()].join(",")}`);
  console.log(`Capital         : $${start.toFixed(2)} -> $${final.toFixed(2)} (${((final / start - 1) * 100).toFixed(1)}%)`);
  console.log(`Buy & hold      : ${bh.toFixed(1)}%`);
  console.log(`Max drawdown    : -${(maxDd * 100).toFixed(1)}%`);
  console.log(`Trades          : ${portfolio.history.length} (${closed.length} cierres, WR ${closed.length ? ((wins / closed.length) * 100).toFixed(0) : "—"}%)`);
  console.log("\n---------- DISTRIBUCIÓN DE SEMANAS (ventanas 7d) ----------");
  console.log(`Semanas medidas : ${weekly.length} | en positivo: ${posWeeks} (${((posWeeks / weekly.length) * 100).toFixed(0)}%)`);
  console.log(`Peor semana     : ${q(0).toFixed(1)}%`);
  console.log(`Percentil 25    : ${q(0.25).toFixed(1)}%`);
  console.log(`Mediana         : ${q(0.5).toFixed(1)}%`);
  console.log(`Percentil 75    : ${q(0.75).toFixed(1)}%`);
  console.log(`Mejor semana    : ${weekly[weekly.length - 1].toFixed(1)}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
