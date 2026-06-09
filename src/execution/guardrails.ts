import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RISK_LIMITS } from "../config.js";

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
    const existing = (await listAutomations()).filter((a) => a.from === symbol && a.to === "USDT");
    // Si ya hay un stop al mismo nivel (±0.5%), no tocar
    if (existing.some((a) => a.price && Math.abs(a.price - stopPriceUsd) / stopPriceUsd < 0.005)) return;

    for (const a of existing) await twak(["automate", "delete", a.id, "--json"]).catch(() => {});
    await twak([
      "automate", "add",
      "--from", symbol,
      "--to", "USDT",
      "--chain", "bsc",
      "--amount", qty.toFixed(8),
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
    const existing = (await listAutomations()).filter((a) => a.from === symbol && a.to === "USDT");
    for (const a of existing) await twak(["automate", "delete", a.id, "--json"]).catch(() => {});
  } catch {
    /* redundancia: no crítico */
  }
}

export function stopPriceFor(avgEntryUsd: number, peakUsd: number | undefined): number {
  // El failsafe replica la lógica del agente: el peor de los dos niveles
  // (stop fijo desde entrada, o trailing desde pico si está armado).
  const hardStop = avgEntryUsd * (1 - RISK_LIMITS.stopLossPct);
  const peak = peakUsd ?? avgEntryUsd;
  const armed = (peak - avgEntryUsd) / avgEntryUsd >= RISK_LIMITS.trailingActivationPct;
  const trailStop = armed ? peak * (1 - RISK_LIMITS.trailingStopPct) : 0;
  return Math.max(hardStop, trailStop);
}
