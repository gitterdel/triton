# TRITON Strategy Skill — Regime-Gated Spot Ensemble

> **BNB HACK 2026 · Track 2 (Strategy Skills)** · Powered by CoinMarketCap Agent Hub
> An LLM Skill that turns live CMC market data into risk-gated spot trading decisions, following a fully specified, backtestable strategy — **the same one trading live in Track 1 right now**.

```yaml
name: triton-strategy
description: Generate risk-gated spot trading decisions (BUY/SELL/HOLD per token) from CoinMarketCap data using the Triton regime-gated ensemble. Use when the user wants systematic long-only spot signals for liquid BSC tokens, a portfolio decision table, or a reproducible backtest of the strategy under full real-world conditions (measured execution costs included).
data_sources: [cmc-quotes-latest, cmc-fear-and-greed, cmc-trending, cmc-quotes-historical]
access_paths: [REST, MCP (mcp.coinmarketcap.com)]
demo: npx tsx skill/run-skill.ts   # 30 seconds, keyless fallback included
```

## Try it in 30 seconds

```bash
npx tsx skill/run-skill.ts            # uses CMC if CMC_API_KEY is set; public-data fallback otherwise
```

Emits the timestamped decision table (action · confidence · module · full reasoning per token), the blocked-decisions list, and the executable orders — produced by the **production engine**, pinned to the contest configuration. Watch the identical engine trade live: **https://triton-dashboard.vercel.app** (equity, decisions, fills, and a prop-firm track-record panel) and its A/B challenger **https://triton-retador.vercel.app**.

## What this Skill does

Given a token universe, the Skill produces a **decision table** — one action per token with full reasoning — by applying the Triton ensemble: a trend module (BULL) plus three tactical modules (MOMENTUM, BREAKOUT, RANGE) that only act in the market regime they were validated for, under a hard risk overlay that can veto anything.

The exact rules live in [STRATEGY_SPEC.md](STRATEGY_SPEC.md) (every formula and threshold, as raced).
The empirical support lives in [EVIDENCE.md](EVIDENCE.md): headline results under **full contest conditions** (measured fees + the daily-trade rule), the execution-cost cartography, a falsification log of **25+ rejected hypotheses**, and the 7-step validation protocol every adopted rule passed.
The reference implementation is this repo's engine (`src/strategy/engine.ts`, `src/risk/manager.ts`) — the same code trading live in Track 1.

## Workflow (for an LLM agent executing this Skill)

1. **Fetch market state from CMC** (REST with API key, or MCP keyless tools):
   - `/v2/cryptocurrency/quotes/latest?id=<universe ids>` → price, 1h/24h/7d %, volume
   - `/v3/fear-and-greed/latest` → regime input
   - `/v1/cryptocurrency/trending/latest` → attention overlay
2. **Compute per-token signals** exactly as STRATEGY_SPEC §2 (momentum score, confirmations, rolling extremes, pump filter).
3. **Resolve the regime** (SPEC §3) and evaluate the modules in order: BULL → MOMENTUM → BREAKOUT → RANGE. First module that fires defines the candidate action.
4. **Apply the risk overlay** (SPEC §5): position caps, volatility sizing, confidence floor, cooldowns, kill switch, drawdown guard. The overlay may convert a BUY into a documented BLOCK.
5. **Emit the decision table**: `token | action | confidence | module | reasoning | blocking reason if vetoed`. Never emit a buy without listing every gate it passed.
6. **(Optional) Backtest mode**: replay per SPEC §8 — including the **measured cost model** (0.8%/side) and the **contest's daily-trade rule** — and report return vs B&H, max drawdown, win rate, and the weekly return distribution.

## Operating principles (bind the agent)

- **The toll governs.** Measured venue friction is ~1.6% per round trip; no hourly-frequency signal survives it. Trade less, trade cheap tokens, hold trends for days. Every absolute number must state its cost model.
- **Regime gates are vetoes, not predictions.** No module trades outside its validated habitat.
- **Cash is a position.** In a confirmed downtrend the correct output is HOLD everywhere; the Skill's edge in crashes is refusing to trade.
- **Every rejected entry must say why.** The blocked-decisions list is part of the deliverable.
- **No parameter improvisation.** All thresholds come from STRATEGY_SPEC; changes must pass the EVIDENCE §5 protocol (pre-registration, portfolio test, multi-epoch, plateau, walk-forward) before adoption.
