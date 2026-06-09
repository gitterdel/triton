import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { config } from "../config.js";

// Inteligencia de mercado vía CMC Agent Hub MCP (mcp.coinmarketcap.com).
// El MCP expone datos que el plan REST no incluye: narrativas trending,
// noticias y calendario macro. Se refresca como máximo 1 vez/hora y NUNCA
// rompe el loop (telemetría enriquecida, no señal crítica).
//
// Nota: por diseño NO alimenta la estrategia (congelada y validada por
// backtest) — es contexto para el dashboard y para el operador humano.

const MCP_URL = "https://mcp.coinmarketcap.com/mcp";
const CACHE = join(process.cwd(), "data", "intel.json");
const TTL_MS = 60 * 60 * 1000;

export interface Intel {
  updatedAt: string;
  narratives: { rank: number; name: string; change24h: string; keywords: string[] }[];
  macroEvents: { title: string; date: string }[];
  news: { title: string; url?: string }[];
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-CMC-MCP-API-KEY": config.cmcApiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`MCP ${name} -> ${res.status}`);
  const data = (await res.json()) as { result?: { content?: { text?: string }[] } };
  return JSON.parse(data.result?.content?.[0]?.text ?? "{}");
}

function rowsToObjects(table: { headers: string[]; rows: unknown[][] } | undefined): Record<string, unknown>[] {
  if (!table?.headers || !table.rows) return [];
  return table.rows.map((r) => Object.fromEntries(table.headers.map((h, i) => [h, r[i]])));
}

export async function refreshIntel(): Promise<Intel | null> {
  try {
    if (existsSync(CACHE)) {
      const cached = JSON.parse(readFileSync(CACHE, "utf-8")) as Intel;
      if (Date.now() - Date.parse(cached.updatedAt) < TTL_MS) return cached;
    }

    const [narrativesRaw, macroRaw, newsRaw] = await Promise.all([
      mcpCall("trending_crypto_narratives", { limit: 6 }).catch(() => null),
      mcpCall("get_upcoming_macro_events", {}).catch(() => null),
      mcpCall("get_crypto_latest_news", { symbol: "ETH", limit: 4 }).catch(() => null),
    ]);

    const intel: Intel = {
      updatedAt: new Date().toISOString(),
      narratives: rowsToObjects(narrativesRaw?.categoryList).slice(0, 6).map((n) => ({
        rank: Number(n.trendingRank ?? 0),
        name: String(n.categoryName ?? ""),
        change24h: String(n.marketCapChangePercentage24h ?? ""),
        keywords: Array.isArray(n.socialKeywords) ? (n.socialKeywords as string[]).slice(0, 3) : [],
      })),
      macroEvents: rowsToObjects(macroRaw?.upcomingEventNews).slice(0, 4).map((e) => ({
        title: String(e.title ?? ""),
        date: String(e.eventDate ?? ""),
      })),
      news: (Array.isArray(newsRaw?.news) ? newsRaw.news : []).slice(0, 4).map((n: any) => ({
        title: String(n.title ?? ""),
        url: n.url ? String(n.url) : undefined,
      })),
    };

    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(intel, null, 2));
    return intel;
  } catch (err) {
    console.error("  ⚠️ intel MCP falló (no crítico):", (err as Error).message);
    return existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf-8")) as Intel) : null;
  }
}
