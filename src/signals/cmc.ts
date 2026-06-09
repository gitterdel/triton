import { config } from "../config.js";
import type { MarketContext, TokenSignal } from "../types.js";

const BASE = "https://pro-api.coinmarketcap.com";

async function cmcGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CMC ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface QuotesResponse {
  data: Record<
    string,
    {
      id: number;
      symbol: string;
      quote: {
        USD: {
          price: number;
          percent_change_1h: number;
          percent_change_24h: number;
          percent_change_7d: number;
          volume_24h: number;
          volume_change_24h: number;
          market_cap: number;
          last_updated: string;
        };
      };
    }
  >;
}

interface FearGreedResponse {
  data: { value: number; value_classification: string };
}

export async function fetchQuotes(): Promise<TokenSignal[]> {
  const ids = Object.values(config.watchlist).join(",");
  const res = await cmcGet<QuotesResponse>("/v2/cryptocurrency/quotes/latest", { id: ids });
  return Object.values(res.data).map((d) => ({
    symbol: d.symbol,
    cmcId: d.id,
    priceUsd: d.quote.USD.price,
    percentChange1h: d.quote.USD.percent_change_1h,
    percentChange24h: d.quote.USD.percent_change_24h,
    percentChange7d: d.quote.USD.percent_change_7d,
    volume24h: d.quote.USD.volume_24h,
    volumeChange24h: d.quote.USD.volume_change_24h,
    marketCap: d.quote.USD.market_cap,
    timestamp: d.quote.USD.last_updated,
  }));
}

export async function fetchFearGreed(): Promise<{ value: number; label: string }> {
  const res = await cmcGet<FearGreedResponse>("/v3/fear-and-greed/latest");
  return { value: res.data.value, label: res.data.value_classification };
}

export async function fetchMarketContext(): Promise<MarketContext> {
  const [signals, fearGreed] = await Promise.all([fetchQuotes(), fetchFearGreed()]);
  return { signals, fearGreedValue: fearGreed.value, fearGreedLabel: fearGreed.label };
}
