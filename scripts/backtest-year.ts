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

// Identidad de harness: silencia el trade-journal del agente real (worklist 6)
process.env.TRITON_BACKTEST = "1";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { config, RISK_LIMITS } from "../src/config.js";
import { decide, momentumScore } from "../src/strategy/engine.js";
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
  // Worklist 4: serie COMPLETA con caché en disco (12h) y fallback a caché
  // vieja — el fallback silencioso a 50 enmascaraba huecos de cobertura.
  const cacheF = "data/fng-cache.json";
  let rows: { value: string; timestamp: string }[] | null = null;
  if (existsSync(cacheF) && Date.now() - statSync(cacheF).mtimeMs < 12 * 3600_000) {
    rows = JSON.parse(readFileSync(cacheF, "utf-8"));
  } else {
    try {
      const res = await fetch(`https://api.alternative.me/fng/?limit=0&format=json`, {
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json()) as { data: { value: string; timestamp: string }[] };
      rows = data.data;
      mkdirSync("data", { recursive: true });
      writeFileSync(cacheF, JSON.stringify(rows));
    } catch {
      rows = existsSync(cacheF) ? JSON.parse(readFileSync(cacheF, "utf-8")) : null;
      console.warn(rows ? "F&G API caída — usando caché vieja" : "F&G no disponible (ni caché) — todo el período usará 50");
    }
  }
  const map = new Map<string, number>();
  for (const d of rows ?? []) {
    map.set(new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10), Number(d.value));
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

  // Alineación por TIMESTAMP (worklist 4): con históricos de longitud
  // desigual, indexar todos por i desfasaba a los tokens cortos (suite
  // 2000d: CAKE +69d, TWT +46d). Se recorta el arranque de todas las series
  // al inicio común más tardío y se verifica la rejilla horaria.
  const maxStart = Math.max(...[...series.values()].map((s) => s[0].t));
  for (const [sym, s] of series) {
    const k = s.findIndex((c) => c.t >= maxStart);
    if (k > 0) {
      series.set(sym, s.slice(k));
      console.log(`  ${sym}: recortadas ${k} velas iniciales para alinear (${(k / 24).toFixed(0)}d)`);
    }
  }
  const len = Math.min(...[...series.values()].map((s) => s.length));
  const ref = [...series.values()][0];
  for (const [sym, s] of series) {
    for (const i of [0, len >> 1, len - 1]) {
      if (s[i].t !== ref[i].t) {
        console.warn(`  ⚠️ ${sym}: rejilla horaria desalineada en i=${i} (huecos en el histórico) — resultados sospechosos`);
        break;
      }
    }
  }
  const fngMiss = new Set<string>();

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

  // TEST_COMPLIANCE (lab, 12-jun): simula la regla del concurso "mínimo
  // 1 trade/día" — hueco de fidelidad: el harness nunca pagaba este peaje.
  // Políticas: "eth" (gesto actual del agente: $12 del token de compliance a
  // las 18 UTC si no hubo trade), "best" (oportunista: $12 al mejor momentum
  // no tenido — una entrada marginal diaria), "roundtrip" (ida y vuelta:
  // compra el gesto y lo vende al tick siguiente — coste fijo, sin deriva).
  const COMPLIANCE = process.env.TEST_COMPLIANCE ?? ""; // "" = sin simular (histórico)
  const EVENTLOG = process.env.TEST_EVENTLOG === "1";
  const buyEvents: { sym: string; i: number }[] = [];
  const stopEvents: { sym: string; i: number }[] = [];
  let lastTradeDay = "";
  let complianceBuys = 0;
  let complianceSells = 0;
  let rtPending: { symbol: string; qty: number } | null = null;

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
    if (!fng.has(day)) fngMiss.add(day);
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
    // TEST_ONLY_SYMBOLS vive ahora en el ENGINE (12-jun) — el mismo filtro
    // aplica en backtest y en vivo (el retador lo usa en el A/B del cuarteto).
    const decisions = decide(ctx, portfolio);
    const { orders } = applyRisk(decisions, portfolio, signals, ts);
    for (const order of orders) {
      applyFill(portfolio, { order, executedAt: new Date(ts).toISOString(), fee: simulatedFee(order) });
      // TEST_EVENTLOG: registra entradas momentum y salidas por stop con su
      // índice, para el "event study" del camino de precio alrededor (¿el bot
      // compra picos locales y vende mínimos locales?). Diagnóstico post-hoc.
      if (EVENTLOG) {
        if (order.side === "BUY" && /^momentum=/.test(order.reason)) buyEvents.push({ sym: order.symbol, i });
        else if (order.side === "SELL" && order.reason.startsWith("STOP-LOSS")) stopEvents.push({ sym: order.symbol, i });
      }
    }
    if (orders.length) lastTradeDay = day;

    if (COMPLIANCE) {
      // Cierre pendiente del roundtrip (un tick después de su compra)
      if (rtPending) {
        const pos = portfolio.positions.find((p) => p.symbol === rtPending.symbol);
        if (pos) {
          const px = series.get(rtPending.symbol)![i].price;
          const o = { symbol: rtPending.symbol, side: "SELL" as const, amountUsd: pos.qty * px, priceUsd: px, qty: pos.qty, reason: "COMPLIANCE-RT: cierre del gesto" };
          applyFill(portfolio, { order: o, executedAt: new Date(ts).toISOString(), fee: simulatedFee(o) });
          complianceSells++;
          lastTradeDay = day;
        }
        rtPending = null;
      }
      if (day !== lastTradeDay && new Date(ts).getUTCHours() >= config.complianceHourUtc) {
        let sym = config.complianceSymbol;
        if (COMPLIANCE === "best") {
          // mejor momentum NO tenido (misma función que usa el agente)
          let bestScore = -Infinity;
          for (const s of signals) {
            if (portfolio.positions.some((p) => p.symbol === s.symbol)) continue;
            const sc = momentumScore(s);
            if (sc > bestScore) {
              bestScore = sc;
              sym = s.symbol;
            }
          }
        }
        const c = series.get(sym);
        if (c) {
          const px = c[i].price;
          if (portfolio.cashUsd >= config.complianceTradeUsd) {
            const wasNew = !portfolio.positions.some((p) => p.symbol === sym);
            const o = { symbol: sym, side: "BUY" as const, amountUsd: config.complianceTradeUsd, priceUsd: px, qty: config.complianceTradeUsd / px, reason: "COMPLIANCE: mínimo 1 trade/día" };
            applyFill(portfolio, { order: o, executedAt: new Date(ts).toISOString(), fee: simulatedFee(o) });
            complianceBuys++;
            lastTradeDay = day;
            if (COMPLIANCE === "roundtrip" && wasNew) rtPending = { symbol: sym, qty: o.qty };
          } else {
            // sin cash: cierre de la posición más pequeña (réplica del agente)
            const smallest = [...portfolio.positions].sort((a, b) => a.qty * a.avgEntryUsd - b.qty * b.avgEntryUsd)[0];
            if (smallest) {
              const spx = series.get(smallest.symbol)![i].price;
              const o = { symbol: smallest.symbol, side: "SELL" as const, amountUsd: smallest.qty * spx, priceUsd: spx, qty: smallest.qty, reason: "COMPLIANCE: cierre (sin cash)" };
              applyFill(portfolio, { order: o, executedAt: new Date(ts).toISOString(), fee: simulatedFee(o) });
              complianceSells++;
              lastTradeDay = day;
            }
          }
        }
      }
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
  if (fngMiss.size > 0)
    console.log(`⚠️ F&G sin dato  : ${fngMiss.size} días del período usaron 50 (cobertura ${(100 - (fngMiss.size / (DAYS || 1)) * 100).toFixed(1)}%)`);
  console.log(`Capital         : $${start.toFixed(2)} -> $${final.toFixed(2)} (${((final / start - 1) * 100).toFixed(1)}%)`);
  console.log(`Buy & hold      : ${bh.toFixed(1)}%`);
  console.log(`Max drawdown    : -${(maxDd * 100).toFixed(1)}%`);
  console.log(`Trades          : ${portfolio.history.length} (${closed.length} cierres, WR ${closed.length ? ((wins / closed.length) * 100).toFixed(0) : "—"}%)`);
  if (COMPLIANCE) console.log(`Compliance      : política "${COMPLIANCE}" — ${complianceBuys} compras + ${complianceSells} cierres forzados`);
  console.log("\n---------- DISTRIBUCIÓN DE SEMANAS (ventanas 7d) ----------");
  console.log(`Semanas medidas : ${weekly.length} | en positivo: ${posWeeks} (${((posWeeks / weekly.length) * 100).toFixed(0)}%)`);
  console.log(`Peor semana     : ${q(0).toFixed(1)}%`);
  console.log(`Percentil 25    : ${q(0.25).toFixed(1)}%`);
  console.log(`Mediana         : ${q(0.5).toFixed(1)}%`);
  console.log(`Percentil 75    : ${q(0.75).toFixed(1)}%`);
  console.log(`Mejor semana    : ${weekly[weekly.length - 1].toFixed(1)}%`);

  if (EVENTLOG) {
    const study = (events: { sym: string; i: number }[], offs: number[]) => {
      const sum = new Map<number, number>();
      const cnt = new Map<number, number>();
      for (const ev of events) {
        const c = series.get(ev.sym);
        if (!c) continue;
        const base = c[ev.i]?.price;
        if (!base) continue;
        for (const o of offs) {
          const k = ev.i + o;
          if (k < 0 || k >= c.length) continue;
          sum.set(o, (sum.get(o) ?? 0) + ((c[k].price / base - 1) * 100));
          cnt.set(o, (cnt.get(o) ?? 0) + 1);
        }
      }
      return offs.map((o) => `t${o >= 0 ? "+" : ""}${o}h:${((sum.get(o) ?? 0) / (cnt.get(o) || 1)).toFixed(2)}`).join("  ");
    };
    const offs = [-6, -3, -1, 0, 1, 3, 6, 12, 24];
    console.log(`\n---------- EVENT STUDY (camino de precio %, base=0 en la ejecución) ----------`);
    console.log(`ENTRADAS momentum (n=${buyEvents.length}):  ${study(buyEvents, offs)}`);
    console.log(`SALIDAS por STOP  (n=${stopEvents.length}):  ${study(stopEvents, offs)}`);
    console.log(`Lectura: si tras la ENTRADA (t>0) el precio baja, compra picos; si tras la SALIDA-stop (t>0) sube, vende mínimos.`);

    // ESPEJO PERFECTO en los timestamps EXACTOS de las señales (hipótesis del
    // operador: "vender donde compra, comprar donde vende = ganador"). Mide el
    // PnL de SHORT en cada BUY y LONG en cada SELL, a fee real RT, varios H.
    const FEE_RT = RISK_LIMITS.simulatedFeePct * 200; // % ida+vuelta
    const mirror = (H: number) => {
      let short = 0, sn = 0, long = 0, ln = 0;
      for (const ev of buyEvents) {
        const c = series.get(ev.sym); if (!c || ev.i + H >= c.length) continue;
        short += -((c[ev.i + H].price / c[ev.i].price - 1) * 100) - FEE_RT; sn++; // short = -ret
      }
      for (const ev of stopEvents) {
        const c = series.get(ev.sym); if (!c || ev.i + H >= c.length) continue;
        long += ((c[ev.i + H].price / c[ev.i].price - 1) * 100) - FEE_RT; ln++; // long
      }
      return `H${H}h: SHORT@compra ${(short / (sn || 1)).toFixed(2)}%/op (acum ${short.toFixed(0)})  ·  LONG@venta ${(long / (ln || 1)).toFixed(2)}%/op (acum ${long.toFixed(0)})`;
    };
    console.log(`\n---------- ESPEJO PERFECTO en timestamps exactos (fee real ${FEE_RT.toFixed(1)}% RT) ----------`);
    for (const H of [6, 24, 48]) console.log(`  ${mirror(H)}`);
    console.log(`Lectura: si SHORT@compra y LONG@venta son POSITIVOS, hacer lo opuesto en esos instantes gana (¡pero short NO es ejecutable en spot!).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
