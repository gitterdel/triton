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
// nowMs: reloj inyectable — en vivo el caller usa el default (Date.now, según
// auditoría M3: nunca el timestamp de CMC); los backtests pasan su tiempo
// simulado para que el cooldown exista también dentro de la simulación.
export function applyRisk(decisions: Decision[], portfolio: Portfolio, signals: TokenSignal[], nowMs: number = Date.now()): RiskResult {
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
    // Episodio cerrado: el high-water mark se resetea al nivel actual. Sin
    // esto, el bot quedaba congelado PARA SIEMPRE tras un episodio (y en
    // competición violaría el mínimo de 1 trade/día).
    portfolio.peakEquityUsd = totalValue;
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
    // Guarda anti-spike (auditoría B3 + worklist 3, 12-jun): un print basura
    // no debe armar el trailing sobre un pico fantasma. Saltos de pico >5%
    // exigen DOS lecturas consecutivas (el fantasma no repite; al confirmar
    // se toma la MENOR de las dos). Sustituye el gate 1.25, que dejaba pasar
    // fantasmas de +13..25% y congelaba PARA SIEMPRE los reales >25%.
    const prevPeak = pos.peakUsd ?? pos.avgEntryUsd;
    if (sig.priceUsd <= prevPeak * 1.05) {
      pos.peakUsd = Math.max(prevPeak, sig.priceUsd);
      pos.pendingPeakUsd = undefined;
    } else if (pos.pendingPeakUsd != null) {
      pos.peakUsd = Math.min(pos.pendingPeakUsd, sig.priceUsd); // confirmado por 2ª lectura
      pos.pendingPeakUsd = undefined;
    } else {
      pos.peakUsd = prevPeak; // el pico vigente no se mueve todavía
      pos.pendingPeakUsd = sig.priceUsd; // 1ª lectura del salto: cuarentena
    }

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

    // Posiciones BULL (lab): la tendencia se deja correr — stop ancho y
    // trailing lejano. Las salidas finas del momentum son las que mataban
    // los bulls (campaña 11-jun: 2000d bot -66% vs B&H +256%). Saltan
    // también el time-exit: una tendencia puede tardar días en despegar.
    if (pos.strategy === "bull") {
      const bullStop = Number(process.env.TEST_BULL_STOP ?? 10) / 100;
      const bullArm = Number(process.env.TEST_BULL_ARM ?? 5) / 100;
      const bullTrail = Number(process.env.TEST_BULL_TRAIL ?? 12) / 100;
      if (change <= -bullStop) {
        orders.push({
          symbol: pos.symbol,
          side: "SELL",
          amountUsd: pos.qty * sig.priceUsd,
          priceUsd: sig.priceUsd,
          qty: pos.qty,
          reason: `BULL STOP: ${(change * 100).toFixed(2)}% desde entrada ${pos.avgEntryUsd.toFixed(4)} (correa ${-bullStop * 100}%)`,
        });
      } else if (peakGain >= bullArm && fromPeak <= -bullTrail) {
        orders.push({
          symbol: pos.symbol,
          side: "SELL",
          amountUsd: pos.qty * sig.priceUsd,
          priceUsd: sig.priceUsd,
          qty: pos.qty,
          reason: `BULL TRAILING: ${(fromPeak * 100).toFixed(2)}% desde pico ${(pos.peakUsd ?? pos.avgEntryUsd).toFixed(4)} (asegura ${(change * 100).toFixed(2)}%)`,
        });
      }
      continue;
    }

    // L-TIME (lab, robada de E0V1E/comunidad): rescate por tiempo — una
    // posición estancada >N horas sin despegar se cierra; el capital parado
    // tiene coste de oportunidad y los trades que funcionan lo hacen pronto.
    const TIME_H = Number(process.env.TEST_TIME_EXIT_H ?? 0); // 0 = apagado
    const ageH = (Date.parse(sig.timestamp || new Date().toISOString()) - Date.parse(pos.openedAt)) / 3600_000;
    if (TIME_H > 0 && ageH > TIME_H && change < 0.01 && change > -RISK_LIMITS.stopLossPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        qty: pos.qty,
        reason: `TIME-EXIT: ${ageH.toFixed(0)}h estancada a ${(change * 100).toFixed(2)}% — rotar capital`,
      });
      continue;
    }

    // H9 (lab): salidas adaptativas a la volatilidad (estilo ATR) — el stop
    // fijo es ancho en calma y un suspiro en días violentos (saca por ruido).
    // TEST_ATR_EXITS = factor sobre el rango 24h del token (stop = rango×F,
    // acotado 3–10%; trailing y armado escalan en proporción). 0 = apagado.
    const ATR_F = Number(process.env.TEST_ATR_EXITS ?? 0);
    let stopPct = RISK_LIMITS.stopLossPct;
    let trailPct = RISK_LIMITS.trailingStopPct;
    let armPct = RISK_LIMITS.trailingActivationPct;
    if (ATR_F > 0 && sig.range24hPct && sig.range24hPct > 0) {
      stopPct = Math.min(0.1, Math.max(0.03, (sig.range24hPct / 100) * ATR_F));
      trailPct = stopPct * 0.8;
      armPct = stopPct * 0.6;
    }

    // TEST_TRAIL_RATCHET (lab, RECHAZADO 12-jun): "at:trail" — al superar
    // +at% de pico, la correa se afloja a trail%. Neutral en todas las
    // ventanas (mejor caso 1000d +0.8pp; resto ±0.3) — Occam lo retira:
    // los ganadores >10% del momentum son tan raros que no mueve la aguja.
    const RATCHET = process.env.TEST_TRAIL_RATCHET; // ej. "10:8"; vacío = off
    if (RATCHET) {
      const [at, t] = RATCHET.split(":").map(Number);
      if (at > 0 && t > 0 && peakGain >= at / 100) trailPct = Math.max(trailPct, t / 100);
    }

    if (change <= -stopPct) {
      orders.push({
        symbol: pos.symbol,
        side: "SELL",
        amountUsd: pos.qty * sig.priceUsd,
        priceUsd: sig.priceUsd,
        qty: pos.qty,
        reason: `STOP-LOSS: ${(change * 100).toFixed(2)}% desde entrada ${pos.avgEntryUsd.toFixed(4)}${ATR_F > 0 ? ` (stop adaptativo ${(stopPct * 100).toFixed(1)}%)` : ""}`,
      });
    } else if (peakGain >= armPct && fromPeak <= -trailPct) {
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

  // Contadores de trabajo (auditoría 11-jun): los límites se validaban sobre
  // el snapshot del portfolio, así que VARIOS BUY aceptados en el mismo tick
  // podían superar maxOpenPositions y dejar el cash en negativo (escenario
  // probable en modo bull: muchos tokens tendencian a la vez).
  let openCount = portfolio.positions.length;
  let cashLeft = portfolio.cashUsd;

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
      const COOLDOWN_H = Number(process.env.TEST_COOLDOWN_H ?? 24); // horas; 0 = apagado
      const recentLoss =
        COOLDOWN_H > 0 &&
        portfolio.history.some(
          (f) =>
            f.order.symbol === d.symbol &&
            f.order.side === "SELL" &&
            (f.realizedPnlUsd ?? 0) < 0 &&
            !f.order.reason.startsWith("COMPLIANCE") &&
            nowMs - Date.parse(f.executedAt) < COOLDOWN_H * 3600 * 1000,
        );
      if (recentLoss) {
        blocked.push({ decision: d, why: "cooldown 24h tras stop-loss en este token" });
        continue;
      }
      if (openCount >= RISK_LIMITS.maxOpenPositions) {
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
      const amountUsd = Math.min(RISK_LIMITS.maxTradeUsd * sizeFactor, maxByPct * sizeFactor, cashLeft * 0.95);
      if (amountUsd < RISK_LIMITS.minTradeUsd) {
        blocked.push({ decision: d, why: `importe ${amountUsd.toFixed(2)} USD < mínimo ${RISK_LIMITS.minTradeUsd}` });
        continue;
      }
      openCount++;
      cashLeft -= amountUsd;
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
