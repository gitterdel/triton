import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Decision, MarketContext, Portfolio } from "../types.js";
import type { RiskResult } from "../risk/manager.js";

const STATE_FILE = join(process.cwd(), "data", "state.json");
const EQUITY_FILE = join(process.cwd(), "data", "equity.json");
const SIGNALS_LOG = join(process.cwd(), "data", "signals-log.jsonl");
const MAX_EQUITY_POINTS = 5000;

export interface EquityPoint {
  t: string;
  totalUsd: number;
  cashUsd: number;
}

export interface TickState {
  lastTick: string;
  executionMode: string;
  fearGreedValue: number;
  fearGreedLabel: string;
  killSwitchActive: boolean;
  decisions: {
    symbol: string;
    action: string;
    confidence: number;
    reasons: string[];
    priceUsd: number;
    pct1h: number;
    pct24h: number;
    pct7d: number;
  }[];
  blocked: { symbol: string; action: string; why: string }[];
  ordersExecuted: { side: string; symbol: string; amountUsd: number; priceUsd: number; reason: string; txHash?: string }[];
  portfolio: {
    cashUsd: number;
    totalUsd: number;
    realizedPnlUsd: number;
    dailyPnlUsd: number;
    positions: { symbol: string; qty: number; avgEntryUsd: number; currentUsd: number; pnlPct: number; openedAt: string }[];
    tradeCount: number;
  };
}

export function writeTickState(
  ctx: MarketContext,
  decisions: Decision[],
  risk: RiskResult,
  executed: TickState["ordersExecuted"],
  portfolio: Portfolio,
  executionMode: string,
): void {
  const priceOf = (sym: string) => ctx.signals.find((s) => s.symbol === sym)?.priceUsd ?? 0;
  const positions = portfolio.positions.map((p) => {
    const price = priceOf(p.symbol) || p.avgEntryUsd;
    return {
      symbol: p.symbol,
      qty: p.qty,
      avgEntryUsd: p.avgEntryUsd,
      currentUsd: p.qty * price,
      pnlPct: ((price - p.avgEntryUsd) / p.avgEntryUsd) * 100,
      openedAt: p.openedAt,
    };
  });
  const totalUsd = portfolio.cashUsd + positions.reduce((s, p) => s + p.currentUsd, 0);

  const state: TickState = {
    lastTick: new Date().toISOString(),
    executionMode,
    fearGreedValue: ctx.fearGreedValue,
    fearGreedLabel: ctx.fearGreedLabel,
    killSwitchActive: risk.killSwitchActive,
    decisions: decisions.map((d) => ({
      symbol: d.symbol,
      action: d.action,
      confidence: d.confidence,
      reasons: d.reasons,
      priceUsd: d.signal.priceUsd,
      pct1h: d.signal.percentChange1h,
      pct24h: d.signal.percentChange24h,
      pct7d: d.signal.percentChange7d,
    })),
    blocked: risk.blocked.map((b) => ({ symbol: b.decision.symbol, action: b.decision.action, why: b.why })),
    ordersExecuted: executed,
    portfolio: {
      cashUsd: portfolio.cashUsd,
      totalUsd,
      realizedPnlUsd: portfolio.realizedPnlUsd,
      dailyPnlUsd: portfolio.dailyPnlUsd,
      positions,
      tradeCount: portfolio.history.length,
    },
  };

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // Log histórico de señales (una línea por tick) para análisis y tuning
  // posterior de la estrategia: es nuestro dataset propio de backtesting.
  appendFileSync(
    SIGNALS_LOG,
    JSON.stringify({
      t: state.lastTick,
      fg: ctx.fearGreedValue,
      signals: ctx.signals.map((s) => ({
        sym: s.symbol,
        px: s.priceUsd,
        p1h: s.percentChange1h,
        p24h: s.percentChange24h,
        p7d: s.percentChange7d,
        vol: s.volume24h,
        volChg: s.volumeChange24h,
      })),
      actions: decisions.filter((d) => d.action !== "HOLD").map((d) => `${d.action}:${d.symbol}`),
      executed: executed.map((e) => `${e.side}:${e.symbol}:$${e.amountUsd.toFixed(0)}`),
    }) + "\n",
  );

  // Curva de equity
  let equity: EquityPoint[] = [];
  if (existsSync(EQUITY_FILE)) equity = JSON.parse(readFileSync(EQUITY_FILE, "utf-8"));
  equity.push({ t: state.lastTick, totalUsd, cashUsd: portfolio.cashUsd });
  if (equity.length > MAX_EQUITY_POINTS) equity = equity.slice(-MAX_EQUITY_POINTS);
  writeFileSync(EQUITY_FILE, JSON.stringify(equity));
}

export function readTickState(): TickState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

export function readEquity(): EquityPoint[] {
  if (!existsSync(EQUITY_FILE)) return [];
  return JSON.parse(readFileSync(EQUITY_FILE, "utf-8"));
}
