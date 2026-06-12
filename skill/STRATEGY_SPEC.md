# Triton Strategy Specification (backtestable, as raced)

Formal definition of the Triton regime-gated spot ensemble — **the exact configuration racing in Track 1**. Every rule below is implemented in `src/strategy/engine.ts` + `src/risk/manager.ts` and replayed verbatim by the harnesses (`scripts/backtest.ts`, `scripts/backtest-year.ts`) and by the runnable demo (`skill/run-skill.ts`). Long-only, spot-only, BSC via TWAK.

## 0. Contest configuration (pinned)

The engine ships conservative defaults; the contest configuration activates the data-validated values via environment (the same mechanism the harnesses use, so paper, backtest and live are byte-identical):

```
TEST_FEAR_TH=5  TEST_NEUTRAL_TH=2  TEST_EARLY_VOL=1  TEST_VOL_SIZING=1
TEST_BULL_MODE=1  TEST_BULL_FG=45  TEST_BULL_STOP=15  TEST_BULL_7D=10
```

Position sizing (6 slots × 15%) and all risk constants are compiled defaults — in live mode the lab knobs are ignored by design (changing risk limits requires a code change and review).

## 1. Universe

Hard filters over the 149 eligible tokens: operability verified **contract-level on the venue** (CMC symbol→BSC address resolution is manual — fake clones exist), market cap ≥ $100M, 24h volume ≥ $20M, non-stablecoin. From survivors, ~10-12 by structural fitness (trend persistence of 4h returns, median |24h| in the 1.5–6% band, worst-24h > -18%, volume stability) with sector caps. Current list (June 2026): ETH, CAKE, XRP, DOGE, ADA, LINK, AVAX, ATOM, LTC, TWT, FET.

**Selection criteria added after measuring reality (June 12):**
- **Execution friction per token** — measured round-trip cost via venue quotes ranges **1.37% (ETH) to 3.19% (PENDLE)**; 0.5pp per cycle compounds to ~3.4% of equity per quarter. Expensive tokens need extraordinary signal quality to justify inclusion.
- **Basket survival across epochs** — the same engine on a majors-only sub-basket (ETH/DOGE/CAKE/XRP) beat the full basket in all four tested epochs (2021-23 epoch: -7.7% vs -54.8%). Alt "energy" must pay for its structural bleed, and mostly it doesn't. See EVIDENCE §3.

## 2. Per-token signals (each tick; 5 min live, 1h in backtests)

- `m = 0.5·pct1h + 0.35·pct24h + 0.15·pct7d` — multi-timeframe momentum
- volume boost: `m ×1.2` if 24h volume change > +20%; `m ×0.8` if < -20%
- attention boost: `m ×1.2` if token in CMC trending AND `m > 0`
- rolling memory (from own price log): `high48h`, `low48h`, `high168h`, `range24h%`
- market breadth: `marketAvg7d`, `marketAvg24h` = equal-weight means over the universe

**Known live-data caveat (measured, June 12):** CMC aggregate prices lag the venue by ~5 minutes (uniform across the universe, bias -0.10%, p95 deviation 0.4%). Signals tolerate it; protective exits do not — which is why stop execution is doubled by venue-native failsafes (§6).

## 3. Regime resolution (CMC Fear & Greed)

| F&G | buyThreshold | sellThreshold | rationale |
|---|---|---|---|
| ≤ 25 (fear) | **5.0** | -4.0 | only exceptional momentum; never panic-sell into capitulation |
| 26–74 | **2.0** | -2.0 | base case |
| ≥ 75 (greed) | 3.0 | -1.5 | demand more to buy tops, exit faster |

`riskOn := marketAvg7d > -3 AND F&G ≥ 35` — gates BREAKOUT and the optional high-beta tier.

**Falsified alternatives:** the contrarian version (buyThreshold 1.0 in fear) lost -12.8% vs -4.8%; thresholds *below* the raced values (fear 3, neutral 1.5) lost 3-8pp per window once real costs were applied — marginal entries are where this system bleeds. See EVIDENCE §4.

## 4. Entry modules (evaluated in order; first hit wins)

**BULL** (trend-following; the only module that survives bull markets) — BUY when ALL hold:
`F&G ≥ 45` · `marketAvg7d > 0` · `pct7d ≥ +10` · `pct24h > 0` · overextension and pump vetoes pass. Wide exits (§6) — entries by sustained trend, exits by long leash. Walk-forward validated: tuned on 2021-23, **+20.5% on the untouched 2023-26 epoch** (baseline without it: -35.2%).

