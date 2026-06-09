import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Executor } from "./executor.js";
import type { Fill, Order } from "../types.js";

const exec = promisify(execFile);

// Ejecutor real vía Trust Wallet Agent Kit (CLI `twak`).
// - Cash leg: USDT en BSC. BUY = USDT -> token, SELL = token -> USDT.
// - Las claves viven cifradas en ~/.twak/wallet.json y nunca salen de la máquina.
// - La contraseña de la wallet se resuelve vía TWAK_WALLET_PASSWORD (env),
//   nunca como argumento CLI.
// - Siempre se pide quote primero; si el impacto de precio supera el límite,
//   se aborta (protección extra a nivel de ejecución, además del RiskManager).

const MAX_PRICE_IMPACT_PCT = 1.5;
const SLIPPAGE_PCT = 1;

async function twak(args: string[]): Promise<string> {
  const { stdout } = await exec("twak", args, {
    shell: process.platform === "win32", // twak es un .cmd shim en Windows
    timeout: 120_000,
    env: process.env,
  });
  return stdout;
}

// El CLI imprime una línea humana antes del JSON; recortamos hasta la primera '{'.
function parseJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`twak no devolvió JSON: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

async function tokenAddress(symbol: string): Promise<string> {
  const { config } = await import("../config.js");
  const entry = config.watchlist[symbol];
  if (!entry) throw new Error(`${symbol} no está en el allowlist`);
  // twak no resuelve varios símbolos en BSC: siempre por contrato BEP-20
  return entry.address;
}

function swapArgs(order: Order, token: string, quoteOnly: boolean): string[] {
  const args =
    order.side === "BUY"
      ? ["swap", "USDT", token, "--usd", order.amountUsd.toFixed(2)]
      : ["swap", (order.amountUsd / order.priceUsd).toFixed(8), token, "USDT"];
  args.push("--chain", "bsc", "--slippage", String(SLIPPAGE_PCT), "--json");
  if (quoteOnly) args.push("--quote-only");
  return args;
}

export const twakExecutor: Executor = {
  name: "twak",
  async execute(order: Order): Promise<Fill> {
    // 0. Allowlist: solo tokens elegibles de la competición. Guardarraíl a
    //    nivel de ejecución — aunque la estrategia se equivocara, aquí no pasa.
    const { config } = await import("../config.js");
    if (!(order.symbol in config.watchlist)) {
      throw new Error(`${order.symbol} no está en el allowlist de tokens elegibles — orden rechazada`);
    }

    const token = await tokenAddress(order.symbol);

    // 1. Quote y validación de impacto de precio
    const quote = parseJson(await twak(swapArgs(order, token, true)));
    const impact = Math.abs(Number(quote.priceImpact ?? 0));
    if (impact > MAX_PRICE_IMPACT_PCT) {
      throw new Error(`Impacto de precio ${impact}% > límite ${MAX_PRICE_IMPACT_PCT}% — swap abortado`);
    }

    // 2. Ejecución real
    const result = parseJson(await twak(swapArgs(order, token, false)));
    const txHash = (result.txHash ?? result.hash ?? result.transactionHash) as string | undefined;

    return {
      order,
      executedAt: new Date().toISOString(),
      txHash,
      // El coste real (gas + spread) queda reflejado on-chain; para la
      // contabilidad local usamos el minReceived del quote como aproximación
      // conservadora del slippage.
      fee: order.amountUsd * (SLIPPAGE_PCT / 100),
    };
  },
};
