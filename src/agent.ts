import { config } from "./config.js";
import { fetchMarketContext } from "./signals/cmc.js";
import { decide } from "./strategy/engine.js";
import { applyRisk } from "./risk/manager.js";
import { loadPortfolio, savePortfolio, applyFill } from "./state/portfolio.js";
import { paperExecutor } from "./execution/paper.js";
import { twakExecutor } from "./execution/twak.js";
import { writeTickState, type TickState } from "./state/telemetry.js";
import { publishState } from "./state/publisher.js";
import { ensureFailsafeStop, clearFailsafeStop, stopPriceFor } from "./execution/guardrails.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Order, Portfolio } from "./types.js";

// Vigilancia de gas (auditoría #9): sin BNB fallan swaps, compliance Y
// failsafes a la vez. Chequeo horario en live con alerta ruidosa.
let lastGasCheck = 0;
async function checkGas(): Promise<void> {
  if (Date.now() - lastGasCheck < 3600_000) return;
  lastGasCheck = Date.now();
  try {
    const { stdout } = await promisify(execFile)("twak", ["wallet", "balance", "--chain", "bsc"], {
      shell: process.platform === "win32",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: process.env,
    });
    const m = stdout.match(/Available\s+([\d.]+)/);
    const bnb = m ? parseFloat(m[1]) : NaN;
    if (Number.isFinite(bnb) && bnb < 0.006) {
      console.error(`  🚨🚨 GAS CRÍTICO: ${bnb} BNB — recargar YA o fallarán todos los swaps y failsafes`);
    }
  } catch (err) {
    console.error("  ⚠️ checkGas falló:", (err as Error).message);
  }
}

const executor = config.executionMode === "live" ? twakExecutor : paperExecutor;

