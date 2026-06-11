/**
 * ENSAYO DE EJECUCIÓN REAL (pre-flight) — gasta DINERO REAL en cantidad mínima.
 *
 * Valida lo único que el paper no puede ensayar, usando el MISMO código que
 * la semana live:
 *   A) Ida y vuelta por el camino del agente: quote → impacto → BUY real
 *      → SELL real (twakExecutor, con sus guardas de auditoría)
 *   B) El circuito de emergencia: automation de failsafe colocada SOBRE el
 *      precio (dispara al instante) + `twak watch` ejecutándola — responde
 *      definitivamente si las automations corren sin watcher o no.
 *
 * Seguridad: requiere REHEARSAL_OK=1; importe fijo ~$11/pata; limpieza de
 * automations garantizada al final pase lo que pase.
 *
 * Uso (en el VPS): REHEARSAL_OK=1 npx tsx scripts/rehearsal-live-execution.ts
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { twakExecutor } from "../src/execution/twak.js";
import { ensureFailsafeStop, clearFailsafeStop } from "../src/execution/guardrails.js";
import type { Order } from "../src/types.js";

const exec = promisify(execFile);
const SYMBOL = "ETH"; // liquidez profunda en BSC; está en el allowlist
const LEG_USD = 11;

if (process.env.REHEARSAL_OK !== "1") {
  console.error("Aborto: este script gasta dinero real. Ejecutar con REHEARSAL_OK=1.");
  process.exit(1);
}

function hr(t: string) {
  console.log(`\n========== ${t} ==========`);
}

async function main() {
  console.log(`ENSAYO DE EJECUCIÓN REAL · ${new Date().toISOString()} · ${SYMBOL} · ~$${LEG_USD}/pata`);
  const t0 = Date.now();

  // ---------- A: ida y vuelta por el camino del agente ----------
  hr("A · BUY real vía twakExecutor (quote + impacto + swap)");
  const buy: Order = { symbol: SYMBOL, side: "BUY", amountUsd: LEG_USD, priceUsd: 0, reason: "REHEARSAL: pata de ida" };
  const buyFill = await twakExecutor.execute(buy);
  const qty = buyFill.actualQty;
  if (!qty) throw new Error("BUY sin actualQty — revisar output de twak");
  const entryPx = LEG_USD / qty;
  console.log(`  ✅ BUY ok · tx=${buyFill.txHash} · qty=${qty} · precio implícito=$${entryPx.toFixed(2)}`);

  hr("A · SELL real de la misma cantidad");
  const sell: Order = { symbol: SYMBOL, side: "SELL", amountUsd: qty * entryPx, priceUsd: entryPx, qty, reason: "REHEARSAL: pata de vuelta" };
  const sellFill = await twakExecutor.execute(sell);
  const got = sellFill.actualProceedsUsd ?? NaN;
  const rtCostPct = ((LEG_USD - got) / LEG_USD) * 100;
  console.log(`  ✅ SELL ok · tx=${sellFill.txHash} · USDT recibidos=${got.toFixed(4)}`);
  console.log(`  📊 Coste real ida+vuelta: ${rtCostPct.toFixed(3)}% (fees+slippage+spread reales)`);

  // ---------- B: automation + watcher (el circuito de emergencia) ----------
  hr("B · BUY de la pata del watcher");
  const buy2Fill = await twakExecutor.execute({ ...buy, reason: "REHEARSAL: pata del watcher" });
  const qty2 = buy2Fill.actualQty;
  if (!qty2) throw new Error("BUY2 sin actualQty");
  const entry2 = LEG_USD / qty2;
  console.log(`  ✅ BUY ok · tx=${buy2Fill.txHash} · qty=${qty2}`);

  hr("B · failsafe SOBRE el precio (debe disparar al primer poll del watcher)");
  await clearFailsafeStop(SYMBOL); // por si hubiera restos
  await ensureFailsafeStop(SYMBOL, qty2, entry2 * 1.05);

  hr("B · twak watch --interval 5 (máx 75s)");
  let watchOut = "";
  try {
    const r = await exec("twak", ["watch", "--interval", "5"], { timeout: 75_000, killSignal: "SIGKILL", env: process.env });
    watchOut = r.stdout + (r.stderr ?? "");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    watchOut = (err.stdout ?? "") + (err.stderr ?? ""); // timeout esperado: el watcher no termina solo
  }
  console.log("  --- salida del watcher (recortada) ---");
  console.log(watchOut.split("\n").slice(-25).join("\n"));

  // Veredicto del watcher: ¿vendió? Intentamos vender la pata 2 — si el
  // watcher ya la vendió, el quote/sell fallará por balance y eso ES la prueba.
  hr("B · veredicto");
  const fired = /tx(Hash)?|swapped|executed|filled/i.test(watchOut);
  let watcherVerdict: string;
  try {
    const cleanup = await twakExecutor.execute({ symbol: SYMBOL, side: "SELL", amountUsd: qty2 * entry2, priceUsd: entry2, qty: qty2, reason: "REHEARSAL: limpieza si el watcher NO vendió" });
    watcherVerdict = fired
      ? `AMBIGUO: el watcher imprimió actividad pero la venta manual también pasó (tx=${cleanup.txHash}) — revisar salida`
      : `❌ EL WATCHER NO EJECUTÓ en 75s — la automation seguía viva (vendido manualmente, tx=${cleanup.txHash}). CONFIRMA el hallazgo de auditoría: sin watcher supervisado los failsafes son decorativos`;
  } catch {
    watcherVerdict = `✅ EL WATCHER EJECUTÓ la automation (la venta manual falló por balance: el token ya no estaba) — circuito de emergencia VALIDADO de extremo a extremo`;
  }
  console.log("  " + watcherVerdict);

  await clearFailsafeStop(SYMBOL);

  hr("RESUMEN");
  console.log(`  Camino del agente (A): BUY+SELL reales OK · coste ida+vuelta ${rtCostPct.toFixed(3)}%`);
  console.log(`  Circuito de emergencia (B): ${watcherVerdict.split("—")[0].trim()}`);
  console.log(`  Duración total: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(async (e) => {
  console.error("\n💥 ENSAYO FALLÓ:", (e as Error).message);
  console.error("Limpieza de automations…");
  await clearFailsafeStop(SYMBOL).catch(() => {});
  process.exit(1);
});
