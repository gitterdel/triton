import { config } from "./config.js";
import { runLoop, tick } from "./agent.js";

if (!config.cmcApiKey) {
  console.error("Falta CMC_API_KEY. Copia .env.example a .env y añade tu clave de pro.coinmarketcap.com");
  process.exit(1);
}

if (process.argv.includes("--once")) {
  tick().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runLoop();
}
