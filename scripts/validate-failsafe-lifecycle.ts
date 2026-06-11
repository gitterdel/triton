/**
 * Validación SIN COSTE del ciclo de vida de los failsafes TWAK:
 * colocar → deduplicar → reemplazar → borrar. No hace ningún swap — solo
 * automations con cantidad dust y precio inalcanzable. Útil en pre-flight.
 *
 * Uso (VPS): npx tsx scripts/validate-failsafe-lifecycle.ts
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureFailsafeStop, clearFailsafeStop } from "../src/execution/guardrails.js";

const exec = promisify(execFile);
const SYMBOL = "ETH";

async function list(): Promise<{ id: string; targetPrice?: number; active?: boolean }[]> {
  const out = (await exec("twak", ["automate", "list", "--json"], { timeout: 60_000, env: process.env })).stdout;
  const s = out.indexOf("[");
  return s === -1 ? [] : JSON.parse(out.slice(s));
}

async function main() {
  let fallos = 0;
  const check = (label: string, got: number, want: number) => {
    const ok = got === want;
    if (!ok) fallos++;
    console.log(`  ${ok ? "✅" : "❌"} ${label}: ${got} (esperado ${want})`);
  };

  console.log("1) colocar stop de prueba (dust, precio inalcanzable $100)…");
  await ensureFailsafeStop(SYMBOL, 0.00001, 100);
  check("automations tras colocar", (await list()).length, 1);

  console.log("2) recolocar al MISMO nivel (debe deduplicar, no apilar)…");
  await ensureFailsafeStop(SYMBOL, 0.00001, 100);
  check("automations tras dedupe", (await list()).length, 1);

  console.log("3) recolocar a nivel DISTINTO (debe reemplazar)…");
  await ensureFailsafeStop(SYMBOL, 0.00001, 120);
  const l3 = await list();
  check("automations tras reemplazo", l3.length, 1);
  console.log(`     targetPrice: ${l3[0]?.targetPrice} (esperado 120)`);

  console.log("4) clearFailsafeStop (debe dejar 0)…");
  await clearFailsafeStop(SYMBOL);
  check("automations tras clear", (await list()).length, 0);

  console.log(fallos ? `\n❌ ${fallos} comprobaciones fallidas` : "\n✅ Ciclo de vida de failsafes VALIDADO");
  process.exit(fallos ? 1 : 0);
}

main().catch(async (e) => {
  console.error("💥", (e as Error).message);
  await clearFailsafeStop(SYMBOL).catch(() => {});
  process.exit(1);
});
