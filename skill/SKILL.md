# TRITON Strategy Skill — Regime-Gated Spot Ensemble

> **BNB HACK 2026 · Track 2 (Strategy Skills)** · Powered by CoinMarketCap Agent Hub
> An LLM Skill that turns live CMC market data into risk-gated spot trading decisions, following a fully specified, backtestable strategy.

```yaml
name: triton-strategy
description: Generate risk-gated spot trading decisions (BUY/SELL/HOLD per token) from CoinMarketCap data using the Triton regime-gated ensemble. Use when the user wants systematic long-only spot signals for liquid BSC tokens, a portfolio decision table, or a reproducible backtest of the strategy.
data_sources: [cmc-quotes-latest, cmc-fear-and-greed, cmc-trending, cmc-quotes-historical]
access_paths: [REST, MCP (mcp.coinmarketcap.com)]
```

## What this Skill does

Given a token universe, the Skill produces a **decision table** — one action per token with full reasoning — by applying the Triton ensemble: three entry modules (MOMENTUM, BREAKOUT, RANGE) that only act in the market regime they were validated for, under a hard risk overlay that can veto anything.

The exact rules live in [STRATEGY_SPEC.md](STRATEGY_SPEC.md) (every formula and threshold).
The empirical support lives in [EVIDENCE.md](EVIDENCE.md) (two backtest horizons, sensitivity analysis, falsification log).
The reference implementation is this repo's engine (`src/strategy/engine.ts`, `src/risk/manager.ts`) and harnesses (`npm run backtest`, `scripts/backtest-year.ts`) — the same code that trades live in Track 1.

## Workflow (for an LLM agent executing this Skill)

1. **Fetch market state from CMC** (REST with API key, or MCP keyless tools):
   - `/v2/cryptocurrency/quotes/latest?id=<universe ids>` → price, 1h/24h/7d %, volume 24h, volume change
   - `/v3/fear-and-greed/latest` → regime input
   - `/v1/cryptocurrency/trending/latest` → attention overlay
2. **Compute per-token signals** exactly as specified in STRATEGY_SPEC §2 (momentum score, confirmations, support/resistance memory, pump filter).
3. **Resolve the regime** (STRATEGY_SPEC §3) and evaluate the three modules in order: MOMENTUM → BREAKOUT → RANGE. First module that fires defines the candidate action.
4. **Apply the risk overlay** (STRATEGY_SPEC §4): position caps, confidence floor, cooldowns, kill switch, drawdown guard. The overlay may convert a BUY into a documented BLOCK.
5. **Emit the decision table**: `token | action | confidence | module | full reasoning | blocking reason if vetoed`. Never emit a buy without listing every gate it passed.
6. **(Optional) Backtest mode**: when the user asks "how would this have done", run the replay procedure of STRATEGY_SPEC §6 over `quotes/historical` (CMC, ≤1 month granular) or any OHLCV source (longer horizons), and report: return vs equal-weight buy&hold, max drawdown, win rate, trade count, weekly return distribution.

## Operating principles (bind the agent)

- **Regime gates are vetoes, not predictions.** No module trades outside its validated habitat.
- **Cash is a position.** In a confirmed downtrend the correct output is HOLD everywhere; the Skill's edge in crashes is refusing to trade (measured: +17pp vs the market in a -17% window).
- **Every rejected entry must say why.** The blocked-decisions list is part of the deliverable, not noise.
- **No parameter improvisation.** All thresholds come from STRATEGY_SPEC; if the user wants different ones, re-run the backtest procedure before adopting (see EVIDENCE §4 for the falsification protocol).
