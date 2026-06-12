/**
 * TRITON Strategy Skill — runnable demo (Track 2, BNB HACK 2026)
 *
 * Ejecuta la estrategia COMPLETA de la spec (mismo motor que opera en vivo
 * en Track 1) sobre datos de mercado frescos y emite la tabla de decisiones.
 *
 *   npx tsx skill/run-skill.ts            # CMC si hay CMC_API_KEY; si no, modo keyless
 *   npx tsx skill/run-skill.ts --keyless  # fuerza datos públicos (Binance + alternative.me)
 *
 * Con clave CMC usa las MISMAS superficies que el agente vivo (quotes/latest,
 * fear-and-greed/latest, trending). El modo keyless existe para que un juez
 * pueda ejecutar el Skill en 30 segundos sin registrar nada.
 */
import "dotenv/config";
process.env.TRITON_BACKTEST = "1"; // demo: no contaminar el journal del agente

// Configuración DE CONCURSO clavada (la misma que corre el campeón en vivo;
// ver STRATEGY_SPEC §0). Solo se fija si el entorno no la trae ya.
const CONTEST_KNOBS: Record<string, string> = {
  TEST_EARLY_VOL: "1",
  TEST_NEUTRAL_TH: "2",
  TEST_FEAR_TH: "5",
  TEST_VOL_SIZING: "1",
  TEST_BULL_MODE: "1",
  TEST_BULL_FG: "45",
  TEST_BULL_STOP: "15",
  TEST_BULL_7D: "10",
};
for (const [k, v] of Object.entries(CONTEST_KNOBS)) if (process.env[k] == null) process.env[k] = v;

import { config } from "../src/config.js";
import { decide } from "../src/strategy/engine.js";
import { applyRisk } from "../src/risk/manager.js";
import type { MarketContext, Portfolio, TokenSignal } from "../src/types.js";

const KEYLESS = process.argv.includes("--keyless") || !config.cmcApiKey;

interface Candle {
  t: number;
  price: number;
  vol: number;
}

