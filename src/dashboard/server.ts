import { createServer } from "node:http";
import { readTickState, readEquity } from "../state/telemetry.js";
import { loadPortfolio } from "../state/portfolio.js";
import { HTML } from "./page.js";

const PORT = Number(process.env.DASHBOARD_PORT ?? 7777);

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/state")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ state: readTickState(), history: loadPortfolio().history.slice(-50).reverse() }));
    return;
  }
  if (url.startsWith("/api/equity")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readEquity()));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`Triton dashboard -> http://localhost:${PORT}`);
});
