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

  // Tokens de la lista ELEGIBLE de la competición (149 BEP-20 en CMC) con
  // buena liquidez en BSC. OJO: BNB, BTCB y SOL NO son elegibles.
  // address: contrato BEP-20 canónico (Binance-pegged) — twak NO resuelve
  // varios de estos símbolos en BSC, los swaps van SIEMPRE por dirección.
  watchlist: {
    ETH: { id: 1027, address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
    CAKE: { id: 7186, address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
    XRP: { id: 52, address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE" },
    DOGE: { id: 74, address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43" },
    ADA: { id: 2010, address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47" },
    LINK: { id: 1975, address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD" },
    AVAX: { id: 5805, address: "0x1CE0c2827e2eF14D5C4f29a091d735A204794041" },
    DOT: { id: 6636, address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402" },
    UNI: { id: 7083, address: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1" },
    LTC: { id: 2, address: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94" },
    TWT: { id: 5964, address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003" },
    FET: { id: 3773, address: "0x031b41e504677879370e9DBcF937283A8691Fa7f" },
  } as Record<string, { id: number; address: string }>,

  // Trade mínimo diario de la competición (1/día obligatorio en la semana live)
  complianceSymbol: "ETH",
  complianceTradeUsd: 12,
  complianceHourUtc: 18, // si a las 18:00 UTC no hubo trade hoy, se fuerza uno
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