async function binanceCandles(sym: string, hours: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = Date.now() - hours * 3600_000;
  while (out.length < hours) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=1000&startTime=${start}`;
    const batch = (await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).json()) as any[];
    if (!batch.length) break;
    for (const k of batch) out.push({ t: k[0], price: +k[4], vol: +k[7] });
    start = batch[batch.length - 1][0] + 3600_000;
    if (batch.length < 1000) break;
  }
  return out;
}

async function main() {
  const universe = Object.keys(config.watchlist);
  console.log(`# TRITON Strategy Skill — decision table`);
  console.log(`Generated: ${new Date().toISOString()} · mode: ${KEYLESS ? "keyless (Binance + alternative.me)" : "CMC (quotes/latest + fear-and-greed + trending)"}`);
  console.log(`Universe: ${universe.join(", ")}\n`);

  // 1) Memoria rodante (extremos 48h/168h, rango 24h) — siempre de velas
  //    públicas: el agente vivo la construye de su propio log de señales.
  const series = new Map<string, Candle[]>();
  for (const sym of universe) series.set(sym, await binanceCandles(sym, 170));

  const high48h: Record<string, number> = {};
  const low48h: Record<string, number> = {};
  const high168h: Record<string, number> = {};
  const range24hPct: Record<string, number> = {};
  for (const [sym, c] of series) {
    if (c.length < 169) continue;
    const last = c.length - 1;
    let h48 = 0, lo48 = Infinity, h168 = 0, h24 = 0, l24 = Infinity;
    for (let j = Math.max(0, last - 168); j < last; j++) {
      h168 = Math.max(h168, c[j].price);
      if (j >= last - 48) { h48 = Math.max(h48, c[j].price); lo48 = Math.min(lo48, c[j].price); }
      if (j >= last - 24) { h24 = Math.max(h24, c[j].price); l24 = Math.min(l24, c[j].price); }
    }
    high48h[sym] = h48;
    low48h[sym] = lo48;
    high168h[sym] = h168;
    range24hPct[sym] = l24 > 0 && l24 < Infinity ? ((h24 - l24) / l24) * 100 : 0;
  }

  // 2) Señales frescas + régimen
  let ctx: MarketContext;
  if (!KEYLESS) {
    const { fetchMarketContext } = await import("../src/signals/cmc.js");
    ctx = await fetchMarketContext();
  } else {
    const signals: TokenSignal[] = [];
    for (const [sym, c] of series) {
      const i = c.length - 1;
      if (i < 168) continue;
      let vol24 = 0, vol24prev = 0;
      for (let j = i - 24; j < i; j++) vol24 += c[j].vol;
      for (let j = i - 48; j < i - 24; j++) vol24prev += c[j].vol;
      signals.push({
        symbol: sym,
        cmcId: config.watchlist[sym].id,
        priceUsd: c[i].price,
        percentChange1h: (c[i].price / c[i - 1].price - 1) * 100,
        percentChange24h: (c[i].price / c[i - 24].price - 1) * 100,
        percentChange7d: (c[i].price / c[i - 168].price - 1) * 100,
        volume24h: vol24,
        volumeChange24h: vol24prev > 0 ? (vol24 / vol24prev - 1) * 100 : 0,
        marketCap: 0,
        timestamp: new Date(c[i].t).toISOString(),
      });
    }
    const fg = (await (await fetch("https://api.alternative.me/fng/?limit=1&format=json", { signal: AbortSignal.timeout(15_000) })).json()) as any;
    ctx = {
      signals,
      fearGreedValue: Number(fg.data?.[0]?.value ?? 50),
      fearGreedLabel: String(fg.data?.[0]?.value_classification ?? ""),
      trending: [],
    };
  }
  ctx.high48h = high48h;
  ctx.low48h = low48h;
  ctx.high168h = high168h;
  ctx.range24hPct = range24hPct;
  for (const s of ctx.signals) s.range24hPct = range24hPct[s.symbol];

  // 3) Motor real: estrategia + overlay de riesgo sobre un libro virgen
  const portfolio: Portfolio = {
    cashUsd: config.paperStartingUsd,
    positions: [],
    realizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlDate: new Date().toISOString().slice(0, 10),
    history: [],
    peakEquityUsd: config.paperStartingUsd,
  };
  const decisions = decide(ctx, portfolio);
  const { orders, blocked } = applyRisk(decisions, portfolio, ctx.signals);

  console.log(`Market regime: F&G ${ctx.fearGreedValue} (${ctx.fearGreedLabel || "—"}) · marketAvg7d ${(ctx.signals.reduce((s, x) => s + x.percentChange7d, 0) / ctx.signals.length).toFixed(2)}%\n`);
  console.log(`| token | action | conf | module | price | 1h | 24h | 7d | reasoning |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const d of decisions) {
    const s = d.signal;
    console.log(
      `| ${d.symbol} | ${d.action} | ${d.confidence.toFixed(2)} | ${d.strategy ?? "—"} | $${s.priceUsd.toFixed(4)} | ${s.percentChange1h.toFixed(2)}% | ${s.percentChange24h.toFixed(2)}% | ${s.percentChange7d.toFixed(2)}% | ${d.reasons[0]} |`,
    );
  }
  if (blocked.length) {
    console.log(`\n## Blocked by the risk overlay (every veto is part of the deliverable)`);
    for (const b of blocked) console.log(`- ${b.decision.symbol} ${b.decision.action}: ${b.why}`);
  }
  console.log(`\n## Executable orders this tick: ${orders.length || "none — cash is a position"}`);
  for (const o of orders) console.log(`- ${o.side} ${o.symbol} $${o.amountUsd.toFixed(2)} @ $${o.priceUsd.toFixed(4)} (${o.reason})`);
  console.log(`\nReproduce the evidence: npx tsx scripts/backtest-year.ts 90 (full contest conditions incl. real fees + daily-trade rule via TEST_COMPLIANCE=best)`);
  console.log(`Live proof (same engine, Track 1): https://triton-dashboard.vercel.app`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
