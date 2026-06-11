import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RISK_LIMITS, config } from "../config.js";

const exec = promisify(execFile);

// Failsafe de stops a nivel de TWAK (defensa en profundidad).
//
// Además del stop-loss que evalúa el agente cada 60s, cada posición abierta
// en modo live lleva una limit order NATIVA de TWAK (automation): si el
// precio cae al nivel de stop, el watcher de TWAK (proceso independiente,
// `twak watch`) ejecuta la venta AUNQUE el agente esté caído. El agente es
// el cerebro; TWAK es también el reflejo espinal.
//
// El trailing stop sigue siendo del agente (las automations son de precio
// fijo): cuando el pico sube, el agente recoloca el failsafe más arriba.

async function twak(args: string[]): Promise<string> {
  const { stdout } = await exec("twak", args, {
    shell: process.platform === "win32",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: process.env,
  });
  return stdout;
}

interface Automation {
  id: string;
  from?: string;
  to?: string;
  price?: number;
}

async function listAutomations(): Promise<Automation[]> {
  try {
    const out = await twak(["automate", "list", "--json"]);
    const start = out.indexOf("[");
    if (start === -1) return [];
    return JSON.parse(out.slice(start)) as Automation[];
  } catch {
    return [];
  }
}

// Coloca (o recoloca) el stop failsafe de una posición. Vende TODO el qty
// del token a USDT si el precio cae por debajo de stopPriceUsd.
export async function ensureFailsafeStop(symbol: string, qty: number, stopPriceUsd: number): Promise<void> {
  try {
    const address = config.watchlist[symbol]?.address ?? symbol;
    const matches = (a: Automation) =>
      (a.from?.toLowerCase() === symbol.toLowerCase() || a.from?.toLowerCase() === address.toLowerCase()) &&
      (a.to ?? "USDT").toUpperCase().includes("USDT");
    const existing = (await listAutomations()).filter(matches);
    // Si ya hay un stop al mismo nivel (±0.5%), no tocar
    if (existing.some((a) => a.price && Math.abs(a.price - stopPriceUsd) / stopPriceUsd < 0.005)) return;

    for (const a of existing) await twak(["automate", "delete", a.id, "--json"]).catch(() => {});
    // Descuento del 0.3% sobre la cantidad del libro (ensayo real 11-jun):
    // twak reporta en el output del swap ~0.004% MÁS tokens de los que llegan
    // a la wallet, y la ejecución de automations NO ajusta al balance (el
    // swap directo sí) — la automation por la cantidad exacta revertía en
    // cadena con "transfer amount exceeds balance" y el paracaídas nunca
    // vendía. Verificado on-chain (balanceOf vs output). El polvo restante
    // (~0.3% de la posición) lo limpia el SELL normal del agente si procede.
    const amount = Math.floor(qty * 0.997 * 1e8) / 1e8;
    await twak([
      "automate", "add",
      "--from", address,
      "--to", "USDT",
      "--chain", "bsc",
      "--amount", amount.toFixed(8),
      "--price", stopPriceUsd.toFixed(6),
      "--condition", "below",
      "--max-runs", "1",
      "--json",
    ]);
    console.log(`  🛡️ Failsafe TWAK: SELL ${symbol} si precio < $${stopPriceUsd.toFixed(4)}`);
  } catch (err) {
    // El failsafe es redundancia: si falla, el stop del agente sigue activo.
    console.error(`  ⚠️ No se pudo colocar failsafe de ${symbol}:`, (err as Error).message);
  }
}

// Retira el failsafe cuando la posición se cierra por la vía normal.
export async function clearFailsafeStop(symbol: string): Promise<void> {
  try {
    const address = config.watchlist[symbol]?.address ?? symbol;
    const existing = (await listAutomations()).filter(
      (a) => a.from?.toLowerCase() === symbol.toLowerCase() || a.from?.toLowerCase() === address.toLowerCase(),
    );
    for (const a of existing) await twak(["automate", "delete", a.id, "--json"]).catch(() => {});
  } catch {
    /* redundancia: no crítico */
  }
}

// Margen del failsafe BAJO el stop del agente (auditoría #4: al mismo nivel,
// agente y watcher TWAK disparaban a la vez sobre la misma posición — el que
// perdía la carrera fallaba por balance y rompía la contabilidad). El
// failsafe es paracaídas de emergencia, no competidor: solo actúa si el
// agente está muerto y el precio sigue cayendo.
const FAILSAFE_MARGIN = 0.98;

export function stopPriceFor(avgEntryUsd: number, peakUsd: number | undefined, strategy?: string): number {
  if (strategy === "range") return avgEntryUsd * 0.97 * FAILSAFE_MARGIN;
  // Posiciones BULL: correa larga propia (auditoría 11-jun: sin esta rama,
  // el failsafe usaba el stop fino del 5% y habría estrangulado en live una
  // estrategia cuyo stop real es BULL_STOP — el paracaídas iba POR ENCIMA
  // del suelo del agente). Espeja los mismos knobs que el risk manager.
  if (strategy === "bull") {
    const stop = Number(process.env.TEST_BULL_STOP ?? 10) / 100;
    const arm = Number(process.env.TEST_BULL_ARM ?? 5) / 100;
    const trail = Number(process.env.TEST_BULL_TRAIL ?? 12) / 100;
    const hardStop = avgEntryUsd * (1 - stop);
    const peak = peakUsd ?? avgEntryUsd;
    const armed = (peak - avgEntryUsd) / avgEntryUsd >= arm;
    const trailStop = armed ? peak * (1 - trail) : 0;
    return Math.max(hardStop, trailStop) * FAILSAFE_MARGIN;
  }
  const hardStop = avgEntryUsd * (1 - RISK_LIMITS.stopLossPct);
  const peak = peakUsd ?? avgEntryUsd;
  const armed = (peak - avgEntryUsd) / avgEntryUsd >= RISK_LIMITS.trailingActivationPct;
  const trailStop = armed ? peak * (1 - RISK_LIMITS.trailingStopPct) : 0;
  return Math.max(hardStop, trailStop) * FAILSAFE_MARGIN;
}
