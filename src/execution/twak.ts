import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Executor } from "./executor.js";
import type { Fill, Order } from "../types.js";

const exec = promisify(execFile);

// Ejecutor real vía Trust Wallet Agent Kit (CLI `twak`).
// Blindado tras auditoría (10-jun):
//  - parseo robusto del stdout (no asume JSON limpio)
//  - éxito SOLO con txHash presente y sin error en el body
//  - SELL por cantidad EXACTA truncada hacia abajo (nunca redondear arriba)
//  - contabilidad con montos REALES del swap (output de twak), no precios CMC
//  - si el fallo ocurre en la fase de ejecución (la tx pudo emitirse),
//    se escribe un registro pendiente de reconciliación en disco

const MAX_PRICE_IMPACT_PCT = 1.5;
const SLIPPAGE_PCT = 1;
const RECONCILE_FILE = join(process.cwd(), "data", "pending-reconcile.jsonl");

async function twak(args: string[]): Promise<string> {
  const { stdout } = await exec("twak", args, {
    shell: process.platform === "win32", // twak es un .cmd shim en Windows
    timeout: 120_000,
    killSignal: "SIGKILL",
    env: process.env,
  });
  return stdout;
}

// Extrae el último objeto JSON válido del stdout (tolera warnings antes,
// texto después y llaves dentro de strings de log).
function parseJson(stdout: string): Record<string, unknown> {
  const candidates: Record<string, unknown>[] = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < stdout.length; j++) {
      if (stdout[j] === "{") depth++;
      else if (stdout[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            candidates.push(JSON.parse(stdout.slice(i, j + 1)));
            i = j;
          } catch {
            /* no era JSON completo */
          }
          break;
        }
      }
    }
  }
  if (!candidates.length) throw new Error(`twak no devolvió JSON: ${stdout.slice(0, 200)}`);
  return candidates[candidates.length - 1];
}

// "0.016639407014955634 BNB" -> 0.016639...
function parseAmount(s: unknown): number | undefined {
  if (typeof s !== "string") return undefined;
  const n = parseFloat(s.trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function logPendingReconcile(order: Order, phase: string, error: string): void {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    appendFileSync(
      RECONCILE_FILE,
      JSON.stringify({ at: new Date().toISOString(), phase, error: error.slice(0, 300), order }) + "\n",
    );
  } catch {
    /* best effort */
  }
}

async function tokenAddress(symbol: string): Promise<string> {
  const { config } = await import("../config.js");
  const entry = config.watchlist[symbol];
  if (!entry) throw new Error(`${symbol} no está en el allowlist`);
  // twak no resuelve varios símbolos en BSC: siempre por contrato BEP-20
  return entry.address;
}

function swapArgs(order: Order, token: string, quoteOnly: boolean): string[] {
  let args: string[];
  if (order.side === "BUY") {
    args = ["swap", "USDT", token, "--usd", order.amountUsd.toFixed(2)];
  } else {
    // Cantidad EXACTA del libro, truncada hacia abajo (auditoría C2: derivar
    // de amountUsd/price y redondear arriba hacía revertir el swap entero)
    const rawQty = order.qty ?? order.amountUsd / order.priceUsd;
    const qty = Math.floor(rawQty * 1e8) / 1e8;
    args = ["swap", qty.toFixed(8), token, "USDT"];
  }
  args.push("--chain", "bsc", "--slippage", String(SLIPPAGE_PCT), "--json");
  if (quoteOnly) args.push("--quote-only");
  return args;
}

function assertOk(result: Record<string, unknown>, context: string): void {
  if (result.error || result.errorCode) {
    throw new Error(`twak ${context}: ${String(result.error ?? result.errorCode)}`);
  }
}

export const twakExecutor: Executor = {
  name: "twak",
  async execute(order: Order): Promise<Fill> {
    const token = await tokenAddress(order.symbol);

    // 1. Quote y validación de impacto de precio (fase segura: sin tx)
    const quote = parseJson(await twak(swapArgs(order, token, true)));
    assertOk(quote, "quote");
    const impact = Math.abs(Number(quote.priceImpact ?? 0));
    if (impact > MAX_PRICE_IMPACT_PCT) {
      throw new Error(`Impacto de precio ${impact}% > límite ${MAX_PRICE_IMPACT_PCT}% — swap abortado`);
    }

    // 2. Ejecución real (a partir de aquí, cualquier fallo puede haber
    //    dejado una tx on-chain: se registra para reconciliar)
    let result: Record<string, unknown>;
    try {
      result = parseJson(await twak(swapArgs(order, token, false)));
      assertOk(result, "swap");
    } catch (err) {
      logPendingReconcile(order, "execute", (err as Error).message);
      throw err;
    }

    const txHash = (result.txHash ?? result.hash ?? result.transactionHash) as string | undefined;
    if (!txHash) {
      // Sin txHash no hay prueba de ejecución: NO se contabiliza (auditoría:
      // antes esto registraba trades fantasma)
      logPendingReconcile(order, "no-txhash", JSON.stringify(result).slice(0, 200));
      throw new Error(`twak swap sin txHash — no contabilizado (${JSON.stringify(result).slice(0, 120)})`);
    }

    // Montos reales del swap para la contabilidad
    const outAmount = parseAmount(result.output);
    const fill: Fill = {
      order,
      executedAt: new Date().toISOString(),
      txHash,
      fee: order.amountUsd * (SLIPPAGE_PCT / 100),
    };
    if (order.side === "BUY" && outAmount) {
      fill.actualQty = outAmount; // tokens reales recibidos
      fill.fee = 0; // el coste real ya está implícito en qty real vs amountUsd
    } else if (order.side === "SELL" && outAmount) {
      fill.actualProceedsUsd = outAmount; // USDT reales recibidos
      fill.fee = 0;
    }
    return fill;
  },
};
