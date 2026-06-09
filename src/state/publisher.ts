import { readTickState, readEquity } from "./telemetry.js";
import { loadPortfolio } from "./portfolio.js";

// Empuja el estado al dashboard público (Vercel) si está configurado.
// Falla en silencio: la telemetría cloud nunca debe tumbar el loop de trading.
export async function publishState(): Promise<void> {
  const url = process.env.DASHBOARD_INGEST_URL;
  const token = process.env.TRITON_INGEST_TOKEN;
  if (!url || !token) return;

  try {
    const body = JSON.stringify({
      state: readTickState(),
      equity: readEquity(),
      history: loadPortfolio().history.slice(-50).reverse(),
    });
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
