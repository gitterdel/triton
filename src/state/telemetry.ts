import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Decision, MarketContext, Portfolio } from "../types.js";
import type { RiskResult } from "../risk/manager.js";
import { RISK_LIMITS, config } from "../config.js";
import { STRATEGY_PARAMS } from "../strategy/engine.js";

// Los TEST_* del laboratorio sobreescriben parámetros en runtime: la
// telemetría (y el DISCLOSE_PARAMS que verán los jueces desde el 20-21)
// debe publicar los valores EFECTIVOS, no los defaults compilados.
function effectiveStrategyParams(): typeof STRATEGY_PARAMS {
  const p: typeof STRATEGY_PARAMS = JSON.parse(JSON.stringify(STRATEGY_PARAMS));
  p.regimes.fear.buyThreshold = Number(process.env.TEST_FEAR_TH ?? p.regimes.fear.buyThreshold);
  p.regimes.neutral.buyThreshold = Number(process.env.TEST_NEUTRAL_TH ?? p.regimes.neutral.buyThreshold);
  p.maxEntry1hPct = Number(process.env.TEST_MAX_1H ?? p.maxEntry1hPct);
  return p;
}
function effectiveLabs(): Record<string, number | boolean> {
  const labs: Record<string, number | boolean> = {
    early_vol: process.env.TEST_EARLY_VOL === "1",
    vol_sizing: process.env.TEST_VOL_SIZING === "1",
    cooldown_h: Number(process.env.TEST_COOLDOWN_H ?? 24),
    time_exit_h: Number(process.env.TEST_TIME_EXIT_H ?? 0),
    bull_mode: process.env.TEST_BULL_MODE === "1",
  };
  if (labs.bull_mode) {
    labs.bull_fg = Number(process.env.TEST_BULL_FG ?? 55);
    labs.bull_7d_min = Number(process.env.TEST_BULL_7D ?? 5);
    labs.bull_stop_pct = Number(process.env.TEST_BULL_STOP ?? 10);
    labs.bull_arm_pct = Number(process.env.TEST_BULL_ARM ?? 5);
    labs.bull_trail_pct = Number(process.env.TEST_BULL_TRAIL ?? 12);
  }
  return labs;
}

const STATE_FILE = join(process.cwd(), "data", "state.json");
const EQUITY_FILE = join(process.cwd(), "data", "equity.json");
const SIGNALS_LOG = join(process.cwd(), "data", "signals-log.jsonl");
const JOURNAL_FILE = join(process.cwd(), "data", "trade-journal.jsonl");
// 20k puntos ≈ 69 días a ticks de 5 min — el tope anterior (5000 ≈ 17d)
// habría deslizado el inicio del track record EN MEDIO de la semana live.
const MAX_EQUITY_POINTS = 20000;

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
    labs?: Record<string, number | boolean>;
    ops: { tickSeconds: number; fastCheckSeconds: number; watchlist: string[]; complianceTradeUsd: number };
  };
  trackRecord?: TrackRecord | null;
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

// Track record estilo cuenta de fondeo (prop firm): las métricas que un
// inversor exigiría antes de poner dinero. Se calculan de la curva de
// equity real + trades cerrados; los ratios que necesitan muestra mínima
// (Sharpe/Sortino/anualizado) devuelven null hasta tenerla — un Sharpe de
// 3 días sería marketing, no estadística.
export interface TrackRecord {
  sinceIso: string;
  days: number;
  startUsd: number;
  equityUsd: number;
  totalReturnPct: number;
  annualizedReturnPct: number | null; // null si <7 días de historia
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  dailyVolPct: number | null; // desviación típica de retornos diarios
  sharpe: number | null; // anualizado √365, rf=0; null si <5 retornos diarios
  sortino: number | null;
  calmar: number | null; // anualizado / maxDD
  bestDayPct: number | null;
  worstDayPct: number | null;
  avgExposurePct: number; // % medio del capital invertido (no en cash)
  closedTrades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null; // PnL medio por trade cerrado
  avgHoldHours: number | null; // del trade-journal (si existe)
  maxConsecLosses: number | null;
}

