import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Decision, MarketContext, Portfolio } from "../types.js";
import type { RiskResult } from "../risk/manager.js";
import { RISK_LIMITS, config } from "../config.js";
import { STRATEGY_PARAMS } from "../strategy/engine.js";

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
  trending: string[];
  high48h?: Record<string, number>;
  decisions: {
    symbol: string;
    action: string;
    confidence: number;
    reasons: string[];
    priceUsd: number;
    pct1h: number;
    pct24h: number;
    pct7d: number;
    trending: boolean;
  }[];
  blocked: { symbol: string; action: string; why: string }[];
  ordersExecuted: { side: string; symbol: string; amountUsd: number; priceUsd: number; reason: string; txHash?: string }[];
  portfolio: {
    cashUsd: number;
    totalUsd: number;
    realizedPnlUsd: number;
    dailyPnlUsd: number;
    positions: { symbol: string; qty: number; avgEntryUsd: number; currentUsd: number; pnlPct: number; openedAt: string; peakUsd?: number; strategy?: string; stopUsd?: number }[];
    tradeCount: number;
    maxDrawdownPct: number;
    winRate: number | null; // null hasta que haya trades cerrados
    closedTrades: number;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    profitFactor: number | null; // ganancias brutas / pérdidas brutas
  };
  params: {
    strategy: typeof STRATEGY_PARAMS;
    risk: typeof RISK_LIMITS;
    ops: { tickSeconds: number; fastCheckSeconds: number; watchlist: string[]; complianceTradeUsd: number };
  };
  intel?: import("../signals/intel.js").Intel | null;
}

function maxDrawdownPct(equity: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.totalUsd);
    maxDd = Math.max(maxDd, (peak - p.totalUsd) / peak);
  }
  return maxDd * 100;
}

export function writeTickState(
  ctx: MarketContext,
  decisions: Decision[],
  risk: RiskResult,
  executed: TickState["ordersExecuted"],
  portfolio: Portfolio,
  executionMode: string,
  intel?: import("../signals/intel.js").Intel | null,
): void {
  const priceOf = (sym: string) => ctx.signals.find((s) => s.symbol === sym)?.priceUsd ?? 0;
  const positions = portfolio.positions.map((p) => {
    const price = priceOf(p.symbol) || p.avgEntryUsd;
    // Nivel de stop vigente (réplica de la lógica del risk manager, para el chart)
    let stopUsd: number;
    if (p.strategy === "range") {
      stopUsd = p.avgEntryUsd * 0.97;
    } else {
      const peak = p.peakUsd ?? p.avgEntryUsd;
      const armed = (peak - p.avgEntryUsd) / p.avgEntryUsd >= RISK_LIMITS.trailingActivationPct;
      stopUsd = Math.max(p.avgEntryUsd * (1 - RISK_LIMITS.stopLossPct), armed ? peak * (1 - RISK_LIMITS.trailingStopPct) : 0);
    }
    return {
      symbol: p.symbol,
      qty: p.qty,
      avgEntryUsd: p.avgEntryUsd,
      currentUsd: p.qty * price,
      pnlPct: ((price - p.avgEntryUsd) / p.avgEntryUsd) * 100,
      openedAt: p.openedAt,
      peakUsd: p.peakUsd,
      strategy: p.strategy,
      stopUsd,
    };
  });
  const totalUsd = portfolio.cashUsd + positions.reduce((s, p) => s + p.currentUsd, 0);

  // Curva de equity (se actualiza primero para poder calcular el drawdown)
  let equity: EquityPoint[] = [];
  if (existsSync(EQUITY_FILE)) equity = JSON.parse(readFileSync(EQUITY_FILE, "utf-8"));
  equity.push({ t: new Date().toISOString(), totalUsd, cashUsd: portfolio.cashUsd });
  if (equity.length > MAX_EQUITY_POINTS) equity = equity.slice(-MAX_EQUITY_POINTS);

  const closed = portfolio.history.filter((f) => f.order.side === "SELL" && f.realizedPnlUsd !== undefined);
  const winFills = closed.filter((f) => (f.realizedPnlUsd ?? 0) > 0);
  const lossFills = closed.filter((f) => (f.realizedPnlUsd ?? 0) <= 0);
  const wins = winFills.length;
  const grossWin = winFills.reduce((s, f) => s + (f.realizedPnlUsd ?? 0), 0);
  const grossLoss = Math.abs(lossFills.reduce((s, f) => s + (f.realizedPnlUsd ?? 0), 0));

  const state: TickState = {
    lastTick: new Date().toISOString(),
    executionMode,
    fearGreedValue: ctx.fearGreedValue,
    fearGreedLabel: ctx.fearGreedLabel,
    killSwitchActive: risk.killSwitchActive,
    trending: ctx.trending.filter((t) => ctx.signals.some((s) => s.symbol === t)),
    high48h: ctx.high48h,
    decisions: decisions.map((d) => ({
      symbol: d.symbol,
      action: d.action,
      confidence: d.confidence,
      reasons: d.reasons,
      priceUsd: d.signal.priceUsd,
      pct1h: d.signal.percentChange1h,
      pct24h: d.signal.percentChange24h,
      pct7d: d.signal.percentChange7d,
      trending: ctx.trending.includes(d.symbol),
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
      maxDrawdownPct: maxDrawdownPct(equity),
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      closedTrades: closed.length,
      avgWinUsd: wins ? grossWin / wins : null,
      avgLossUsd: lossFills.length ? -grossLoss / lossFills.length : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    },
    params: {
      strategy: STRATEGY_PARAMS,
      risk: RISK_LIMITS,
      ops: {
        tickSeconds: config.tickIntervalSeconds,
        fastCheckSeconds: config.fastCheckSeconds,
        watchlist: Object.keys(config.watchlist),
        complianceTradeUsd: config.complianceTradeUsd,
      },
    },
    intel: intel ?? null,
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

// Máximo de precio por símbolo en las últimas N horas, reconstruido de
// nuestro propio log de señales (para detectar breakouts en vivo).
export function readRecentHighs(hours: number): Record<string, number> {
  if (!existsSync(SIGNALS_LOG)) return {};
  const cutoff = Date.now() - hours * 3600_000;
  const highs: Record<string, number> = {};
  for (const line of readFileSync(SIGNALS_LOG, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { t: string; signals: { sym: string; px: number }[] };
      if (Date.parse(entry.t) < cutoff) continue;
      for (const s of entry.signals) {
        if (!(s.sym in highs) || s.px > highs[s.sym]) highs[s.sym] = s.px;
      }
    } catch {
      /* línea corrupta: ignorar */
    }
  }
  return highs;
}
