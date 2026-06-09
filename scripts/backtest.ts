/**
 * Backtest de la estrategia de Triton con datos histÃ³ricos horarios de CMC.
 *
 * Requiere un plan de CMC con histÃ³ricos (Hobbyist/Startup+).
 * Uso: npm run backtest [-- dÃ­as]   (por defecto 30)
 *
 * Reutiliza EXACTAMENTE el mismo motor que el agente en vivo:
 * decide() + applyRisk() + applyFill(). Lo Ãºnico simulado es el feed.
 */
import "dotenv/config";
import { config, RISK_LIMITS } from "../src/config.js";
import { decide } from "../src/strategy/engine.js";
import { applyRisk } from "../src/risk/manager.js";
import { applyFill, simulatedFee } from "../src/state/portfolio.js";
import type { MarketContext, Portfolio, TokenSignal } from "../src/types.js";

const DAYS = Number(process.argv[2] ?? 30);
const WARMUP_H = 169; // 7d + 1h para poder calcular percentChange7d
const BASE = "https://pro-api.coinmarketcap.com";

async function cmcGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey } });
  if (!res.ok) throw new Error(`CMC ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface HistPoint {
  t: number;
  price: number;
  vol24h: number;
}

async function fetchHistory(cmcId: number): Promise<HistPoint[]> {
  const count = DAYS * 24 + WARMUP_H;
  // CachÃ© en disco (1h de vigencia) para iterar en los parÃ¡metros sin
  // quemar crÃ©ditos de API en cada ejecuciÃ³n.
  const { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } = await import("node:fs");
  const cacheFile = `data/hist-cache-${cmcId}-${count}.json`;
  if (existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < 3600_000) {
    return JSON.parse(readFileSync(cacheFile, "utf-8"));
  }
  const res = await cmcGet<{
    data: { quotes: { timestamp: string; quote: { USD: { price: number; volume_24h: number } } }[] };
  }>("/v2/cryptocurrency/quotes/historical", {
    id: String(cmcId),
    interval: "1h",
    count: String(Math.min(count, 10000)),
  });
  const points = res.data.quotes.map((q) => ({
    t: new Date(q.timestamp).getTime(),
    price: q.quote.USD.price,
    vol24h: q.quote.USD.volume_24h,
  }));
  mkdirSync("data", { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(points));
  return points;
}

async function fetchFearGreedHistory(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await cmcGet<{ data: { timestamp: string; value: number }[] }>(
      "/v3/fear-and-greed/historical",
      { limit: String(DAYS + 8) },
    );
    for (const d of res.data) {
      const ts = Number(d.timestamp);
      const day = new Date((Number.isFinite(ts) && ts > 1e9 ? ts * 1000 : Date.parse(d.timestamp))).toISOString().slice(0, 10);
      map.set(day, d.value);
    }
  } catch (err) {
    console.warn("F&G histÃ³rico no disponible (se usa 50/Neutral):", (err as Error).message);
  }
  return map;
}

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

async function main(): Promise<void> {
  console.log(`Backtest: ${DAYS} dÃ­as, watchlist=${Object.keys(config.watchlist).join(",")}`);

  const histories = new Map<string, HistPoint[]>();
  for (const [sym, t] of Object.entries(config.watchlist)) {
    histories.set(sym, await fetchHistory(t.id));
    console.log(`  ${sym}: ${histories.get(sym)!.length} puntos`);
  }
  const fgByDay = await fetchFearGreedHistory();

  const len = Math.min(...[...histories.values()].map((h) => h.length));
  const portfolio: Portfolio = {
    cashUsd: config.paperStartingUsd,
    positions: [],
    realizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlDate: "",
    history: [],
  };

  let peak = config.paperStartingUsd;
  let maxDd = 0;
  let blockedCount = 0;

  for (let i = WARMUP_H; i < len; i++) {
    const signals: TokenSignal[] = [];
    let ts = 0;
    for (const [sym, h] of histories) {
      const p = h[i];
      ts = p.t;
      signals.push({
        symbol: sym,
        cmcId: config.watchlist[sym].id,
        priceUsd: p.price,
        percentChange1h: pct(h[i - 1].price, p.price),
        percentChange24h: pct(h[i - 24].price, p.price),
        percentChange7d: pct(h[i - 168].price, p.price),
        volume24h: p.vol24h,
        volumeChange24h: h[i - 24].vol24h > 0 ? pct(h[i - 24].vol24h, p.vol24h) : 0,
        marketCap: 0,
        timestamp: new Date(p.t).toISOString(),
      });
    }

    const day = new Date(ts).toISOString().slice(0, 10);
    if (portfolio.dailyPnlDate !== day) {
      portfolio.dailyPnlDate = day;
      portfolio.dailyPnlUsd = 0;
    }
    const fg = fgByDay.get(day) ?? 50;
    const ctx: MarketContext = { signals, fearGreedValue: fg, fearGreedLabel: String(fg), trending: [] };

    const decisions = decide(ctx, portfolio);
    const { orders, blocked } = applyRisk(decisions, portfolio, signals);
    blockedCount += blocked.length;

    for (const order of orders) {
      applyFill(portfolio, {
        order,
        executedAt: new Date(ts).toISOString(),
        fee: simulatedFee(order),
      });
    }

    const total =
      portfolio.cashUsd +
      portfolio.positions.reduce((s, pos) => {
        const sig = signals.find((x) => x.symbol === pos.symbol);
        return s + pos.qty * (sig?.priceUsd ?? pos.avgEntryUsd);
      }, 0);
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, (peak - total) / peak);
  }

  // LiquidaciÃ³n final a Ãºltimo precio para PnL total comparable
  const lastSignals: TokenSignal[] = [...histories.entries()].map(([sym, h]) => ({
    symbol: sym,
    cmcId: config.watchlist[sym].id,
    priceUsd: h[len - 1].price,
    percentChange1h: 0,
    percentChange24h: 0,
    percentChange7d: 0,
    volume24h: 0,
    volumeChange24h: 0,
    marketCap: 0,
    timestamp: "",
  }));
  const finalTotal =
    portfolio.cashUsd +
    portfolio.positions.reduce((s, pos) => {
      const sig = lastSignals.find((x) => x.symbol === pos.symbol);
      return s + pos.qty * (sig?.priceUsd ?? pos.avgEntryUsd);
    }, 0);

  const closed = portfolio.history.filter((f) => f.order.side === "SELL");
  const wins = closed.filter((f) => (f.realizedPnlUsd ?? 0) > 0).length;
  const bySymbol = new Map<string, number>();
  for (const f of closed) {
    bySymbol.set(f.order.symbol, (bySymbol.get(f.order.symbol) ?? 0) + (f.realizedPnlUsd ?? 0));
  }

  // Benchmark: buy & hold equiponderado de la watchlist en la misma ventana
  let bhReturn = 0;
  for (const h of histories.values()) {
    bhReturn += pct(h[WARMUP_H].price, h[len - 1].price) / histories.size;
  }

  console.log("\n========== RESULTADO ==========");
  console.log(`Capital inicial : $${config.paperStartingUsd.toFixed(2)}`);
  console.log(`Capital final   : $${finalTotal.toFixed(2)} (${pct(config.paperStartingUsd, finalTotal).toFixed(2)}%)`);
  console.log(`Buy & hold      : ${bhReturn.toFixed(2)}% (watchlist equiponderada, misma ventana)`);
  console.log(`Alpha           : ${(pct(config.paperStartingUsd, finalTotal) - bhReturn).toFixed(2)} puntos`);
  console.log(`Max drawdown    : -${(maxDd * 100).toFixed(2)}%`);
  console.log(`Trades          : ${portfolio.history.length} (${closed.length} cierres, win rate ${closed.length ? ((wins / closed.length) * 100).toFixed(0) : "â€”"}%)`);
  console.log(`Bloqueos riesgo : ${blockedCount}`);
  console.log("PnL por sÃ­mbolo :");
  for (const [sym, pnl] of [...bySymbol.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sym.padEnd(5)} $${pnl.toFixed(2)}`);
  }
  console.log(`\nLÃ­mites: SL ${RISK_LIMITS.stopLossPct * 100}% | trail ${RISK_LIMITS.trailingStopPct * 100}% (act. +${RISK_LIMITS.trailingActivationPct * 100}%) | cap diario ${RISK_LIMITS.dailyLossCapPct * 100}%`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
