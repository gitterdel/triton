/**
 * Selector sistemático de universo: evalúa TODOS los elegibles líquidos con
 * métricas ESTRUCTURALES de compatibilidad con la estrategia (no PnL pasado,
 * para no seleccionar "ganadores de ayer"):
 *
 *  - persistencia de tendencia: ¿los movimientos de 4h continúan o revierten?
 *    (momentum necesita continuación)
 *  - volatilidad en banda útil: mediana |24h| entre 1.5% y 6% (muy poco no
 *    paga las fricciones; demasiado revienta stops)
 *  - riesgo de crash: peor movimiento 24h (los gappers de -25% son vetados)
 *  - estabilidad de volumen: que la liquidez no se evapore por días
 *
 * Uso: npx tsx scripts/select-universe.ts
 */
import "dotenv/config";
import { config } from "../src/config.js";

const BASE = "https://pro-api.coinmarketcap.com";
const MIN_MCAP = 100e6;
const MIN_VOL = 20e6;
const HOURS = 673; // 28 días

const STABLES = new Set(
  "USDT USDC DAI USD1 USDE USDD TUSD FDUSD U STABLE USDF FRAX FRXUSD XUSD EURI LISUSD DUSD XAUT XAUM WFI".split(" "),
);
const ELIGIBLE = new Set(
  `ETH USDT USDC XRP TRX DOGE ZEC ADA LINK BCH DAI TON USD1 USDE M LTC AVAX SHIB XAUT WLFI H DOT UNI ASTER DEXE USDD ETC AAVE ATOM U STABLE FIL INJ NIGHT FET TUSD BONK PENGU CAKE SIREN LUNC ZRO KITE FDUSD BEAT PIEVERSE BTT NFT EDGE FLOKI LDO B FF PENDLE NEX STG AXS TWT HOME RAY COMP GWEI XCN GENIUS XPL BAT SKYAI APE IP SFP TAG NXPC AB SAHARA 1INCH CHEEMS BANANAS31 RIVER MYX RAVE SNX FORM LAB HTX CTM BDX SLX UB DUCKY KOGE BILL ALE GOMINING VCNT GUA SMILEK 0G BEAM MY SOON REAL Q AIOZ ZIG YFI TAC CYS ZAMA TRIA HUMA PLUME ZIL XPR ZETA BABYDOGE NILA ROSE VELO UAI BRETT OPEN BSB TOSHI BAS ACH AXL LUR ELF KAVA APR IRYS BARD DUSK SUSHI PEAQ COAI BDCA`.split(/\s+/),
);

async function cmcGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

async function history(id: number): Promise<{ px: number[]; vol: number[] } | null> {
  const { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } = await import("node:fs");
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

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function metrics(px: number[], vol: number[]) {
  // retornos de 4h y persistencia de signo entre bloques consecutivos
  const r4: number[] = [];
  for (let i = 4; i < px.length; i += 4) r4.push(px[i] / px[i - 4] - 1);
  let same = 0;
  for (let i = 1; i < r4.length; i++) if (Math.sign(r4[i]) === Math.sign(r4[i - 1]) && r4[i] !== 0) same++;
  const persistence = r4.length > 1 ? same / (r4.length - 1) : 0;

  const r24: number[] = [];
  for (let i = 24; i < px.length; i++) r24.push(px[i] / px[i - 24] - 1);
  const med24 = median(r24.map(Math.abs)) * 100;
  const worst24 = Math.min(...r24) * 100;

  const volMed = median(vol);
  const volP10 = [...vol].sort((a, b) => a - b)[Math.floor(vol.length * 0.1)] ?? 0;
  const volStab = volMed > 0 ? volP10 / volMed : 0;

  // Score estructural
  const bandFit = Math.max(0, 1 - Math.abs(med24 - 3.5) / 3.5); // óptimo ~3.5% diario
  const crashPenalty = worst24 < -25 ? 2 : worst24 < -18 ? 1 : 0;
  const score = persistence * 4 + bandFit * 2 + volStab * 1.5 - crashPenalty;
  return { persistence, med24, worst24, volStab, score };
}

async function main() {
  const listings = await cmcGet<{ data: any[] }>("/v1/cryptocurrency/listings/latest", {
    limit: "3000",
    convert: "USD",
  });
  const seen = new Set<string>();
  const candidates = listings.data
    .filter((c) => {
      const sym = String(c.symbol).toUpperCase();
      if (!ELIGIBLE.has(sym) || STABLES.has(sym) || seen.has(sym)) return false;
      seen.add(sym);
      const q = c.quote.USD;
      return (q.market_cap ?? 0) >= MIN_MCAP && (q.volume_24h ?? 0) >= MIN_VOL;
    })
    .map((c) => ({ sym: String(c.symbol).toUpperCase(), id: c.id as number, name: c.name as string }));

  console.log(`Candidatos tras filtros duros (mcap>$100M, vol>$20M, no-stable): ${candidates.length}\n`);

  const rows: { sym: string; name: string; m: ReturnType<typeof metrics> }[] = [];
  for (const c of candidates) {
    const h = await history(c.id);
    if (!h || h.px.length < 200) {
      console.log(`  ${c.sym}: sin histórico suficiente — descartado`);
      continue;
    }
    rows.push({ sym: c.sym, name: c.name, m: metrics(h.px, h.vol) });
  }

  rows.sort((a, b) => b.m.score - a.m.score);
  const current = new Set(Object.keys(config.watchlist));
  console.log(`\n${"SYM".padEnd(9)} ${"score".padStart(6)} ${"persist".padStart(8)} ${"med|24h|".padStart(9)} ${"worst24".padStart(9)} ${"volStab".padStart(8)}`);
  for (const r of rows) {
    const mark = current.has(r.sym) ? "✓" : " ";
    console.log(
      `${mark} ${r.sym.padEnd(8)} ${r.m.score.toFixed(2).padStart(6)} ${(r.m.persistence * 100).toFixed(0).padStart(7)}% ${r.m.med24.toFixed(1).padStart(8)}% ${r.m.worst24.toFixed(1).padStart(8)}% ${(r.m.volStab * 100).toFixed(0).padStart(7)}%`,
    );
  }
  console.log(`\n✓ = en watchlist actual (${current.size} tokens)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
