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
}

export type Action = "BUY" | "SELL" | "HOLD";

export interface Decision {
  symbol: string;
  action: Action;
  confidence: number; // 0-1
  reasons: string[];
  signal: TokenSignal;
}

export interface Order {
  symbol: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  priceUsd: number;
  reason: string;
}

export interface Fill {
  order: Order;
  executedAt: string;
  txHash?: string; // presente en modo live
  fee: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryUsd: number;
  openedAt: string;
}

export interface Portfolio {
  cashUsd: number;
  positions: Position[];
  realizedPnlUsd: number;
  dailyPnlUsd: number;
  dailyPnlDate: string; // YYYY-MM-DD, para resetear el cap diario
  history: Fill[];
}
