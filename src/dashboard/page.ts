// Dashboard de Triton: una sola página, sin dependencias, polling cada 5s.
export const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TRITON — Autonomous Trading Agent</title>
<style>
  :root {
    --bg: #0a0e12; --panel: #11161d; --border: #1d2733;
    --text: #c9d6e3; --dim: #5c7186; --green: #2ee58a; --red: #ff5470;
    --amber: #ffc24b; --cyan: #41c7ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace; font-size: 13px; padding: 16px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; letter-spacing: 4px; color: var(--cyan); }
  h1 span { color: var(--dim); font-size: 11px; letter-spacing: 1px; display: block; }
  .badge { padding: 3px 10px; border-radius: 4px; font-size: 11px; border: 1px solid var(--border); }
  .badge.paper { color: var(--amber); border-color: var(--amber); }
  .badge.twak { color: var(--green); border-color: var(--green); }
  .badge.kill { color: var(--red); border-color: var(--red); animation: blink 1s infinite; }
  @keyframes blink { 50% { opacity: 0.4; } }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .panel h2 { font-size: 11px; color: var(--dim); letter-spacing: 2px; margin-bottom: 10px; text-transform: uppercase; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat .v { font-size: 22px; }
  .stat .l { color: var(--dim); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; }
  th { color: var(--dim); font-size: 10px; text-align: left; letter-spacing: 1px; padding: 4px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; }
  td { padding: 5px 8px; border-bottom: 1px solid #141b23; }
  .pos { color: var(--green); } .neg { color: var(--red); } .dim { color: var(--dim); }
  .act-BUY { color: var(--green); font-weight: bold; } .act-SELL { color: var(--red); font-weight: bold; } .act-HOLD { color: var(--dim); }
  .fg-bar { height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--red), var(--amber), var(--green)); position: relative; margin-top: 6px; }
  .fg-dot { position: absolute; top: -4px; width: 4px; height: 16px; background: #fff; border-radius: 2px; }
  #equity-svg { width: 100%; height: 120px; }
  .wide { grid-column: 1 / -1; }
  a { color: var(--cyan); text-decoration: none; }
  .reason { color: var(--dim); font-size: 11px; }
  footer { margin-top: 14px; color: var(--dim); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>TRITON<span>autonomous trading agent · BSC</span></h1>
  <span id="mode" class="badge paper">—</span>
  <span id="kill" class="badge kill" style="display:none">⛔ KILL SWITCH</span>
  <span id="last" class="dim" style="margin-left:auto">—</span>
</header>

<div class="grid">
  <div class="panel">
    <h2>Portfolio</h2>
    <div class="stats">
      <div class="stat"><div class="v" id="total">—</div><div class="l">Total USD</div></div>
      <div class="stat"><div class="v" id="cash">—</div><div class="l">Cash</div></div>
      <div class="stat"><div class="v" id="pnl">—</div><div class="l">Realized PnL</div></div>
      <div class="stat"><div class="v" id="daily">—</div><div class="l">PnL Today</div></div>
      <div class="stat"><div class="v" id="trades">—</div><div class="l">Trades</div></div>
    </div>
  </div>
  <div class="panel">
    <h2>Market Regime — CMC Fear &amp; Greed</h2>
    <div class="stats">
      <div class="stat"><div class="v" id="fg">—</div><div class="l" id="fgl">—</div></div>
    </div>
    <div class="fg-bar"><div class="fg-dot" id="fgdot" style="left:50%"></div></div>
  </div>
  <div class="panel wide">
    <h2>Equity Curve</h2>
    <svg id="equity-svg" preserveAspectRatio="none"></svg>
  </div>
  <div class="panel">
    <h2>Open Positions</h2>
    <table><thead><tr><th>Token</th><th>Qty</th><th>Entry</th><th>Value</th><th>PnL %</th></tr></thead>
    <tbody id="positions"><tr><td colspan="5" class="dim">No open positions — agent in cash</td></tr></tbody></table>
  </div>
  <div class="panel">
    <h2>Latest Signals &amp; Decisions</h2>
    <table><thead><tr><th>Token</th><th>Action</th><th>Conf</th><th>1h</th><th>24h</th><th>7d</th></tr></thead>
    <tbody id="decisions"></tbody></table>
  </div>
  <div class="panel wide">
    <h2>Trade History</h2>
    <table><thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Amount</th><th>Price</th><th>Reason</th><th>Tx</th></tr></thead>
    <tbody id="history"><tr><td colspan="7" class="dim">No trades yet</td></tr></tbody></table>
  </div>
</div>

<footer>CMC Agent Hub signals · Trust Wallet Agent Kit execution · BNB Chain — BNB HACK 2026</footer>

<script>
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const cls = (n) => (n >= 0 ? "pos" : "neg");

async function refresh() {
  try {
    const [{ state, history }, equity] = await Promise.all([
      fetch("/api/state").then((r) => r.json()),
      fetch("/api/equity").then((r) => r.json()),
    ]);
    if (!state) return;

    $("mode").textContent = state.executionMode === "paper" ? "PAPER TRADING" : "● LIVE ON BSC";
    $("mode").className = "badge " + (state.executionMode === "paper" ? "paper" : "twak");
    $("kill").style.display = state.killSwitchActive ? "" : "none";
    $("last").textContent = "last tick " + new Date(state.lastTick).toLocaleTimeString();

    const p = state.portfolio;
    $("total").textContent = usd(p.totalUsd);
    $("cash").textContent = usd(p.cashUsd);
    $("pnl").textContent = usd(p.realizedPnlUsd);
    $("pnl").className = "v " + cls(p.realizedPnlUsd);
    $("daily").textContent = usd(p.dailyPnlUsd);
    $("daily").className = "v " + cls(p.dailyPnlUsd);
    $("trades").textContent = p.tradeCount;

    $("fg").textContent = state.fearGreedValue;
    $("fgl").textContent = state.fearGreedLabel;
    $("fgdot").style.left = state.fearGreedValue + "%";

    $("positions").innerHTML = p.positions.length
      ? p.positions.map((x) => \`<tr><td>\${x.symbol}</td><td>\${x.qty.toFixed(6)}</td><td>\${usd(x.avgEntryUsd)}</td><td>\${usd(x.currentUsd)}</td><td class="\${cls(x.pnlPct)}">\${pct(x.pnlPct)}</td></tr>\`).join("")
      : '<tr><td colspan="5" class="dim">No open positions — agent in cash</td></tr>';

    $("decisions").innerHTML = state.decisions.map((d) => \`<tr>
      <td>\${d.symbol}</td><td class="act-\${d.action}">\${d.action}</td>
      <td>\${d.action === "HOLD" ? "—" : (d.confidence * 100).toFixed(0) + "%"}</td>
      <td class="\${cls(d.pct1h)}">\${pct(d.pct1h)}</td>
      <td class="\${cls(d.pct24h)}">\${pct(d.pct24h)}</td>
      <td class="\${cls(d.pct7d)}">\${pct(d.pct7d)}</td></tr>\`).join("");

    $("history").innerHTML = history.length
      ? history.map((f) => \`<tr>
          <td class="dim">\${new Date(f.executedAt).toLocaleString()}</td>
          <td class="act-\${f.order.side}">\${f.order.side}</td>
          <td>\${f.order.symbol}</td><td>\${usd(f.order.amountUsd)}</td><td>\${usd(f.order.priceUsd)}</td>
          <td class="reason">\${f.order.reason}</td>
          <td>\${f.txHash ? '<a target="_blank" href="https://bscscan.com/tx/' + f.txHash + '">' + f.txHash.slice(0, 10) + '…</a>' : '<span class="dim">paper</span>'}</td></tr>\`).join("")
      : '<tr><td colspan="7" class="dim">No trades yet</td></tr>';

    drawEquity(equity);
  } catch (e) { console.error(e); }
}

function drawEquity(points) {
  const svg = $("equity-svg");
  if (!points.length) return;
  const w = svg.clientWidth, h = svg.clientHeight;
  svg.setAttribute("viewBox", \`0 0 \${w} \${h}\`);
  const vals = points.map((p) => p.totalUsd);
  const min = Math.min(...vals) * 0.999, max = Math.max(...vals) * 1.001;
  const x = (i) => (i / Math.max(points.length - 1, 1)) * w;
  const y = (v) => h - ((v - min) / (max - min || 1)) * (h - 10) - 5;
  const path = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "#2ee58a" : "#ff5470";
  svg.innerHTML = \`
    <path d="\${path} L \${w},\${h} L 0,\${h} Z" fill="\${color}18"/>
    <path d="\${path}" fill="none" stroke="\${color}" stroke-width="1.5"/>
    <text x="6" y="14" fill="#5c7186" font-size="10">\${usd(vals[vals.length - 1])}</text>\`;
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
