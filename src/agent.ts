import { config } from "./config.js";
import { fetchMarketContext } from "./signals/cmc.js";
import { decide } from "./strategy/engine.js";
import { applyRisk } from "./risk/manager.js";
import { loadPortfolio, savePortfolio, applyFill } from "./state/portfolio.js";
import { paperExecutor } from "./execution/paper.js";
import { twakExecutor } from "./execution/twak.js";
import { writeTickState, type TickState } from "./state/telemetry.js";
import { publishState } from "./state/publisher.js";

const executor = config.executionMode === "live" ? twakExecutor : paperExecutor;

export async function tick(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n=== TICK ${ts} [${executor.name}] ===`);

  const ctx = await fetchMarketContext();
  console.log(`F&G: ${ctx.fearGreedValue} (${ctx.fearGreedLabel}) | ${ctx.signals.length} señales`);

  const portfolio = loadPortfolio();
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
    }
  }

  savePortfolio(portfolio);
  writeTickState(ctx, decisions, { orders, blocked, killSwitchActive }, executed, portfolio, executor.name);
  await publishState();

  const posValue = portfolio.positions.reduce((sum, p) => {
    const sig = ctx.signals.find((s) => s.symbol === p.symbol);
    return sum + p.qty * (sig?.priceUsd ?? p.avgEntryUsd);
  }, 0);
  console.log(
    `  💼 Cash: $${portfolio.cashUsd.toFixed(2)} | Posiciones: $${posValue.toFixed(2)} (${portfolio.positions.length}) | PnL realizado: $${portfolio.realizedPnlUsd.toFixed(2)} | PnL hoy: $${portfolio.dailyPnlUsd.toFixed(2)}`,
  );
}

// Vigilancia rápida entre ticks: solo stop-loss/take-profit de posiciones
// abiertas (1 llamada de quotes, sin F&G ni estrategia). Reduce el tiempo de
// reacción ante caídas bruscas — y el drawdown es tiempo de reacción.
export async function fastCheck(): Promise<void> {
  const portfolio = loadPortfolio();
  if (portfolio.positions.length === 0) return;

  const { fetchQuotes } = await import("./signals/cmc.js");
  const signals = await fetchQuotes();
  const { orders } = applyRisk([], portfolio, signals);
  if (orders.length === 0) return;

  for (const order of orders) {
    try {
      const fill = await executor.execute(order);
      applyFill(portfolio, fill);
      console.log(
        `  ⚡ FAST ${order.side} ${order.symbol} $${order.amountUsd.toFixed(2)} :: ${order.reason}`,
      );
    } catch (err) {
      console.error(`  ❌ FAST falló ${order.side} ${order.symbol}:`, (err as Error).message);
    }
  }
  savePortfolio(portfolio);
  await publishState();
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
