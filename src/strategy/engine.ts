import type { Decision, MarketContext, Portfolio, TokenSignal } from "../types.js";

// Estrategia: momentum ponderado por régimen de mercado (Fear & Greed).
// - Momentum: combinación de cambios 1h/24h/7d, con más peso al corto plazo.
// - Volumen creciente confirma el movimiento.
// - F&G actúa de regulador contrario: con Extreme Greed exigimos más señal
//   para comprar; con Extreme Fear, más señal para vender (evitar pánico).

// Parámetros de la estrategia, exportados para telemetría/dashboard.
export const STRATEGY_PARAMS = {
  momentumWeights: { h1: 0.5, h24: 0.35, d7: 0.15 },
  volumeBoost: { threshold: 20, up: 1.2, down: 0.8 },
  trendingBoost: 1.2,
  regimes: {
    greed: { fg: ">=75", buyThreshold: 3, sellThreshold: -1.5 },
    neutral: { fg: "26-74", buyThreshold: 1.5, sellThreshold: -2 },
    fear: { fg: "<=25", buyThreshold: 3, sellThreshold: -4 },
  },
  buyConfirmation: "24h > 0 AND 7d > -15% AND volume24h rising",
};

function momentumScore(s: TokenSignal): number {
  const m = s.percentChange1h * 0.5 + s.percentChange24h * 0.35 + s.percentChange7d * 0.15;
  const volBoost = s.volumeChange24h > 20 ? 1.2 : s.volumeChange24h < -20 ? 0.8 : 1;
  return m * volBoost;
}

function regimeAdjustment(fearGreed: number): { buyThreshold: number; sellThreshold: number } {
  // Base: comprar si score > 1.5, vender si score < -2.
  // El backtest desmintió la versión contrarian original (buyTh=1 en fear
  // producía whipsaws constantes en tendencia bajista): en los extremos del
  // sentimiento se exige MÁS momentum para entrar, no menos.
  if (fearGreed >= 75) return { buyThreshold: 3, sellThreshold: -1.5 }; // greed: cautela al comprar
  if (fearGreed <= 25) return { buyThreshold: 3, sellThreshold: -4 }; // fear: solo momentum fuerte y confirmado
  return { buyThreshold: 1.5, sellThreshold: -2 };
}

export function decide(ctx: MarketContext, portfolio: Portfolio): Decision[] {
  const { buyThreshold, sellThreshold } = regimeAdjustment(ctx.fearGreedValue);
  const held = new Set(portfolio.positions.map((p) => p.symbol));

  const trending = new Set(ctx.trending);

  return ctx.signals.map((s) => {
    let score = momentumScore(s);
    // Boost de atención: momentum positivo + trending en CMC = mayor
    // probabilidad de continuación (la atención amplifica los movimientos).
    const isTrending = trending.has(s.symbol);
    if (isTrending && score > 0) score *= 1.2;
    const reasons: string[] = [
      `momentum=${score.toFixed(2)} (1h=${s.percentChange1h.toFixed(2)}%, 24h=${s.percentChange24h.toFixed(2)}%, 7d=${s.percentChange7d.toFixed(2)}%)${isTrending ? " 🔥trending" : ""}`,
      `volChange24h=${s.volumeChange24h.toFixed(1)}%`,
      `F&G=${ctx.fearGreedValue} (${ctx.fearGreedLabel}) -> buyTh=${buyThreshold}, sellTh=${sellThreshold}`,
    ];

    // Filtros de confirmación anti-whipsaw (validados por backtest):
    // - el 24h debe acompañar (no comprar rebotes de 1h dentro de caídas)
    // - no comprar cuchillos cayendo (7d peor que -15%)
    const confirmed = s.percentChange24h > 0 && s.percentChange7d > -15 && s.volumeChange24h > 0;

    if (score >= buyThreshold && confirmed && !held.has(s.symbol)) {
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