function computeTrackRecord(equity: EquityPoint[], portfolio: Portfolio): TrackRecord | null {
  if (equity.length < 2) return null;
  const first = equity[0];
  const last = equity[equity.length - 1];
  const days = (Date.parse(last.t) - Date.parse(first.t)) / 86_400_000;
  const totalReturnPct = (last.totalUsd / first.totalUsd - 1) * 100;

  // Retornos sobre cierres diarios (último punto de cada día UTC)
  const byDay = new Map<string, number>();
  for (const p of equity) byDay.set(p.t.slice(0, 10), p.totalUsd);
  const closes = [...byDay.values()];
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : 0;

  const maxDd = maxDrawdownPct(equity);
  let peak = -Infinity;
  for (const p of equity) peak = Math.max(peak, p.totalUsd);
  const annualizedReturnPct = days >= 7 ? (Math.pow(last.totalUsd / first.totalUsd, 365 / days) - 1) * 100 : null;
  const enough = rets.length >= 5;

  const closed = portfolio.history.filter((f) => f.order.side === "SELL" && f.realizedPnlUsd !== undefined);
  const wins = closed.filter((f) => (f.realizedPnlUsd ?? 0) > 0);
  const losses = closed.filter((f) => (f.realizedPnlUsd ?? 0) <= 0);
  const grossWin = wins.reduce((s, f) => s + (f.realizedPnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, f) => s + (f.realizedPnlUsd ?? 0), 0));
  let maxConsec = 0;
  let run = 0;
  for (const f of closed) {
    if ((f.realizedPnlUsd ?? 0) <= 0) maxConsec = Math.max(maxConsec, ++run);
    else run = 0;
  }

  // Hold medio desde el diario de operaciones (si existe y es legible)
  let avgHoldHours: number | null = null;
  try {
    if (existsSync(JOURNAL_FILE)) {
      const holds = readFileSync(JOURNAL_FILE, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l).holdHours as number)
        .filter((h) => Number.isFinite(h));
      if (holds.length) avgHoldHours = holds.reduce((a, b) => a + b, 0) / holds.length;
    }
  } catch {
    /* diario corrupto: métrica ausente, no fatal */
  }

  return {
    sinceIso: first.t,
    days: Math.round(days * 10) / 10,
    startUsd: first.totalUsd,
    equityUsd: last.totalUsd,
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct: maxDd,
    currentDrawdownPct: ((peak - last.totalUsd) / peak) * 100,
    dailyVolPct: enough ? sd * 100 : null,
    sharpe: enough && sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
    sortino: enough && dsd > 0 ? (mean / dsd) * Math.sqrt(365) : null,
    calmar: annualizedReturnPct != null && maxDd > 0 ? annualizedReturnPct / maxDd : null,
    bestDayPct: rets.length ? Math.max(...rets) * 100 : null,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : null,
    avgExposurePct: (equity.reduce((s, p) => s + (1 - p.cashUsd / (p.totalUsd || 1)), 0) / equity.length) * 100,
    closedTrades: closed.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyUsd: closed.length ? closed.reduce((s, f) => s + (f.realizedPnlUsd ?? 0), 0) / closed.length : null,
    avgHoldHours,
    maxConsecLosses: closed.length ? maxConsec : null,
  };
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
    } else if (p.strategy === "bull") {
      // Correa larga del módulo bull (auditoría 11-jun: el dashboard mostraba
      // el stop fino del momentum para posiciones cuyo suelo real es BULL_STOP)
      const stop = Number(process.env.TEST_BULL_STOP ?? 10) / 100;
      const arm = Number(process.env.TEST_BULL_ARM ?? 5) / 100;
      const trail = Number(process.env.TEST_BULL_TRAIL ?? 12) / 100;
      const peak = p.peakUsd ?? p.avgEntryUsd;
      const armed = (peak - p.avgEntryUsd) / p.avgEntryUsd >= arm;
      stopUsd = Math.max(p.avgEntryUsd * (1 - stop), armed ? peak * (1 - trail) : 0);
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

  // Curva de equity (se actualiza primero para poder calcular el drawdown).
  // Tolerante a corrupción: un equity.json truncado se regenera vacío en vez
  // de matar writeTickState para siempre (auditoría).
  let equity: EquityPoint[] = [];
  if (existsSync(EQUITY_FILE)) {
    try {
      equity = JSON.parse(readFileSync(EQUITY_FILE, "utf-8"));
    } catch {
      console.error("⚠️ equity.json corrupto — regenerando");
      equity = [];
    }
  }
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
      strategy: effectiveStrategyParams(),
      risk: RISK_LIMITS,
      labs: effectiveLabs(),
      ops: {
        tickSeconds: config.tickIntervalSeconds,
        fastCheckSeconds: config.fastCheckSeconds,
        watchlist: Object.keys(config.watchlist),
        complianceTradeUsd: config.complianceTradeUsd,
      },
    },
    trackRecord: computeTrackRecord(equity, portfolio),
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
export function readRecentExtremes(hours: number): { highs: Record<string, number>; lows: Record<string, number> } {
  const highs: Record<string, number> = {};
  const lows: Record<string, number> = {};
  if (!existsSync(SIGNALS_LOG)) return { highs, lows };
  const cutoff = Date.now() - hours * 3600_000;
  for (const line of readFileSync(SIGNALS_LOG, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { t: string; signals: { sym: string; px: number }[] };
      if (Date.parse(entry.t) < cutoff) continue;
      for (const s of entry.signals) {
        if (!(s.sym in highs) || s.px > highs[s.sym]) highs[s.sym] = s.px;
        if (!(s.sym in lows) || s.px < lows[s.sym]) lows[s.sym] = s.px;
      }
    } catch {
      /* línea corrupta: ignorar */
    }
  }
  return { highs, lows };
}
