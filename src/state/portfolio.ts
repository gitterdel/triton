import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, RISK_LIMITS } from "../config.js";
import type { Fill, Order, Portfolio } from "../types.js";

const FILE = join(process.cwd(), "data", "portfolio.json");

export function loadPortfolio(): Portfolio {
  if (existsSync(FILE)) {
    const p = JSON.parse(readFileSync(FILE, "utf-8")) as Portfolio;
    const today = new Date().toISOString().slice(0, 10);
    if (p.dailyPnlDate !== today) {
      p.dailyPnlDate = today;
      p.dailyPnlUsd = 0;
    }
    return p;
  }
  return {
    cashUsd: config.paperStartingUsd,
    positions: [],
    realizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlDate: new Date().toISOString().slice(0, 10),
    history: [],
  };
}

export function savePortfolio(p: Portfolio): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(p, null, 2));
}

// Aplica un fill al portfolio (común a paper y live: el estado contable es el mismo).
export function applyFill(p: Portfolio, fill: Fill): void {
  const { order, fee } = fill;
  if (order.side === "BUY") {
    const qty = (order.amountUsd - fee) / order.priceUsd;
    const existing = p.positions.find((pos) => pos.symbol === order.symbol);
    if (existing) {
      const totalCost = existing.qty * existing.avgEntryUsd + qty * order.priceUsd;
      existing.qty += qty;
      existing.avgEntryUsd = totalCost / existing.qty;
    } else {
      p.positions.push({
        symbol: order.symbol,
        qty,
        avgEntryUsd: order.priceUsd,
        openedAt: fill.executedAt,
        peakUsd: order.priceUsd,
        strategy: order.strategy ?? "momentum",
      });
    }
    p.cashUsd -= order.amountUsd;
  } else {
    const pos = p.positions.find((x) => x.symbol === order.symbol);
    if (!pos) return;
    const proceeds = order.amountUsd - fee;
    const costBasis = pos.qty * pos.avgEntryUsd;
    const pnl = proceeds - costBasis;
    p.cashUsd += proceeds;
    p.realizedPnlUsd += pnl;
    p.dailyPnlUsd += pnl;
    fill.realizedPnlUsd = pnl;
    p.positions = p.positions.filter((x) => x.symbol !== order.symbol);
  }
  p.history.push(fill);
}

export function simulatedFee(order: Order): number {
  return order.amountUsd * RISK_LIMITS.simulatedFeePct;
}
