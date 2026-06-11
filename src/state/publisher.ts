import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readTickState, readEquity, type TickState } from "./telemetry.js";
import { loadPortfolio } from "./portfolio.js";

const QUEUE_FILE = join(process.cwd(), "data", "publish-queue.jsonl");

// El feed público es escaparate, no receta:
// - Los números exactos de la estrategia (pesos, umbrales) se redactan hasta
//   la publicación del código (21 jun). DISCLOSE_PARAMS=true los destapa.
// - Durante la semana live, PUBLIC_FEED_DELAY_MINUTES retrasa el feed para
//   que nadie pueda copiar nuestros trades en tiempo real (los jueces miden
//   on-chain, no por el dashboard, así que no nos afecta).
function redactForPublic(state: TickState | null): TickState | null {
  if (!state || process.env.DISCLOSE_PARAMS === "true") return state;
  const s: TickState = JSON.parse(JSON.stringify(state));
  s.params.strategy = {
    ...s.params.strategy,
    momentumWeights: { h1: NaN, h24: NaN, d7: NaN },
    regimes: {
      greed: { fg: ">=75", buyThreshold: NaN, sellThreshold: NaN },
      neutral: { fg: "26-74", buyThreshold: NaN, sellThreshold: NaN },
      fear: { fg: "<=25", buyThreshold: NaN, sellThreshold: NaN },
    },
    trendingBoost: NaN,
    volumeBoost: { threshold: NaN, up: NaN, down: NaN },
    maxEntry1hPct: NaN,
  };
  delete s.params.labs; // los flags del laboratorio también son receta
  for (const d of s.decisions) {
    d.reasons = d.reasons.map((r) =>
      r
        .replace(/momentum=-?\d+(\.\d+)?/g, "momentum=●●")
        .replace(/buyTh=-?\d+(\.\d+)?/g, "buyTh=●●")
        .replace(/sellTh=-?\d+(\.\d+)?/g, "sellTh=●●"),
    );
  }
  return s;
}

// Empuja el estado al dashboard público (Vercel) si está configurado.
// Falla en silencio: la telemetría cloud nunca debe tumbar el loop de trading.
export async function publishState(): Promise<void> {
  const url = process.env.DASHBOARD_INGEST_URL;
  const token = process.env.TRITON_INGEST_TOKEN;
  if (!url || !token) return;

  try {
    const snapshot = JSON.stringify({
      state: redactForPublic(readTickState()),
      equity: readEquity(),
      history: loadPortfolio().history.slice(-50).reverse(),
    });

    // Retardo anti-copy-trading: se publica el snapshot más reciente que
    // tenga al menos N minutos de antigüedad.
    const delayMin = Number(process.env.PUBLIC_FEED_DELAY_MINUTES ?? 0);
    let body = snapshot;
    if (delayMin > 0) {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      appendFileSync(QUEUE_FILE, JSON.stringify({ ts: Date.now(), snapshot }) + "\n");
      // Líneas corruptas (crash a mitad de append) se descartan en silencio
      const lines = readFileSync(QUEUE_FILE, "utf-8")
        .trim()
        .split("\n")
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      const cutoff = Date.now() - delayMin * 60_000;
      const eligible = lines.filter((l) => l.ts <= cutoff);
      if (!eligible.length) return; // aún no hay snapshot suficientemente viejo
      body = eligible[eligible.length - 1].snapshot;
      // poda: conservar solo lo aún no publicable + el último publicado
      writeFileSync(
        QUEUE_FILE,
        lines.filter((l) => l.ts > cutoff).map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`  ⚠️ publish ${res.status}: ${(await res.text()).slice(0, 120)}`);
  } catch (err) {
    console.error("  ⚠️ publish falló:", (err as Error).message);
  }
}
