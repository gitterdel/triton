# Evidence Dossier — why every rule earned its place

The organizers said it plainly: *"the better the explanation (so backed by data), the best chance you have to win."* This strategy was not designed — it was **selected by data** through ~12 explicit hypothesis tests. This file is the lab notebook.

## 1. Headline results

**Contest-like window (21 days, full crash regime, CMC hourly data):**

| Metric | Triton | Equal-weight buy & hold |
|---|---|---|
| Return | **≈ -1.8% to +0.1%** (window drifts daily) | **-17% to -18%** |
| Alpha | **+15 to +17 pts** | — |
| Max drawdown | **≈ -5%** | >20% |
| Win rate | 36–53% | — |

**Stress horizon (365 days incl. a -58.6% bear year, Binance hourly data):**

| Metric | Triton | Buy & hold |
|---|---|---|
| Return | -46.7% | -58.6% (+12 alpha) |
| Rolling 7-day windows (n=358) | median -1.7% · **best +21.6%** | — |

The 7-day distribution is the competition statistic: the strategy's best weeks (+15 to +21.6%) are all **post-capitulation rebounds** — the regime a live-trading week starting from extreme fear is most likely to be. In red weeks the median (-1.2 to -1.7%) preserves capital while long-biased competitors bleed.

## 2. Robustness (anti-curve-fit check)

Every adopted parameter sits on a **plateau**, not a peak (neighbor values within ±0.36pp):
overextension veto 2.0/2.5/3.0 → -1.70/-1.80/-1.80% · support proximity 1.5/2/3% → -1.44/-1.80/-1.56% · fear threshold 2.5/3/3.5 → identical. The edge is architectural, not a tuned number.

## 3. Rules born from live operation (human-in-the-loop)

Two rules were proposed by the human operator watching the live agent, formalized, and adopted the same day after passing the backtest:
- **Overextension veto** (`pct1h ≤ 2.5` at entry): the operator watched the agent buy the top of a vertical hourly candle; the veto improved the window by **+1.46pp** and would have blocked that exact entry.
- **Support-anchored RANGE entries** (within 2% of the 48h low): +0.43pp, drawdown -5.97→-5.57%, win rate 47→50%, six bad entries skipped.

## 4. The falsification log (what the data REJECTED)

A strategy is only as credible as the ideas it killed. All tested on the same harnesses:

| Hypothesis | Result | Verdict |
|---|---|---|
| Contrarian buy-the-fear (buyTh 1.0 in fear) | -12.8% vs -4.8% baseline DD | **Inverted**: fear now demands MORE signal |
| Ungated RANGE module | -6.5% | Adopted only with double regime gate |
| Ungated BREAKOUT | DD -7.3% vs -4.8% | Adopted only risk-on-gated (zero-harm proven) |
| BTC/ETH leader gate | neutral at -2/-4, harmful at 0 | Rejected (token-level confirmation already covers it) |
| Volatility-scaled sizing | return -1.4pp for DD -1.4pp | Rejected (DD headroom already huge) |
| Weekly-resistance veto | -0.2 to -0.9pp | Rejected (V-recoveries punch through) |
| High-beta trending tokens (ASTER/ZEC/SAHARA) | DD doubled to -10.9%; still worse gated | Benched with re-entry conditions |
| E0V1E-style dip module (acute RSI oversold) | contest neutral; year -48.6%, 1000 trades | Rejected: +1-3% bounce harvesting dies under DEX round-trip frictions |
| 24h time-exit (stale capital rotation) | contest best-ever (-1.08%, DD -4.52%) but year worse | **Routed to live A/B challenger** instead of blind adoption |
| Volume-led early entry | neutral in bear window | In live A/B challenger (its habitat is rebounds) |

## 5. Validation beyond backtests

- **Live paper A/B**: champion config vs challenger (time-exit + early-volume entries) running 24/7 on a VPS against real market data — out-of-sample selection before the live window.
- **Token selection is systematic**: structural-fitness selector over all 51 liquid eligible tokens (`scripts/select-universe.ts`) + per-token engine scan (`scripts/scan-universe.ts`); challengers TON/PENDLE/PENGU were tested in full-portfolio backtests and lost to the incumbent list.
- **Open-source champions studied**: the entry/exit anatomy of NostalgiaForInfinity, E0V1E, NASOS was dissected; what survived our frictions was adopted (NFI's pump protection), what didn't was documented (dip-scalping), and the NASOS overfit story is why no fine parameter fishing was done in the final week.

## 6. CMC data surfaces used

quotes/latest (signals) · fear-and-greed latest+historical (regime) · trending/latest (attention overlay) · quotes/historical (backtests) · listings/latest (universe screener) · MCP narratives/news/macro (context layer) · x402 paid DEX-pair depth (payment layer verified end-to-end; endpoint pending CMC-side fix).
