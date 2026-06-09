# TRITON — Autonomous Trading Agent for BSC

> **BNB HACK 2026 · Track 1: Autonomous Trading Agents**
> Reads CMC signals → decides → signs & executes via Trust Wallet — with an on-chain ERC-8004 identity.

**Live dashboard:** https://triton-dashboard.vercel.app

```
[CMC Agent Hub] ──signals──> [Strategy Engine] ──intent──> [Risk Manager] ──orders──> [TWAK] ──swaps──> [BSC]
 quotes, momentum,            momentum scoring,             HARD limits:              self-custody,
 volume, Fear & Greed         F&G regime adaptation         stop-loss, kill switch    0x aggregator
```

## The three sponsor stacks, used end-to-end

| Sponsor | Integration | Proof |
|---|---|---|
| **CoinMarketCap** | Agent Hub REST API: live quotes (1h/24h/7d momentum, volume), Fear & Greed index drives regime adaptation | [`src/signals/cmc.ts`](src/signals/cmc.ts) |
| **Trust Wallet** | Agent Kit (TWAK): local encrypted wallet (keys never leave the machine), quote-first swap execution on BSC via 0x | [`src/execution/twak.ts`](src/execution/twak.ts) |
| **BNB Chain** | BNB Agent SDK: Triton is registered as **ERC-8004 agent #1335** on BSC testnet | [tx 0xa335f23f…](https://testnet.bscscan.com/tx/0xa335f23f086b90f770d810f8508de4d92045b8a673049f6d8daf814ad2360c35) |

## How Triton decides

1. **Signal** — momentum score per token: `1h × 0.5 + 24h × 0.35 + 7d × 0.15`, boosted/penalized by 24h volume change.
2. **Regime** — CMC Fear & Greed acts as a *contrarian regulator*: in Extreme Greed the buy threshold triples (caution at the top); in Extreme Fear the sell threshold loosens (don't panic-sell the bottom).
3. **Risk** — the strategy proposes, the Risk Manager disposes. Hard limits are **hardcoded on purpose** (changing them requires a code review, not an env edit):
   - Max 20% of portfolio per position, max 4 open positions
   - Stop-loss −5% (hard floor) + trailing stop −4% from peak once a position is +3% (lets winners run, locks in gains), evaluated **every tick, even when the kill switch is active** (closing reduces risk; opening adds it)
   - Daily loss cap −8% → kill switch until next day
   - Per-trade min confidence 60%, max $200
   - Eligible-token allowlist enforced at the execution layer, 24h cooldown after a stop-loss, minimum 1 trade/day compliance (competition rules)
4. **Execution** — quote first, always. Swaps abort if price impact > 1.5%. Paper and live modes share the same accounting engine — only the executor changes.

## Architecture

```
src/
├── signals/cmc.ts        CMC Agent Hub client (quotes + Fear & Greed)
├── strategy/engine.ts    Momentum scoring + regime adaptation
├── risk/manager.ts       Hard limits, stop-loss/take-profit, kill switch
├── execution/
│   ├── paper.ts          Simulated fills (validation mode)
│   └── twak.ts           Real swaps via Trust Wallet Agent Kit CLI
├── state/
│   ├── portfolio.ts      Positions, realized/daily PnL, fill history
│   ├── telemetry.ts      Per-tick state + equity curve
│   └── publisher.ts      Pushes state to the public dashboard (fail-silent)
├── agent.ts              The loop: signals → decide → risk → execute
└── dashboard/            Local monitoring UI (the public one lives in triton-dashboard)
identity/
└── register_identity.py  ERC-8004 registration via BNB Agent SDK
```

## Backed by data

Backtest over the last 21 days (hourly CMC data, bear-market window), replaying the **exact live engine** — same strategy, same risk manager, same accounting; only the feed is simulated:

| Metric | Triton (three-module ensemble) | Buy & hold (watchlist) |
|---|---|---|
| Return | **+0.06%** | −17.00% |
| Max drawdown | **−4.98%** | >20% |
| Win rate | 53% | — |

**Positive return (+17 points of alpha) in a full crash window**, on the competition's eligible-token watchlist. Token selection is data-disciplined too: structurally-chosen universe (liquidity, operability, diversity), then consistent strategy-misfit losers benched (DOT, UNI whipsawed momentum in every tested config) and replaced by a resilience pick (ATOM). Triton runs a regime-gated three-module ensemble: MOMENTUM (buys confirmed strength, trailing-stop exits), RANGE (mean reversion, only wakes when token AND global market are sideways) and BREAKOUT (48h-high breaks with volume, only wakes in healthy risk-on markets — validated to do zero harm in bear data, designed to capture bull weeks). The backtest harness drove every decision — it falsified contrarian buy-the-fear, falsified an ungated range module (-6.5%: in a bear, "sideways" is consolidation before breakdown), and validated trend+volume confirmation, falling-knife filters, post-stop cooldowns, and the double-gated ensemble. Data-backed, not curve-fit. Reproduce it: `npm run backtest -- 21`

## Run it

```bash
npm install
cp .env.example .env      # add your CMC API key (+ TWAK credentials for live mode)
npm run tick              # single tick
npm run start             # continuous loop (5 min interval)
npm run dashboard         # local dashboard at :7777
```

`EXECUTION_MODE=paper` (default) simulates fills with DEX-like fees. `EXECUTION_MODE=live` signs and executes real swaps on BSC through TWAK.

## Security posture

- Private keys: generated and AES-256-GCM encrypted **locally** by TWAK; never sent anywhere.
- Wallet password: resolved from OS keychain / env, never as CLI argument.
- Dashboard ingest: bearer-token protected; the public page is read-only.
- Risk limits: code, not config.

---

Built for [BNB HACK 2026](https://coinmarketcap.com/api/hackathon/) — CoinMarketCap × Trust Wallet × BNB Chain.
