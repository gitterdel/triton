# Triton Strategy Specification (backtestable)

Formal definition of the Triton regime-gated spot ensemble. Every rule below is implemented verbatim in `src/strategy/engine.ts` + `src/risk/manager.ts` and replayed by `scripts/backtest.ts` (hourly CMC data) and `scripts/backtest-year.ts` (hourly Binance data + alternative.me F&G). Long-only, spot-only.

## 1. Universe

Hard filters over the eligible token list: operability verified on the execution venue (contract-level), market cap ≥ $100M real, 24h volume ≥ $20M, non-stablecoin. From survivors, select ~10-12 by structural fitness (trend persistence of 4h returns, median |24h| move in the 1.5–6% band, worst-24h crash > -18%, volume stability p10/median) with sector diversity caps. Re-run selection only between competition windows, never mid-window. Current list (June 2026): ETH, CAKE, XRP, DOGE, ADA, LINK, AVAX, ATOM, LTC, TWT, FET.

## 2. Per-token signals (computed each tick; tick = 5 min live, 1h in backtests)

- `m = 0.5·pct1h + 0.35·pct24h + 0.15·pct7d` — multi-timeframe momentum
- volume boost: `m ×1.2` if volume24h change > +20%; `m ×0.8` if < -20%
- attention boost: `m ×1.2` if token is in CMC trending AND `m > 0`
- rolling memory (from own price log): `high48h`, `low48h`, `high168h`, `range24h% = (high24/low24 − 1)·100`
- market breadth: `marketAvg7d`, `marketAvg24h` = equal-weight means over the universe

## 3. Regime resolution (from CMC Fear & Greed)

| F&G | buyThreshold | sellThreshold | rationale |
|---|---|---|---|
| ≤ 25 (fear) | 3.0 | -4.0 | only strong, confirmed momentum; never panic-sell into capitulation |
| 26–74 | 1.5 | -2.0 | base case |
| ≥ 75 (greed) | 3.0 | -1.5 | demand more to buy tops, exit faster |

`riskOn := marketAvg7d > -3 AND F&G ≥ 35` — gates BREAKOUT and the optional high-beta tier.
**Design note (falsified alternative):** the original contrarian version (buyThreshold 1.0 in fear) lost -12.8% in the test window; data inverted the hypothesis. See EVIDENCE §4.

## 4. Entry modules (evaluated in order; first hit wins) and risk overlay

**MOMENTUM** — BUY when ALL hold:
`m ≥ buyThreshold` · `pct24h > 0` · `volumeChange24h > 0` · `pct7d > -15` (no falling knives) · `pct1h ≤ 2.5` (overextension veto — do not chase vertical hourly candles) · `range24h% ≤ 35` (pump protection) · confidence `min(0.95, 0.5+(m−buyThreshold)/10) ≥ 0.60`.

**BREAKOUT** (dormant outside risk-on) — BUY when: `price > high48h·1.005` · `volumeChange24h > 25` · `pct1h > 0.3` · `pct7d > -10` · `riskOn`. Exits as MOMENTUM.

**RANGE** (sideways only, half size) — BUY when: token sideways (`|pct7d| ≤ 5` and `|pct24h| ≤ 2.5`) · dip turning (`pct24h ≤ -1.2`, `pct1h ≥ +0.2`) · **within 2% of `low48h`** (buy at the floor, not mid-fall) · market sideways (`marketAvg7d > -3`, F&G ≥ 40).

**SELL signal**: `m ≤ sellThreshold` on a held token.

**Risk overlay (hard, code-level):** max 4 open positions · max 20% of equity per position · trade size $10–200 · 24h cooldown per token after any losing exit (compliance exits excluded) · daily realized-loss cap -8% → kill switch (no buys until next UTC day; closes always allowed) · total-drawdown guard: equity < 80% of persisted high-water mark → liquidate all, reset mark · execution-level allowlist + abort if DEX price impact > 1.5%.

## 5. Exits (checked every 60s live)

| Rule | Trigger |
|---|---|
| Stop-loss | -5% from entry (cost basis includes entry fee) |
| Trailing stop | arms at +3% peak gain; exits at -4% from peak (peak has a +25%/tick spike guard) |
| RANGE exits | fixed ±3% target/stop, no trailing |
| Regime sell | momentum ≤ sellThreshold |
| Failsafe layer | venue-native limit order 2% BELOW the agent stop (fires only if the agent is dead) |

## 6. Backtest procedure (reproducibility)

1. Hourly closes + volumes for the universe over the window (+169h warm-up for 7d momentum).
2. Recompute §2 signals each hour from the raw series (1h/24h/7d deltas, rolling extremes, 24h volume sums).
3. Daily F&G from the historical series (CMC `/v3/fear-and-greed/historical` or alternative.me).
4. Run §3-§5 verbatim through the production engine; fills at close with 0.25%/side fee (DEX-like).
5. Report: total return, equal-weight buy&hold benchmark, alpha, max drawdown, trades/win rate, and **rolling 7-day return distribution** (the competition-relevant statistic).

Commands: `npm run backtest -- 21` (CMC data) · `npx tsx scripts/backtest-year.ts 365` (Binance data).
