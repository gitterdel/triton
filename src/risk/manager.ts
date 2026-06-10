import { RISK_LIMITS } from "../config.js";
import type { Decision, Order, Portfolio, TokenSignal } from "../types.js";

export interface RiskResult {
  orders: Order[];
  blocked: { decision: Decision; why: string }[];
  killSwitchActive: boolean;
}

// Valoración única y compartida: posición sin señal se valora a su precio de
// entrada (auditoría C1: valorarla a 0 encogía el total y rompía el kill
// switch y el sizing).
export function portfolioValueUsd(p: Portfolio, signals: TokenSignal[]): number {
  return (
    p.cashUsd +
    p.positions.reduce((sum, pos) => {
      const sig = signals.find((s) => s.symbol === pos.symbol);
      return sum + pos.qty * (sig?.priceUsd ?? pos.avgEntryUsd);
    }, 0)
  );
}

// Aplica los límites duros sobre las decisiones de la estrategia y genera
// órdenes ejecutables. También emite cierres forzosos por stop-loss/take-profit,
// que tienen prioridad sobre cualquier señal.
export function applyRisk(decisions: Decision[], portfolio: Portfolio, signals: TokenSignal[]): RiskResult {
  const orders: Order[] = [];
  const blocked: RiskResult["blocked"] = [];
  const totalValue = portfolioValueUsd(portfolio, signals);

  // 0. GUARDA DURA DE DRAWDOWN TOTAL (anti-descalificación, auditoría C4):
  // high-water mark persistido en el libro; si el equity cae >20% desde el
  // pico (margen amplio sobre el 30% que descalifica), se liquida TODO a
  // cash y se bloquean compras. Nadie más vigila el acumulado.
  portfolio.peakEquityUsd = Math.max(portfolio.peakEquityUsd ?? totalValue, totalValue);
  const hardDdBreached = totalValue > 0 && totalValue < portfolio.peakEquityUsd * 0.8;
  if (hardDdBreached) {
    for (const pos of portfolio.positions) {
      const sig = signals.find((s) => s.symbol === pos.symbol);
      const px = sig?.priceUsd ?? pos.avgEntryUsd;
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * px,
        priceUsd: px,
        qty: pos.qty,
        reason: `HARD-DD GUARD: equity ${totalValue.toFixed(2)} < 80% del pico ${portfolio.peakEquityUsd.toFixed(2)} — liquidación defensiva`,
      });
    }
    return { orders, blocked, killSwitchActive: true };
  }

  // 1. Kill switch diario
  const killSwitchActive = totalValue > 0 && portfolio.dailyPnlUsd <= -RISK_LIMITS.dailyLossCapPct * totalValue;

  // 2. Stop-loss / take-profit: se evalúan siempre, incluso con kill switch
  //    (cerrar posiciones reduce riesgo, abrirlas lo aumenta).
  for (const pos of portfolio.positions) {
    const sig = signals.find((s) => s.symbol === pos.symbol);
    if (!sig) continue;

    // Actualizar máximo visto (se persiste al guardar el portfolio).
    // Guarda anti-spike (auditoría B3): un print basura de la API (+25% en un
    // tick) no debe armar el trailing sobre un pico fantasma.
    const prevPeak = pos.peakUsd ?? pos.avgEntryUsd;
    pos.peakUsd = sig.priceUsd <= prevPeak * 1.25 ? Math.max(prevPeak, sig.priceUsd) : prevPeak;

    const change = (sig.priceUsd - pos.avgEntryUsd) / pos.avgEntryUsd;
    const peakGain = (pos.peakUsd - pos.avgEntryUsd) / pos.avgEntryUsd;
    const fromPeak = (sig.priceUsd - pos.peakUsd) / pos.peakUsd;

    // Posiciones RANGE: salidas simétricas cortas (target/stop ±3%), sin
    // trailing — la reversión a la media toma el beneficio y se va.
    if (pos.strategy === "range") {
      if (change >= 0.03 || change <= -0.03) {
        orders.push({
          symbol: pos.symbol,
          side: "SELL",
          amountUsd: pos.qty * sig.priceUsd,
          priceUsd: sig.priceUsd,
          qty: pos.qty,
          reason: change >= 0.03
            ? `RANGE TARGET: +${(change * 100).toFixed(2)}% — beneficio tomado`
            : `RANGE STOP: ${(change * 100).toFixed(2)}% — el rango no aguantó`,
          strategy: "range",
        });
      }
      continue;
    }

    if (change <= -RISK_LIMITS.stopLossPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        qty: pos.qty,
        reason: `STOP-LOSS: ${(change * 100).toFixed(2)}% desde entrada ${pos.avgEntryUsd.toFixed(4)}`,
      });
    } else if (peakGain >= RISK_LIMITS.trailingActivationPct && fromPeak <= -RISK_LIMITS.trailingStopPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        qty: pos.qty,
        reason: `TRAILING-STOP: ${(fromPeak * 100).toFixed(2)}% desde pico ${(pos.peakUsd ?? pos.avgEntryUsd).toFixed(4)} (asegura +${(change * 100).toFixed(2)}%)`,
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
      // Cooldown post-stop: si este token nos sacó con pérdida en las últimas
      // 24h, no se recompra (evita morir a whipsaws en el mismo token).
      // Reloj propio, no el timestamp de CMC (auditoría M3: un timestamp
      // congelado o malformado rompía el cooldown en ambas direcciones).
      // Las ventas de compliance no disparan cooldown (no son stops reales).
      const recentLoss = portfolio.history.some(
        (f) =>
          f.order.symbol === d.symbol &&
          f.order.side === "SELL" &&
          (f.realizedPnlUsd ?? 0) < 0 &&
          !f.order.reason.startsWith("COMPLIANCE") &&
          Date.now() - Date.parse(f.executedAt) < 24 * 3600 * 1000,
      );
      if (recentLoss) {
        blocked.push({ decision: d, why: "cooldown 24h tras stop-loss en este token" });
        continue;
      }
      if (portfolio.positions.length >= RISK_LIMITS.maxOpenPositions) {
        blocked.push({ decision: d, why: `máximo de posiciones abiertas (${RISK_LIMITS.maxOpenPositions})` });
        continue;
      }
      const maxByPct = totalValue * RISK_LIMITS.maxPositionPctOfPortfolio;
      // Las entradas RANGE van a media talla: son apuestas de menor convicción
      let sizeFactor = d.strategy === "range" ? 0.5 : 1;
      // H3 (lab): talla por volatilidad — token más movido, posición más chica
      if (process.env.TEST_VOL_SIZING === "1") {
        sizeFactor *= Math.min(1, Math.max(0.4, 4 / Math.max(1, Math.abs(d.signal.percentChange24h))));
      }
      const amountUsd = Math.min(RISK_LIMITS.maxTradeUsd * sizeFactor, maxByPct * sizeFactor, portfolio.cashUsd * 0.95);
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
        strategy: d.strategy,
      });
    } else {
      const pos = portfolio.positions.find((p) => p.symbol === d.symbol);
      if (!pos) continue;
      orders.push({
        symbol: d.symbol,
        side: "SELL",
        amountUsd: pos.qty * d.signal.priceUsd,
        priceUsd: d.signal.priceUsd,
        qty: pos.qty,
        reason: d.reasons[0],
      });
    }
  }

  return { orders, blocked, killSwitchActive };
}
