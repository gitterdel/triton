import { RISK_LIMITS } from "../config.js";
import type { Decision, Order, Portfolio, TokenSignal } from "../types.js";

export interface RiskResult {
  orders: Order[];
  blocked: { decision: Decision; why: string }[];
  killSwitchActive: boolean;
}

function portfolioValueUsd(p: Portfolio, signals: TokenSignal[]): number {
  const priceOf = (sym: string) => signals.find((s) => s.symbol === sym)?.priceUsd ?? 0;
  return p.cashUsd + p.positions.reduce((sum, pos) => sum + pos.qty * priceOf(pos.symbol), 0);
}

// Aplica los límites duros sobre las decisiones de la estrategia y genera
// órdenes ejecutables. También emite cierres forzosos por stop-loss/take-profit,
// que tienen prioridad sobre cualquier señal.
export function applyRisk(decisions: Decision[], portfolio: Portfolio, signals: TokenSignal[]): RiskResult {
  const orders: Order[] = [];
  const blocked: RiskResult["blocked"] = [];
  const totalValue = portfolioValueUsd(portfolio, signals);

  // 1. Kill switch diario
  const killSwitchActive = portfolio.dailyPnlUsd <= -RISK_LIMITS.dailyLossCapPct * totalValue;

  // 2. Stop-loss / take-profit: se evalúan siempre, incluso con kill switch
  //    (cerrar posiciones reduce riesgo, abrirlas lo aumenta).
  for (const pos of portfolio.positions) {
    const sig = signals.find((s) => s.symbol === pos.symbol);
    if (!sig) continue;

    // Actualizar máximo visto (se persiste al guardar el portfolio)
    pos.peakUsd = Math.max(pos.peakUsd ?? pos.avgEntryUsd, sig.priceUsd);

    const change = (sig.priceUsd - pos.avgEntryUsd) / pos.avgEntryUsd;
    const peakGain = (pos.peakUsd - pos.avgEntryUsd) / pos.avgEntryUsd;
    const fromPeak = (sig.priceUsd - pos.peakUsd) / pos.peakUsd;

    if (change <= -RISK_LIMITS.stopLossPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        reason: `STOP-LOSS: ${(change * 100).toFixed(2)}% desde entrada ${pos.avgEntryUsd.toFixed(4)}`,
      });
    } else if (peakGain >= RISK_LIMITS.trailingActivationPct && fromPeak <= -RISK_LIMITS.trailingStopPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        reason: `TRAILING-STOP: ${(fromPeak * 100).toFixed(2)}% desde pico ${pos.peakUsd.toFixed(4)} (asegura +${(change * 100).toFixed(2)}%)`,
      });
    }
  }
  const forcedSells = new Set(orders.map((o) => o.symbol));

  // 3. Señales de la estrategia
  for (const d of decisions) {
    if (d.action === "HOLD") continue;
    if (forcedSells.has(d.symbol)) continue; // ya hay cierre forzoso

    if (d.confidence < RISK_LIMITS.minConfidenceToTrade) {
      blocked.push({ decision: d, why: `confianza ${d.confidence.toFixed(2)} < ${RISK_LIMITS.minConfidenceToTrade}` });
      continue;
    }

    if (d.action === "BUY") {
      if (killSwitchActive) {
        blocked.push({ decision: d, why: "kill switch activo (cap de pérdida diaria alcanzado)" });
        continue;
      }
      if (portfolio.positions.length >= RISK_LIMITS.maxOpenPositions) {
        blocked.push({ decision: d, why: `máximo de posiciones abiertas (${RISK_LIMITS.maxOpenPositions})` });
        continue;
      }
      const maxByPct = totalValue * RISK_LIMITS.maxPositionPctOfPortfolio;
      const amountUsd = Math.min(RISK_LIMITS.maxTradeUsd, maxByPct, portfolio.cashUsd * 0.95);
      if (amountUsd < RISK_LIMITS.minTradeUsd) {
        blocked.push({ decision: d, why: `importe ${amountUsd.toFixed(2)} USD < mínimo ${RISK_LIMITS.minTradeUsd}` });
        continue;
      }
      orders.push({
        symbol: d.symbol,
        side: "BUY",
        amountUsd,
        priceUsd: d.signal.priceUsd,
        reason: d.reasons[0],
      });
    } else {
      const pos = portfolio.positions.find((p) => p.symbol === d.symbol);
      if (!pos) continue;
      orders.push({
        symbol: d.symbol,
        side: "SELL",
        amountUsd: pos.qty * d.signal.priceUsd,
        priceUsd: d.signal.priceUsd,
        reason: d.reasons[0],
      });
    }
  }

  return { orders, blocked, killSwitchActive };
}
