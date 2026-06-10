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
  econ: { title: string; country: string; date: string; forecast: string; previous: string }[];
  screener: ScreenerRow[];
  botScan?: { updatedAt: string; results: Record<string, { ret: number; dd: number; trades: number; wr: number | null; bh: number }> } | null;
}

export interface ScreenerRow {
  sym: string;
  name: string;
  px: number;
  mcap: number;
  p1h: number;
  p24h: number;
  p7d: number;
  vol: number;
}

// Los 149 tokens elegibles de la competición (de las reglas oficiales)
const ELIGIBLE = new Set(
  `ETH USDT USDC XRP TRX DOGE ZEC ADA LINK BCH DAI TON USD1 USDE M LTC AVAX SHIB XAUT WLFI H DOT UNI ASTER DEXE USDD ETC AAVE ATOM U STABLE FIL INJ NIGHT FET TUSD BONK PENGU CAKE SIREN LUNC ZRO KITE FDUSD BEAT PIEVERSE BTT NFT EDGE FLOKI LDO B FF PENDLE NEX STG AXS TWT HOME RAY COMP GWEI XCN GENIUS XPL BAT SKYAI APE IP SFP TAG NXPC AB SAHARA 1INCH CHEEMS BANANAS31 RIVER MYX RAVE SNX FORM LAB HTX USDF CTM BDX SLX UB DUCKY FRAX BILL WFI KOGE ALE FRXUSD GOMINING VCNT GUA DUSD SMILEK 0G BEAM MY SOON REAL Q AIOZ ZIG YFI TAC LISUSD CYS ZAMA TRIA HUMA PLUME ZIL XPR ZETA BABYDOGE NILA ROSE VELO UAI BRETT OPEN BSB TOSHI BAS ACH AXL LUR ELF KAVA APR IRYS EURI XUSD BARD DUSK SUSHI PEAQ COAI BDCA XAUM`.split(/\s+/),
);

// Calendario económico tradicional (IPC, Fed, empleo...) — feed semanal
// público de ForexFactory. Solo eventos de impacto ALTO en USD/EUR.
async function fetchEconCalendar(): Promise<Intel["econ"]> {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`econ ${res.status}`);
  const events = (await res.json()) as { title: string; country: string; date: string; impact: string; forecast: string; previous: string }[];
  const now = Date.now() - 12 * 3600_000; // incluir lo de hoy aunque ya haya salido
  return events
    .filter((e) => e.impact === "High" && ["USD", "EUR"].includes(e.country) && Date.parse(e.date) > now)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(0, 6)
    .map((e) => ({ title: e.title, country: e.country, date: e.date, forecast: e.forecast ?? "", previous: e.previous ?? "" }));
}

async function fetchScreener(): Promise<ScreenerRow[]> {
  const url = new URL("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest");
  url.searchParams.set("limit", "3000");
  url.searchParams.set("convert", "USD");
  const res = await fetch(url, {
    headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`screener ${res.status}`);
  const data = (await res.json()) as { data: any[] };
  const seen = new Set<string>();
  const rows: ScreenerRow[] = [];
  for (const c of data.data) {
    const sym = String(c.symbol).toUpperCase();
    if (!ELIGIBLE.has(sym) || seen.has(sym)) continue;
    seen.add(sym);
    const q = c.quote?.USD ?? {};
    rows.push({
      sym,
      name: String(c.name).slice(0, 24),
      px: q.price ?? 0,
      mcap: q.market_cap ?? 0,
      p1h: q.percent_change_1h ?? 0,
      p24h: q.percent_change_24h ?? 0,
      p7d: q.percent_change_7d ?? 0,
      vol: q.volume_24h ?? 0,
    });
  }
  return rows;
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

    const [narrativesRaw, macroRaw, newsRaw, screener, econ] = await Promise.all([
      mcpCall("trending_crypto_narratives", { limit: 6 }).catch(() => null),
      mcpCall("get_upcoming_macro_events", {}).catch(() => null),
      mcpCall("get_crypto_latest_news", { id: "1" }).catch(() => null), // BTC = pulso del mercado
      fetchScreener().catch(() => [] as ScreenerRow[]),
      fetchEconCalendar().catch(() => [] as Intel["econ"]),
    ]);

    const intel: Intel = {
      updatedAt: new Date().toISOString(),
      narratives: rowsToObjects(narrativesRaw?.categoryList).slice(0, 6).map((n) => ({
        rank: Number(n.trendingRank ?? 0),
        name: String(n.categoryName ?? ""),
        change24h: String(n.marketCapChangePercentage24h ?? ""),
        keywords: Array.isArray(n.socialKeywords) ? (n.socialKeywords as string[]).slice(0, 3) : [],
      })),
      macroEvents: rowsToObjects(macroRaw?.upcomingEventNews)
        .map((e) => ({ title: String(e.title ?? ""), date: String(e.eventDate ?? "") }))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
        .slice(0, 4),
      // Anti-spam: solo titulares de calidad, sin anuncios de prediction
      // markets ni texto no-latino
      news: rowsToObjects(newsRaw)
        .filter((n) => {
          const t = String(n.title ?? "");
          const q = String(n.quality ?? "").toLowerCase();
          const ascii = (t.match(/[\x20-\x7e]/g) || []).length / Math.max(t.length, 1);
          return ascii > 0.9 && !/prediction market|coinbase predictions|invest|earn up to/i.test(t) && q !== "low";
        })
        .slice(0, 4)
        .map((n) => ({ title: String(n.title ?? ""), url: n.url ? String(n.url) : undefined })),
      econ,
      screener,
      botScan: existsSync(join(process.cwd(), "data", "bot-scan.json"))
        ? JSON.parse(readFileSync(join(process.cwd(), "data", "bot-scan.json"), "utf-8"))
        : null,
    };

    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(intel, null, 2));

    // Registro horario de los top movers elegibles (24h): evidencia para
    // decidir el 19 jun si se activa el "satélite" de alta beta — ¿los pumps
    // del universo elegible duran días (entrables) o mueren en horas?
    if (intel.screener.length) {
      const movers = [...intel.screener]
        .sort((a, b) => b.p24h - a.p24h)
        .slice(0, 5)
        .map((r) => `${r.sym}:${r.p24h.toFixed(1)}%/24h,${r.p7d.toFixed(1)}%/7d,vol$${(r.vol / 1e6).toFixed(0)}M`);
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        join(process.cwd(), "data", "movers-log.jsonl"),
        JSON.stringify({ t: intel.updatedAt, top: movers }) + "\n",
      );
    }
    return intel;
  } catch (err) {
    console.error("  ⚠️ intel MCP falló (no crítico):", (err as Error).message);
    // El propio cache puede ser la causa del fallo (corrupto): nunca re-lanzar
    try {
      return existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf-8")) as Intel) : null;
    } catch {
      return null;
    }
  }
}
