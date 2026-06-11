/**
 * Escaneo masivo: corre el MOTOR REAL de Triton (estrategia + riesgo +
 * contabilidad) sobre cada token elegible líquido EN SOLITARIO, con los
 * últimos 28 días de datos horarios. Responde: "¿qué habría hecho el bot
 * operando solo este token?"
 *
 * Salida: data/bot-scan.json — el dashboard la muestra en el screener.
 * Uso: npx tsx scripts/scan-universe.ts
 */
import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { config } from "../src/config.js";
import { decide } from "../src/strategy/engine.js";
import { applyRisk } from "../src/risk/manager.js";
import { applyFill, simulatedFee } from "../src/state/portfolio.js";
import type { MarketContext, Portfolio, TokenSignal } from "../src/types.js";

const BASE = "https://pro-api.coinmarketcap.com";
const MIN_MCAP = 50e6;
const MIN_VOL = 5e6;
const HOURS = 673;
const WARMUP = 169;

const STABLES = new Set(
  "USDT USDC DAI USD1 USDE USDD TUSD FDUSD U STABLE USDF FRAX FRXUSD XUSD EURI LISUSD DUSD XAUT XAUM WFI".split(" "),
);
const ELIGIBLE = new Set(
  `ETH XRP TRX DOGE ZEC ADA LINK BCH TON M LTC AVAX SHIB WLFI H DOT UNI ASTER DEXE ETC AAVE ATOM FIL INJ NIGHT FET BONK PENGU CAKE SIREN LUNC ZRO KITE BEAT PIEVERSE BTT NFT EDGE FLOKI LDO B FF PENDLE NEX STG AXS TWT HOME RAY COMP GWEI XCN GENIUS XPL BAT SKYAI APE IP SFP TAG NXPC AB SAHARA 1INCH CHEEMS BANANAS31 RIVER MYX RAVE SNX FORM LAB HTX CTM BDX SLX UB DUCKY KOGE BILL ALE GOMINING VCNT GUA SMILEK 0G BEAM MY SOON REAL Q AIOZ ZIG YFI TAC CYS ZAMA TRIA HUMA PLUME ZIL XPR ZETA BABYDOGE NILA ROSE VELO UAI BRETT OPEN BSB TOSHI BAS ACH AXL LUR ELF KAVA APR IRYS BARD DUSK SUSHI PEAQ COAI BDCA`.split(/\s+/),
);

async function cmcGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

async function history(id: number): Promise<{ px: number[]; vol: number[] } | null> {
  const f = `data/sel-cache-${id}.json`;
  if (existsSync(f) && Date.now() - statSync(f).mtimeMs < 6 * 3600_000) return JSON.parse(readFileSync(f, "utf-8"));
  try {
    const res = await cmcGet<{ data: { quotes: { quote: { USD: { price: number; volume_24h: number } } }[] } }>(
      "/v2/cryptocurrency/quotes/historical",
      { id: String(id), interval: "1h", count: String(HOURS) },
    );
    const out = {
      px: res.data.quotes.map((q) => q.quote.USD.price),
      vol: res.data.quotes.map((q) => q.quote.USD.volume_24h),
    };
    mkdirSync("data", { recursive: true });
    writeFileSync(f, JSON.stringify(out));
    return out;
  } catch {
    return null;
  }
}

async function fgHistory(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await cmcGet<{ data: { timestamp: string; value: number }[] }>("/v3/fear-and-greed/historical", {
      limit: "40",
    });
    for (const d of res.data) {
      const ts = Number(d.timestamp);
      const day = new Date(Number.isFinite(ts) && ts > 1e9 ? ts * 1000 : Date.parse(d.timestamp))
        .toISOString()
        .slice(0, 10);
      map.set(day, d.value);
    }
  } catch {
    /* neutral fallback */
  }
  return map;
}

