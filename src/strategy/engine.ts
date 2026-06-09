import type { Decision, MarketContext, Portfolio, TokenSignal } from "../types.js";

// Estrategia: momentum ponderado por régimen de mercado (Fear & Greed).
// - Momentum: combinación de cambios 1h/24h/7d, con más peso al corto plazo.
// - Volumen creciente confirma el movimiento.
// - F&G actúa de regulador contrario: con Extreme Greed exigimos más señal
//   para comprar; con Extreme Fear, más señal para vender (evitar pánico).

function momentumScore(s: TokenSignal): number {
  const m = s.percentChange1h * 0.5 + s.percentChange24h * 0.35 + s.percentChange7d * 0.15;
  const volBoost = s.volumeChange24h > 20 ? 1.2 : s.volumeChange24h < -20 ? 0.8 : 1;
  return m * volBoost;
}

function regimeAdjustment(fearGreed: number): { buyThreshold: number; sellThreshold: number } {
  // Base: comprar si score > 1.5, vender si score < -2
  if (fearGreed >= 75) return { buyThreshold: 3, sellThreshold: -1.5 }; // greed: cautela al comprar
  if (fearGreed <= 25) return { buyThreshold: 1, sellThreshold: -4 }; // fear: oportunidad, no pánico
  return { buyThreshold: 1.5, sellThreshold: -2 };
}

export function decide(ctx: MarketContext, portfolio: Portfolio): Decision[] {
  const { buyThreshold, sellThreshold } = regimeAdjustment(ctx.fearGreedValue);
  const held = new Set(portfolio.positions.map((p) => p.symbol));

  return ctx.signals.map((s) => {
    const score = momentumScore(s);
    const reasons: string[] = [
      `momentum=${score.toFixed(2)} (1h=${s.percentChange1h.toFixed(2)}%, 24h=${s.percentChange24h.toFixed(2)}%, 7d=${s.percentChange7d.toFixed(2)}%)`,
      `volChange24h=${s.volumeChange24h.toFixed(1)}%`,
      `F&G=${ctx.fearGreedValue} (${ctx.fearGreedLabel}) -> buyTh=${buyThreshold}, sellTh=${sellThreshold}`,
    ];

    if (score >= buyThreshold && !held.has(s.symbol)) {
      const confidence = Math.min(0.95, 0.5 + (score - buyThreshold) / 10);
      return { symbol: s.symbol, action: "BUY" as const, confidence, reasons, signal: s };
    }
    if (score <= sellThreshold && held.has(s.symbol)) {
      const confidence = Math.min(0.95, 0.5 + (sellThreshold - score) / 10);
      return { symbol: s.symbol, action: "SELL" as const, confidence, reasons, signal: s };
    }
    return { symbol: s.symbol, action: "HOLD" as const, confidence: 0, reasons, signal: s };
  });
}
