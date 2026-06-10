import { config } from "../config.js";
import type { MarketContext, TokenSignal } from "../types.js";

const BASE = "https://pro-api.coinmarketcap.com";

async function cmcGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey, Accept: "application/json" },
    // Sin timeout, una red caída (PC durmiendo, wifi) deja el loop colgado
    // PARA SIEMPRE en un await. Con timeout, falla y el loop reintenta.
    signal: AbortSignal.timeout(20_000),
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

export async function fetchQuotes(extraSymbols: string[] = []): Promise<TokenSignal[]> {
  const idSet = new Set(Object.values(config.watchlist).map((t) => t.id));
  // Posiciones abiertas fuera de la watchlist: sus stops necesitan precio
  for (const sym of extraSymbols) {
    const id = config.watchlist[sym]?.id ?? config.knownIds[sym];
    if (id) idSet.add(id);
  }
  const ids = [...idSet].join(",");
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

// Tokens trending en CMC: proxy de atención/narrativa de mercado. La atención
// amplifica el momentum — un token con momentum Y trending tiene más
// probabilidad de continuación. Falla en silencio (señal opcional).
export async function fetchTrending(): Promise<string[]> {
  try {
    const res = await cmcGet<{ data: { symbol: string }[] }>("/v1/cryptocurrency/trending/latest", {
      limit: "30",
    });
    return res.data.map((d) => d.symbol);
  } catch {
    return [];
  }
}

export async function fetchMarketContext(extraSymbols: string[] = []): Promise<MarketContext> {
  const [signals, fearGreed, trending] = await Promise.all([
    fetchQuotes(extraSymbols),
    fetchFearGreed(),
    fetchTrending(),
  ]);
  return { signals, fearGreedValue: fearGreed.value, fearGreedLabel: fearGreed.label, trending };
}
