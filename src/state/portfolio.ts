import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, RISK_LIMITS } from "../config.js";
import type { Fill, Order, Portfolio } from "../types.js";

const FILE = join(process.cwd(), "data", "portfolio.json");
const BAK = FILE + ".bak";

// Carga tolerante: si el archivo principal está corrupto (proceso muerto a
// mitad de escritura), recupera del backup. Un libro corrupto en live
// significaría un bot zombi: sin stops, sin compliance, sin trading.
export function loadPortfolio(): Portfolio {
  for (const f of [FILE, BAK]) {
    if (!existsSync(f)) continue;
    try {
      const p = JSON.parse(readFileSync(f, "utf-8")) as Portfolio;
      if (f === BAK) console.error("⚠️ portfolio.json corrupto — recuperado del backup");
      const today = new Date().toISOString().slice(0, 10);
      if (p.dailyPnlDate !== today) {
        p.dailyPnlDate = today;
        p.dailyPnlUsd = 0;
      }
      return p;
    } catch {
      console.error(`⚠️ ${f} ilegible, probando siguiente`);
    }
  }
  return {
    cashUsd: config.paperStartingUsd,
    positions: [],
    realizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlDate: new Date().toISOString().slice(0, 10),
    history: [],
    peakEquityUsd: config.paperStartingUsd,
  };
}

// Escritura atómica (tmp + rename) con backup del estado anterior válido.
export function savePortfolio(p: Portfolio): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  if (existsSync(FILE)) {
    try {
      copyFileSync(FILE, BAK);
    } catch {
      /* backup best-effort */
    }
  }
  renameSync(tmp, FILE);
}

// Aplica un fill al portfolio (común a paper y live: el estado contable es el mismo).
export function applyFill(p: Portfolio, fill: Fill): void {
  const { order, fee } = fill;
  if (order.side === "BUY") {
    // En live, usar los tokens REALES recibidos (auditoría: la deriva entre
    // qty contable y qty real acaba reventando los SELL por decimales)
    const qty = fill.actualQty ?? (order.amountUsd - fee) / order.priceUsd;
    // El basis incluye la fee de compra: avgEntry = coste total / tokens
    // (auditoría M1: antes la fee de compra desaparecía del PnL realizado)
    const existing = p.positions.find((pos) => pos.symbol === order.symbol);
    if (existing) {
      const totalCost = existing.qty * existing.avgEntryUsd + order.amountUsd;
      existing.qty += qty;
      existing.avgEntryUsd = totalCost / existing.qty;
    } else {
      p.positions.push({
        symbol: order.symbol,
        qty,
        avgEntryUsd: order.amountUsd / qty,
        openedAt: fill.executedAt,
        peakUsd: order.priceUsd,
        strategy: order.strategy ?? "momentum",
        entryReason: order.reason,
      });
    }
    p.cashUsd -= order.amountUsd;
  } else {
    const pos = p.positions.find((x) => x.symbol === order.symbol);
    if (!pos) {
      // Auditoría C3: un fill live ya ejecutado JAMÁS se descarta — el cash
      // real se movió. Se acredita aunque la posición no exista en el libro.
      const orphanProceeds = fill.actualProceedsUsd ?? order.amountUsd - fee;
      p.cashUsd += orphanProceeds;
      p.history.push(fill);
      console.error(`⚠️ SELL sin posición en el libro (${order.symbol}) — proceeds acreditados, revisar reconciliación`);
      return;
    }
    const proceeds = fill.actualProceedsUsd ?? order.amountUsd - fee;
    const costBasis = pos.qty * pos.avgEntryUsd;
    const pnl = proceeds - costBasis;
    p.cashUsd += proceeds;
    p.realizedPnlUsd += pnl;
    p.dailyPnlUsd += pnl;
    fill.realizedPnlUsd = pnl;

    // Diario de operaciones: expediente completo de cada trade cerrado,
    // para la autopsia sistemática entrada-por-entrada.
    // TRITON_BACKTEST=1 (lo ponen los harnesses) lo silencia: el journal es
    // el expediente del agente REAL — 92k líneas simuladas lo inutilizaban.
    const holdH = (Date.parse(fill.executedAt) - Date.parse(pos.openedAt)) / 3600_000;
    if (process.env.TRITON_BACKTEST !== "1") {
      appendFileSync(
        join(process.cwd(), "data", "trade-journal.jsonl"),
        JSON.stringify({
          symbol: order.symbol,
          strategy: pos.strategy ?? "momentum",
          entryAt: pos.openedAt,
          entryPx: pos.avgEntryUsd,
          entryWhy: pos.entryReason ?? "",
          peakPx: pos.peakUsd,
          maxGainPct: pos.peakUsd ? ((pos.peakUsd - pos.avgEntryUsd) / pos.avgEntryUsd) * 100 : 0,
          exitAt: fill.executedAt,
          exitPx: order.priceUsd,
          exitWhy: order.reason,
          holdHours: Math.round(holdH * 10) / 10,
          pnlUsd: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(((order.priceUsd - pos.avgEntryUsd) / pos.avgEntryUsd) * 10000) / 100,
        }) + "\n",
      );
    }

    p.positions = p.positions.filter((x) => x.symbol !== order.symbol);
  }
  p.history.push(fill);
}

export function simulatedFee(order: Order): number {
  return order.amountUsd * RISK_LIMITS.simulatedFeePct;
}
