export interface TokenSignal {
  symbol: string;
  cmcId: number;
  priceUsd: number;
  percentChange1h: number;
  percentChange24h: number;
  percentChange7d: number;
  volume24h: number;
  volumeChange24h: number;
  marketCap: number;
  timestamp: string;
}

export interface MarketContext {
  fearGreedValue: number; // 0-100
  fearGreedLabel: string; // "Extreme Fear" .. "Extreme Greed"
  signals: TokenSignal[];
  trending: string[]; // símbolos trending en CMC (señal de atención/narrativa)
  high48h?: Record<string, number>; // máximo de 48h por símbolo (para breakouts)
}

export type Action = "BUY" | "SELL" | "HOLD";
export type StrategyKind = "momentum" | "range" | "breakout";

export interface Decision {
  symbol: string;
  action: Action;
  confidence: number; // 0-1
  reasons: string[];
  signal: TokenSignal;
  strategy?: StrategyKind;
}

export interface Order {
  symbol: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  priceUsd: number;
  reason: string;
  strategy?: StrategyKind;
}

export interface Fill {
  order: Order;
  executedAt: string;
  txHash?: string; // presente en modo live
  fee: number;
  realizedPnlUsd?: number; // solo en SELL: PnL realizado de la posición cerrada
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryUsd: number;
  openedAt: string;
  peakUsd?: number; // máximo visto desde la entrada (para el trailing stop)
  strategy?: StrategyKind; // determina el perfil de salida (momentum: trailing; range: target fijo)
}

export interface Portfolio {
  cashUsd: number;
  positions: Position[];
  realizedPnlUsd: number;
  dailyPnlUsd: number;
  dailyPnlDate: string; // YYYY-MM-DD, para resetear el cap diario
  history: Fill[];
}
