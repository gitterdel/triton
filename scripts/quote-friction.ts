/**
 * FRICCIÓN REAL por token: cotiza ida+vuelta (USDT→token→USDT) vía twak
 * --quote-only, SIN gastar. La diferencia entre lo que entra y lo que vuelve
 * es el coste estructural de la ruta del agregador (spread + fees LP);
 * priceImpact=0 a estas tallas, así que NO depende del tamaño (medido 12-jun:
 * incluso empeora ligeramente al subir talla).
 *
 * Medido 12-jun ($20): DOGE 1.37% · CAKE 1.39 · ETH 1.40 · XRP 1.48 ·
 * TWT 1.52 · LINK 1.61 · LTC 1.65 · ADA 1.70 · ATOM 1.79 · AVAX 1.83 ·
 * FET 1.93 — media ~1.6%. Criterio de selección de universo: 0.5pp de
 * diferencia por ciclo ≈ ~3.4% de equity a 90d con ~45 cierres.
 *
 * Uso: npx tsx scripts/quote-friction.ts [usd]   (default 20)
 * Requiere TWAK_ACCESS_ID en .env. Cotiza la watchlist activa de config.ts.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { config } from "../src/config.js";

const USD = Number(process.argv[2] ?? 20);

function quote(args: string): any {
  const out = execSync(`twak ${args} --chain bsc --quote-only --json`, {
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(out.slice(out.indexOf("{")));
}

async function main() {
  const rows: { sym: string; rtPct: number; providers: string }[] = [];
  for (const [sym, meta] of Object.entries(config.watchlist)) {
    try {
      const buy = quote(`swap USDT ${meta.address} --usd ${USD}`);
      const inUsdt = parseFloat(buy.input);
      const qty = buy.output.split(" ")[0];
      const sell = quote(`swap ${qty} ${meta.address} USDT`);
      const back = parseFloat(sell.output);
      const rtPct = ((inUsdt - back) / inUsdt) * 100;
      rows.push({ sym, rtPct, providers: `${buy.provider}/${sell.provider}` });
      console.log(`  ${sym.padEnd(6)} RT ${rtPct.toFixed(3)}%  (${buy.provider}/${sell.provider})`);
    } catch (e: any) {
      console.error(`  ${sym.padEnd(6)} ERROR: ${String(e.message).slice(0, 100)}`);
    }
  }
  rows.sort((a, b) => a.rtPct - b.rtPct);
  const mean = rows.reduce((s, r) => s + r.rtPct, 0) / rows.length;
  console.log(`\nRanking (barato → caro): ${rows.map((r) => `${r.sym} ${r.rtPct.toFixed(2)}`).join(" · ")}`);
  console.log(`Media cesta: ${mean.toFixed(3)}% ida+vuelta (${(mean / 2).toFixed(4)} por lado para TEST_FEE_PCT)`);
}

main();