**MOMENTUM** — BUY when ALL hold:
`m ≥ buyThreshold` · confirmation (`pct24h > 0` AND `volumeChange24h > 0` AND `pct7d > -15`) **or early-volume entry** (`volumeChange24h > +50` AND `pct1h > +1.5` AND `pct7d > -15`) · `pct1h ≤ 2.5` (no chasing vertical candles) · `range24h% ≤ 35` (pump protection) · confidence `min(0.95, 0.5+(m−buyThreshold)/10) ≥ 0.60`.

**BREAKOUT** (dormant outside risk-on) — BUY when: `price > high48h·1.005` · `volumeChange24h > 25` · `pct1h > 0.3` · `pct7d > -10` · `riskOn`.

**RANGE** (sideways only, half size) — BUY when: token sideways (`|pct7d| ≤ 5`, `|pct24h| ≤ 2.5`) · dip turning (`pct24h ≤ -1.2`, `pct1h ≥ +0.2`) · within 2% of `low48h` · market sideways · F&G ≥ 40.

**SELL signal**: `m ≤ sellThreshold` on a held token — except BULL positions, which only the risk manager may close (momentum noise must not shake out a trend).

## 5. Risk overlay (hard, code-level)

Max **6 open positions × 15% of equity** (grid-searched: small size beats big quota; 6×15 kept over 4×15 for the contest's right-tail — both validated, see EVIDENCE §3) · volatility sizing: position scaled by `clamp(4/|pct24h|, 0.4, 1)` · trade size $10–200 · 24h cooldown per token after a losing exit · daily realized-loss cap -8% → kill switch until next UTC day · total-drawdown guard: equity < 80% of persisted high-water mark → liquidate all, reset mark · DEX price-impact abort > 1.5%.

## 6. Exits (checked every 60s live)

| Rule | Trigger |
|---|---|
| Stop-loss (momentum/breakout) | -5% from entry |
| Trailing (momentum/breakout) | arms at +3% peak gain; exits -4% from peak |
| **BULL stop / trailing** | **-15% from entry / arms +5%, exits -12% from peak** |
| RANGE exits | fixed ±3%, no trailing |
| Regime sell | `m ≤ sellThreshold` (non-BULL only) |
| Anti-spike peak guard | a peak jump >5% needs **two consecutive readings** (a ghost API print must not arm the trailing; sustained real moves confirm next tick) |
| Failsafe layer | venue-native limit order **2% below the agent stop**, per position, including the BULL profile — fires even if the agent is dead. Validated with real money (the rehearsal caught two critical execution bugs before race week) |

## 7. Contest operations layer

- **Daily-trade rule**: if no trade by 18:00 UTC, the agent executes a $12 gesture. Policy (A/B validated in 4/4 epochs, +7.8 to +15.5pp vs the naive fixed-token gesture): **buy the best-momentum token NOT currently held** — never merges into an existing position (merging recalculated cost basis and silently moved stops), trades with strength, and the position inherits full risk management. Fallback: close the smallest position when cash-constrained or kill-switched.
- **Cost model**: simulated fee **0.8% per side** — the *measured* basket average (venue quotes, June 12: ~1.6% round trip; real-money rehearsal: 1.35%). Paper and backtests pay what the race pays.

## 8. Backtest procedure (reproducibility)

1. Hourly closes + volumes for the universe (+169h warm-up), series **aligned by timestamp** (index alignment desynchronized long suites by up to 69 days — found, fixed, verified).
2. Recompute §2 signals each hour; daily F&G from the historical series (cached on disk, coverage reported — silent fallbacks masked data gaps).
3. Run §3-§7 through the production engine, fills at close, fee 0.8%/side, **daily-trade rule simulated** (`TEST_COMPLIANCE=best` — the rule costs ~0.6-1pp per week and not modeling it flattered every historical backtest).
4. Report: total return, equal-weight B&H, alpha, max drawdown, trades/WR, and the **rolling 7-day return distribution** (the competition statistic).
5. Walk-forward: `TEST_WINDOW_OFFSET_DAYS` shifts the window to tune on one epoch and validate on an untouched one — the protocol every adopted rule passed (EVIDENCE §5).

Commands: `npx tsx scripts/backtest-year.ts 90` · full contest conditions: prepend the §0 knobs + `TEST_COMPLIANCE=best` · live decision table: `npx tsx skill/run-skill.ts`.
