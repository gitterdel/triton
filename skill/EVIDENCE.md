# Evidence Dossier — why every rule earned its place

The organizers said it plainly: *"the better the explanation (so backed by data), the best chance you have to win."* This strategy was not designed — it was **selected by data** through **25+ explicit, pre-registered hypothesis tests**, then **repriced against measured reality** (real execution costs, the contest's own rules). This file is the lab notebook. Every number is reproducible with the commands in STRATEGY_SPEC §8.

## 1. Headline results — under FULL contest conditions

Unlike standard backtests, these include the two costs most backtests ignore: the **measured** execution friction (0.8%/side — see §2) and the **contest's 1-trade/day rule** (simulated; it alone costs ~0.6-1pp/week).

**Current regime (90 days, bear/lateral, hourly data):**

| Metric | Triton | Equal-weight buy & hold |
|---|---|---|
| Return | **-9.6%** | -15.2% (**+5.6 alpha**) |
| Max drawdown | **-14.1%** | >20% |
| Rolling 7-day windows (n=83) | median -1.1% · best **+6.1%** · worst -6.4% | — |

**Stress horizon (365 days incl. a -55.8% bear year):**

| Metric | Triton | Buy & hold |
|---|---|---|
| Return | -45.8% | -55.8% (**+10 alpha**) |
| Rolling 7-day windows (n=358) | median -1.8% · best **+20.5%** | — |

The 7-day distribution is the competition statistic: best weeks are post-capitulation rebounds — the likeliest regime for a live week starting from extreme fear (F&G 12-18 as of mid-June). In red weeks the median preserves capital while long-biased competitors bleed; the drawdown stays far from the 30% disqualification gate.

**Bull-market capability** (the structural weakness of defensive momentum) is covered by the BULL module — walk-forward validated: tuned on the 2021-23 epoch, **+20.5% on the untouched 2023-26 epoch** vs -35.2% without it (at the pre-discovery cost model; see §2 for why all absolute numbers must carry their cost model).

## 2. The cost discovery — measuring what everyone else assumes

Mid-build, a real-money execution rehearsal measured **1.35% round-trip** where the simulator assumed 0.5%. We stopped everything and mapped the territory:

- **Per-token friction quoted on the venue** ($20 round trip, June 12): ETH 1.40 · DOGE 1.41 · CAKE 1.43 · XRP 1.44 · TWT 1.52 · LINK 1.68 · LTC 1.72 · ADA 1.79 · ATOM 1.84 · AVAX 1.85 · FET 1.95 — **basket mean ~1.6%**. Bench candidates: ASTER 1.40 · ZEC 1.44 · SAHARA 1.49 · TON 1.91 · **PENDLE 3.19** (disqualified by friction alone). Reproducible: `npx tsx scripts/quote-friction.ts`.
- **Friction is structural, not size**: reported price impact is 0 at $10-$100; the curve is flat-to-slightly-worse with size. It is the aggregator route's spread+LP floor (~1.4% RT minimum across 16 tokens of very different profiles).
- **Repricing changed the conclusions**: the flagship config went from **+18.6% to -35.3%** (1000 days) when fantasy fees became real. A tournament-tuned aggressive variant went from "best weekly tail" to **drawdown-disqualification territory** — and was retired. *No signal at hourly frequency survives a 1.6% toll; only multi-day trend-following clears it.*
- **The contest's own rules are a cost**: simulating the 1-trade/day rule revealed the naive daily gesture costs **-8.1pp per 90 days** — and an A/B of gesture policies (validated 4/4 epochs) recovered most of it (§4, "compliance policy").
- An hourly friction collector now maps cost-by-time-of-day on the venue, and live CMC-vs-venue price lag was measured at ~5 min (spec §2 caveat).

## 3. Architecture selected across epochs (not windows)

Single-window backtests lie. Every structural choice was tested on four epochs: 90d (current), 365d (bear year), 2023-26 (mixed, 1000d) and 2021-23 (alt winter, walk-forward offset).

- **Exposure dial**: 4 slots×15% beats 6×15 on floor and drawdown in **4/4 epochs** (e.g. 365d: -16.2% vs -26.0%); 6×15 keeps a fatter right tail (best weeks 16.9% vs 13.1%). Both validated; 6×15 raced because the prize structure pays the top-5 finishers and the tail decides green weeks. The dial is monotonic (3/4/5/6 neighbors scale coherently) — structure, not noise.
- **Basket survival**: the same engine restricted to cheap majors (ETH/DOGE/CAKE/XRP) beats the full basket in **4/4 epochs** — 2021-23: **-7.7% vs -54.8%**. ETH-only is the only *positive* corner of the whole space at real costs (+6.3% on 2021-23 with B&H at -46%) — at the price of having no tail at all. The full basket races for the tail; a live A/B (champion vs majors-basket challenger) is arbitrating with real market data before the window.
- **BULL module**: concept validated on 2000d (transforms -66% into positive territory); parameters chosen by walk-forward (12 variants tuned on epoch A, top-2 validated on untouched epoch B), not by best-backtest.

## 4. The falsification log (what the data REJECTED)

A strategy is only as credible as the ideas it killed. All portfolio-level, same engine, stopping rules applied — dead families stay dead:

| Hypothesis | Verdict | Why |
|---|---|---|
| Contrarian buy-the-fear (buyTh 1.0 in fear) | **Inverted** | -12.8% vs -4.8%; extremes demand MORE signal |
| Lower entry thresholds (fear 3 / neutral 1.5) | Rejected | marginal entries are the bleed; raced values +3-8pp at real costs |
| Time-exits, full sweep {4…48h} | Rejected | harmful at every value, both horizons; churn triples fees |
| Cooldown 48h/72h | Rejected | epoch-inconsistent (wins one epoch, loses the next) — noise |
| Tighter chase veto (1h ≤ 1.5) | Rejected | isolated cliff, no plateau |
| 8 slots × 12.5% | Rejected | artifact: sizing collided with the min-trade floor |
| Adaptive thresholds (H8, vol-scaled) | Rejected | walk-forward exposed curve-fit: won tuning epoch, -21pp on virgin epoch |
| ATR-style adaptive exits (H9) | Rejected | same protocol, same failure |
| Biggest-loser-24h rotation | Rejected | the deep-dip bounce EXISTS gross (+0.87%/trade at -8% dips) but is smaller than the toll |
| Capitulation + confirmed-turn reversal | Rejected | 2021-23: every confirmed bounce preceded the next leg down (-2.9 to -4.1%/trade) |
| Lead-lag (BTC pumps → buy the laggard alt) | Rejected | +2.8%/trade in 2023-26 flips to -5.2% in 2021-23 — laggards lag for a reason |
| Weekly cross-sectional momentum | Rejected | +1.5%/week in recent epoch, negative on 2021-23 |
| Donchian breakout + F&G gate | **Rejected after passing the signal screen** | per-trade stats promised +2.6-3.2%/trade; the portfolio test killed it both as add-on (cannibalizes BULL, blocks slots) and as replacement (-18pp vs the strength trigger). *Lesson: signal screens don't see capital competition.* |
| F&G velocity gate (sentiment rising fast) | Rejected | bear rallies lift F&G +10-15 and the wide-stop module pays for it |
| Regime-adaptive quota | Rejected | doesn't bind — fear thresholds already block those entries |
| Trailing ratchet (loosen leash after +10%) | Rejected | neutral everywhere; Occam |
| Skip-weekend entries | Rejected | +9.3pp on one epoch, negative on two others — unstable |
| Basket-drawdown circuit breaker | Rejected | optimal threshold flips between epochs (V-rebounds vs cascades) — unknowable ex-ante |
| Ungated RANGE / ungated BREAKOUT | Adopted only gated | regime gates proven on data |
| BTC/ETH leader gate · weekly-resistance veto | Rejected | covered by token-level confirmation / V-recoveries punch through |
| High-beta trending tier (ASTER/ZEC/SAHARA) | Benched, gated | doubles drawdown in fear; re-entry conditions defined (and they are friction-cheap: 1.40-1.49%) |
| E0V1E-style dip module (RSI oversold) | Rejected | +1-3% bounce harvesting dies under DEX round-trip frictions |
| Naive daily-trade gesture (fixed token) | **Replaced** | -8.1pp/90d: repeated buys merged positions and silently moved stops; best-momentum-not-held policy validated 4/4 epochs (+7.8 to +15.5pp) |
| Volatility sizing · volume-led early entry | Adopted | both improve the raced combo at real costs (vol-sizing scales size down in violent tokens) |

## 5. Validation protocol (how a rule earns adoption)

1. **Pre-registered criteria** — success/failure thresholds written down *before* looking at results.
2. **Portfolio test with the production engine** — never per-trade signal screens alone (the Donchian entry passed the screen and died in the portfolio; capital competition is invisible per-trade).
3. **Multi-epoch consistency** — 90d/365d/1000d/2021-23; a win that doesn't replicate across epochs is noise (cooldown, breaker, weekend all died here).
4. **Plateau test** — neighbors of every adopted parameter must behave coherently; isolated peaks are curve-fit (MAX_1H 1.5 died here).
5. **Walk-forward** — tune on epoch A, validate on untouched epoch B (BULL passed; H8/H9 failed).
6. **Live A/B** — champion vs challenger on a 24/7 VPS against real market data, real measured fees, before anything races.
7. **Stopping rules** — rejected families are not reopened with new parameters (documented in-code next to each dead knob).

## 6. Rules born from live operation (human-in-the-loop)

- **Overextension veto** (`pct1h ≤ 2.5`): the operator watched the agent buy the top of a vertical candle; formalized, +1.46pp.
- **Support-anchored RANGE entries**: +0.43pp, six bad entries skipped.
- **Anti-spike double-reading**: a ghost API print inside the old +25% tolerance could arm the trailing on a phantom peak and strangle a BULL position — found by audit, fixed, regression-verified.
- **The cost repricing itself** was operator-driven: "if real fees are higher, we update everything" → the single highest-value decision of the project (§2).
- **Compliance policy**: the operator asked "since we're forced to trade daily, why not try something?" — the A/B proved him right (+7.8 to +15.5pp over the naive gesture) and refuted the analyst's prior. Documented as-is.

## 7. Live proof (same engine, running now)

- **Public dashboard**: https://triton-dashboard.vercel.app — equity curve, live decision table with full reasoning, every fill, and a **prop-firm Track Record panel** (Sharpe/Sortino/Calmar/exposure/expectancy, computed from the real equity curve; ratios show "—" until the sample is statistically honest).
- **A/B challenger** (majors-basket variant, one variable apart): https://triton-retador.vercel.app
- **On-chain wallet** (BSC): `0x111Be0cD38B05B56253b4b7B5F3F39f6a64cEfc7` — the real-money rehearsal transactions are visible on BscScan; that rehearsal caught two critical execution bugs (venue automations reverting on balance dust; a field-name mismatch leaving orphan stop orders) for ~$0.70 of tuition.
- 24/7 on a VPS under systemd with atomic state persistence, failsafe venue-native stops per position, and an external health endpoint.

## 8. CMC data surfaces used

quotes/latest (signals) · fear-and-greed latest+historical (regime) · trending/latest (attention overlay) · quotes/historical (backtests) · listings/latest (universe screener) · MCP narratives/news/macro (context layer) · x402 paid DEX-pair depth (payment layer verified end-to-end; endpoint pending CMC-side fix).
