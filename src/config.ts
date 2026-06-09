import "dotenv/config";

export const config = {
  cmcApiKey: process.env.CMC_API_KEY ?? "",
  twakAccessId: process.env.TWAK_ACCESS_ID ?? "",
  twakHmacSecret: process.env.TWAK_HMAC_SECRET ?? "",
  executionMode: (process.env.EXECUTION_MODE ?? "paper") as "paper" | "live",
  paperStartingUsd: Number(process.env.PAPER_STARTING_USD ?? 1000),
  tickIntervalSeconds: Number(process.env.TICK_INTERVAL_SECONDS ?? 300),
  // Vigilancia rápida de stops entre ticks completos ("drawdown = reaction time")
  fastCheckSeconds: Number(process.env.FAST_CHECK_SECONDS ?? 60),

  // Tokens con buena liquidez en PancakeSwap (BSC). symbol -> CMC id.
  watchlist: {
    BNB: 1839,
    CAKE: 7186,
    ETH: 1027,
    BTCB: 4023,
    XRP: 52,
    SOL: 5426,
    DOGE: 74,
    ADA: 2010,
  } as Record<string, number>,
};

// Límites duros de riesgo. El RiskManager los aplica SIEMPRE,
// independientemente de lo que diga la estrategia. No son configurables
// por env a propósito: cambiarlos exige tocar código y pasar por revisión.
export const RISK_LIMITS = {
  maxPositionPctOfPortfolio: 0.2, // ninguna posición > 20% del portfolio
  maxOpenPositions: 4,
  minTradeUsd: 10,
  maxTradeUsd: 200,
  stopLossPct: 0.05, // cerrar si la posición cae 5% desde la entrada
  // Trailing stop en vez de take-profit fijo: deja correr a los ganadores y
  // asegura beneficio. Se activa cuando la posición supera el umbral de
  // activación; a partir de ahí, cierra si cae X% desde el máximo visto.
  trailingStopPct: 0.04, // cerrar si cae 4% desde el pico
  trailingActivationPct: 0.03, // el trailing se arma a partir de +3% sobre entrada
  dailyLossCapPct: 0.08, // si el día acumula -8%, kill switch hasta mañana
  minConfidenceToTrade: 0.6,
  simulatedFeePct: 0.0025, // 0.25% por lado, aprox PancakeSwap
};