export async function tick(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n=== TICK ${ts} [${executor.name}] ===`);

  // El libro primero: las posiciones abiertas definen qué precios extra pedir
  const portfolio = loadPortfolio();
  const ctx = await fetchMarketContext(portfolio.positions.map((p) => p.symbol));
  // Máximos de 48h desde nuestro propio log (breakouts). Se calcula ANTES de
  // registrar el tick actual, así el máximo no incluye el precio de ahora.
  const { readRecentExtremes } = await import("./state/telemetry.js");
  const extremes = readRecentExtremes(48);
  ctx.high48h = extremes.highs;
  ctx.low48h = extremes.lows;
  // PUMP-PROTECTION en vivo (auditoría 11-jun): el veto de rango 24h solo lo
  // poblaban los backtests — ctx.range24hPct quedaba undefined y el airbag
  // validado nunca actuaba fuera de simulación. Mismo log de señales.
  const e24 = readRecentExtremes(24);
  const range24hPct: Record<string, number> = {};
  for (const sym of Object.keys(e24.highs)) {
    const lo = e24.lows[sym];
    if (lo > 0) range24hPct[sym] = (e24.highs[sym] / lo - 1) * 100;
  }
  ctx.range24hPct = range24hPct;
  console.log(`F&G: ${ctx.fearGreedValue} (${ctx.fearGreedLabel}) | ${ctx.signals.length} señales`);

  const decisions = decide(ctx, portfolio);

  for (const d of decisions) {
    const tag = d.action === "HOLD" ? "·" : d.action === "BUY" ? "🟢 BUY " : "🔴 SELL";
    const conf = d.action === "HOLD" ? "" : ` conf=${d.confidence.toFixed(2)}`;
    console.log(`  ${tag} ${d.symbol.padEnd(5)}${conf} :: ${d.reasons[0]}`);
  }

  const { orders, blocked, killSwitchActive } = applyRisk(decisions, portfolio, ctx.signals);
  if (killSwitchActive) console.log("  ⛔ KILL SWITCH activo: no se abren posiciones nuevas hoy");
  for (const b of blocked) console.log(`  ✋ Bloqueado ${b.decision.action} ${b.decision.symbol}: ${b.why}`);

  const executed: TickState["ordersExecuted"] = [];
  for (const order of orders) {
    try {
      const fill = await executor.execute(order);
      applyFill(portfolio, fill);
      // Persistencia INMEDIATA tras cada fill (auditoría #1: un crash entre
      // el swap real y el save duplicaba posiciones al reiniciar)
      savePortfolio(portfolio);
      executed.push({
        side: order.side,
        symbol: order.symbol,
        amountUsd: order.amountUsd,
        priceUsd: order.priceUsd,
        reason: order.reason,
        txHash: fill.txHash,
      });
      console.log(
        `  ✅ ${order.side} ${order.symbol} $${order.amountUsd.toFixed(2)} @ ${order.priceUsd.toFixed(4)} :: ${order.reason}`,
      );
    } catch (err) {
      console.error(`  ❌ Falló ${order.side} ${order.symbol}:`, (err as Error).message);
      await reconcileFailedSell(portfolio, order, (err as Error).message);
    }
  }

  // Failsafe de stops a nivel TWAK (solo live): cada posición lleva una
  // limit order nativa que ejecuta el watcher de TWAK aunque el agente caiga.
  if (config.executionMode === "live") {
    for (const e of executed.filter((x) => x.side === "SELL")) {
      await clearFailsafeStop(e.symbol);
    }
    for (const pos of portfolio.positions) {
      await ensureFailsafeStop(pos.symbol, pos.qty, stopPriceFor(pos.avgEntryUsd, pos.peakUsd, pos.strategy));
    }
  }

  // Regla de la competición: mínimo 1 trade al día. Si a la hora límite no
  // hubo ninguno, se fuerza uno pequeño en el token de compliance.
  if (config.executionMode === "live") {
    try {
      const forced = await ensureDailyCompliance(portfolio, ctx, killSwitchActive);
      if (forced) executed.push(forced);
    } catch (err) {
      console.error("  ❌ Compliance trade falló:", (err as Error).message);
    }
    await checkGas();
  }

  savePortfolio(portfolio);
  const { refreshIntel } = await import("./signals/intel.js");
  const intel = await refreshIntel();
  writeTickState(ctx, decisions, { orders, blocked, killSwitchActive }, executed, portfolio, executor.name, intel);
  await publishState();

  const posValue = portfolio.positions.reduce((sum, p) => {
    const sig = ctx.signals.find((s) => s.symbol === p.symbol);
    return sum + p.qty * (sig?.priceUsd ?? p.avgEntryUsd);
  }, 0);
  console.log(
    `  💼 Cash: $${portfolio.cashUsd.toFixed(2)} | Posiciones: $${posValue.toFixed(2)} (${portfolio.positions.length}) | PnL realizado: $${portfolio.realizedPnlUsd.toFixed(2)} | PnL hoy: $${portfolio.dailyPnlUsd.toFixed(2)}`,
  );
}

// Reconciliación de ventas fallidas en live (auditoría #4): si un SELL real
// falla por balance insuficiente, lo más probable es que el failsafe de TWAK
// ya vendiera (agente caído en ese momento). Cerrar la posición en el libro
// con un fill sintético al precio del stop evita el bucle infinito de
// reintentos y la posición fantasma.
async function reconcileFailedSell(portfolio: Portfolio, order: Order, errMsg: string): Promise<void> {
  if (config.executionMode !== "live" || order.side !== "SELL") return;
  if (!/insufficient|balance|exceeds/i.test(errMsg)) return;
  const pos = portfolio.positions.find((p) => p.symbol === order.symbol);
  if (!pos) return;
  console.error(`  🔄 RECONCILIACIÓN: cierre sintético de ${order.symbol} (probable venta previa del failsafe TWAK)`);
  applyFill(portfolio, {
    order: { ...order, reason: `RECONCILED: ${order.reason} (failsafe TWAK vendió primero)` },
    executedAt: new Date().toISOString(),
    fee: 0,
  });
  savePortfolio(portfolio);
  await clearFailsafeStop(order.symbol);
}

// Vigilancia rápida entre ticks: solo stop-loss/take-profit de posiciones
// abiertas (1 llamada de quotes, sin F&G ni estrategia). Reduce el tiempo de
// reacción ante caídas bruscas — y el drawdown es tiempo de reacción.
export async function fastCheck(): Promise<void> {
  const portfolio = loadPortfolio();
  if (portfolio.positions.length === 0) return;

  const { fetchQuotes } = await import("./signals/cmc.js");
  const signals = await fetchQuotes(portfolio.positions.map((p) => p.symbol));
  const { orders } = applyRisk([], portfolio, signals);

  // Los picos (peakUsd) mutan en applyRisk aunque no haya órdenes: persistir
  // SIEMPRE (auditoría M2: el trailing se calculaba sobre picos de hace 5 min)
  if (orders.length === 0) {
    savePortfolio(portfolio);
    if (config.executionMode === "live") {
      for (const pos of portfolio.positions) {
        await ensureFailsafeStop(pos.symbol, pos.qty, stopPriceFor(pos.avgEntryUsd, pos.peakUsd, pos.strategy));
      }
    }
    return;
  }

  for (const order of orders) {
    try {
      const fill = await executor.execute(order);
      applyFill(portfolio, fill);
      savePortfolio(portfolio);
      // Limpiar la automation failsafe tras vender (auditoría #4: las ventas
      // del fastCheck dejaban automations huérfanas que podían disparar sobre
      // posiciones futuras)
      if (config.executionMode === "live" && order.side === "SELL") {
        await clearFailsafeStop(order.symbol);
      }
      console.log(
        `  ⚡ FAST ${order.side} ${order.symbol} $${order.amountUsd.toFixed(2)} :: ${order.reason}`,
      );
    } catch (err) {
      console.error(`  ❌ FAST falló ${order.side} ${order.symbol}:`, (err as Error).message);
      await reconcileFailedSell(portfolio, order, (err as Error).message);
    }
  }
  savePortfolio(portfolio);
  await publishState();
}

// Garantiza el mínimo de 1 trade/día que exige la competición. Blindado tras
// auditoría #3: registro de intentos PERSISTIDO ANTES de ejecutar (un swap
// real con fallo de registro reintentaba cada 5 min = drenaje de cash), tope
// de 3 intentos/día con 30 min de separación, y alerta si el día peligra.
const COMPLIANCE_FILE = join(process.cwd(), "data", "compliance-attempts.json");

async function ensureDailyCompliance(
  portfolio: ReturnType<typeof loadPortfolio>,
  ctx: Awaited<ReturnType<typeof fetchMarketContext>>,
  killSwitchActive: boolean,
): Promise<TickState["ordersExecuted"][number] | null> {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const tradedToday = portfolio.history.some((f) => f.executedAt.slice(0, 10) === todayUtc);
  if (tradedToday || new Date().getUTCHours() < config.complianceHourUtc) return null;

  // Registro de intentos del día
  let attempts = { date: todayUtc, count: 0, lastAt: 0 };
  try {
    if (existsSync(COMPLIANCE_FILE)) {
      const a = JSON.parse(readFileSync(COMPLIANCE_FILE, "utf-8"));
      if (a.date === todayUtc) attempts = a;
    }
  } catch {
    /* archivo corrupto: empezar de cero */
  }
  if (attempts.count >= 3) {
    console.error("  🚨 COMPLIANCE: 3 intentos fallidos hoy — REVISAR MANUALMENTE (riesgo de día sin trade)");
    return null;
  }
  if (Date.now() - attempts.lastAt < 30 * 60_000) return null; // separación entre intentos

  const sig = ctx.signals.find((s) => s.symbol === config.complianceSymbol);
  if (!sig) {
    console.error("  🚨 COMPLIANCE: sin precio del token de compliance — se reintentará");
    return null;
  }

  // Con kill switch activo no se abre riesgo nuevo: preferir cierre
  let order: Order;
  const smallest = [...portfolio.positions].sort((a, b) => a.qty * a.avgEntryUsd - b.qty * b.avgEntryUsd)[0];
  if ((killSwitchActive || portfolio.cashUsd < config.complianceTradeUsd) && smallest) {
    const price = ctx.signals.find((s) => s.symbol === smallest.symbol)?.priceUsd ?? smallest.avgEntryUsd;
    order = {
      symbol: smallest.symbol,
      side: "SELL",
      amountUsd: smallest.qty * price,
      priceUsd: price,
      qty: smallest.qty,
      reason: "COMPLIANCE: mínimo 1 trade/día (cierre — sin cash o kill switch)",
    };
  } else if (portfolio.cashUsd >= config.complianceTradeUsd && !killSwitchActive) {
    order = {
      symbol: config.complianceSymbol,
      side: "BUY",
      amountUsd: config.complianceTradeUsd,
      priceUsd: sig.priceUsd,
      reason: "COMPLIANCE: mínimo 1 trade/día de la competición",
    };
  } else {
    console.error("  🚨 COMPLIANCE: sin cash ni posiciones — imposible cumplir hoy");
    return null;
  }

  // Persistir el intento ANTES del swap: si el registro del fill falla, el
  // siguiente tick NO repite a ciegas
  attempts.count++;
  attempts.lastAt = Date.now();
  writeFileSync(COMPLIANCE_FILE, JSON.stringify(attempts));

  const fill = await executor.execute(order);
  applyFill(portfolio, fill);
  savePortfolio(portfolio);
  // La posición de compliance también lleva paracaídas desde el minuto 1
  if (config.executionMode === "live" && order.side === "BUY") {
    const pos = portfolio.positions.find((p) => p.symbol === order.symbol);
    if (pos) await ensureFailsafeStop(pos.symbol, pos.qty, stopPriceFor(pos.avgEntryUsd, pos.peakUsd, pos.strategy));
  }
  // Y el cierre de compliance retira el paracaídas (auditoría 11-jun: sin
  // esto quedaba una automation huérfana que vendería al instante una
  // posición futura del mismo token)
  if (config.executionMode === "live" && order.side === "SELL") {
    await clearFailsafeStop(order.symbol);
  }
  console.log(`  📋 COMPLIANCE ${order.side} ${order.symbol} $${order.amountUsd.toFixed(2)}`);
  return {
    side: order.side,
    symbol: order.symbol,
    amountUsd: order.amountUsd,
    priceUsd: order.priceUsd,
    reason: order.reason,
    txHash: fill.txHash,
  };
}

export async function runLoop(): Promise<void> {
  console.log(
    `Triton arrancando: modo=${config.executionMode}, tick=${config.tickIntervalSeconds}s, fast-check=${config.fastCheckSeconds}s, watchlist=${Object.keys(config.watchlist).join(",")}`,
  );
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("Tick falló (se reintenta en el próximo intervalo):", (err as Error).message);
    }
    // Entre ticks completos: fast-checks de stops
    const rounds = Math.max(1, Math.floor(config.tickIntervalSeconds / config.fastCheckSeconds));
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, config.fastCheckSeconds * 1000));
      try {
        await fastCheck();
      } catch (err) {
        console.error("Fast-check falló:", (err as Error).message);
      }
    }
  }
}