function runBot(sym: string, px: number[], vol: number[], fgByDay: Map<string, number>, t0: number) {
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

  for (let i = WARMUP; i < px.length; i++) {
    const ts = t0 + i * 3600_000;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (portfolio.dailyPnlDate !== day) {
      portfolio.dailyPnlDate = day;
      portfolio.dailyPnlUsd = 0;
    }
    const s: TokenSignal = {
      symbol: sym,
      cmcId: 0,
      priceUsd: px[i],
      percentChange1h: (px[i] / px[i - 1] - 1) * 100,
      percentChange24h: (px[i] / px[i - 24] - 1) * 100,
      percentChange7d: (px[i] / px[i - 168] - 1) * 100,
      volume24h: vol[i],
      volumeChange24h: vol[i - 24] > 0 ? (vol[i] / vol[i - 24] - 1) * 100 : 0,
      marketCap: 0,
      timestamp: new Date(ts).toISOString(),
    };
    let hi = 0;
    for (let j = Math.max(0, i - 48); j < i; j++) hi = Math.max(hi, px[j]);
    const ctx: MarketContext = {
      signals: [s],
      fearGreedValue: fgByDay.get(day) ?? 50,
      fearGreedLabel: "",
      trending: [],
      high48h: { [sym]: hi },
    };
    const decisions = decide(ctx, portfolio);
    const { orders } = applyRisk(decisions, portfolio, [s], ts);
    for (const order of orders) {
      applyFill(portfolio, { order, executedAt: new Date(ts).toISOString(), fee: simulatedFee(order) });
    }
    const total = portfolio.cashUsd + portfolio.positions.reduce((acc, p) => acc + p.qty * px[i], 0);
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, (peak - total) / peak);
  }

  const last = px[px.length - 1];
  const total = portfolio.cashUsd + portfolio.positions.reduce((acc, p) => acc + p.qty * last, 0);
  const closed = portfolio.history.filter((f) => f.order.side === "SELL");
  const wins = closed.filter((f) => (f.realizedPnlUsd ?? 0) > 0).length;
  return {
    ret: ((total - config.paperStartingUsd) / config.paperStartingUsd) * 100,
    dd: maxDd * 100,
    trades: portfolio.history.length,
    wr: closed.length ? (wins / closed.length) * 100 : null,
    bh: (last / px[WARMUP] - 1) * 100,
  };
}

async function main() {
  const listings = await cmcGet<{ data: any[] }>("/v1/cryptocurrency/listings/latest", { limit: "3000", convert: "USD" });
  const seen = new Set<string>();
  const candidates = listings.data
    .filter((c) => {
      const sym = String(c.symbol).toUpperCase();
      if (!ELIGIBLE.has(sym) || STABLES.has(sym) || seen.has(sym)) return false;
      seen.add(sym);
      return (c.quote.USD.market_cap ?? 0) >= MIN_MCAP && (c.quote.USD.volume_24h ?? 0) >= MIN_VOL;
    })
    .map((c) => ({ sym: String(c.symbol).toUpperCase(), id: c.id as number }));

  console.log(`Escaneando ${candidates.length} tokens con el motor real de Triton...`);
  const fgByDay = await fgHistory();
  const t0 = Date.now() - HOURS * 3600_000;

  const results: Record<string, any> = {};
  for (const c of candidates) {
    const h = await history(c.id);
    if (!h || h.px.length < WARMUP + 50) continue;
    const r = runBot(c.sym, h.px, h.vol, fgByDay, t0);
    results[c.sym] = r;
    console.log(
      `  ${c.sym.padEnd(9)} bot ${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}% (B&H ${r.bh >= 0 ? "+" : ""}${r.bh.toFixed(1)}%) DD -${r.dd.toFixed(1)}% trades ${r.trades}${r.wr != null ? " WR " + r.wr.toFixed(0) + "%" : ""}`,
    );
  }

  writeFileSync("data/bot-scan.json", JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 1));
  console.log(`\n${Object.keys(results).length} tokens escaneados -> data/bot-scan.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
