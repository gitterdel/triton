import type { Decision, MarketContext, Portfolio, TokenSignal } from "../types.js";
import { config } from "../config.js";

// Estrategia: momentum ponderado por régimen de mercado (Fear & Greed).
// - Momentum: combinación de cambios 1h/24h/7d, con más peso al corto plazo.
// - Volumen creciente confirma el movimiento.
// - F&G actúa de regulador contrario: con Extreme Greed exigimos más señal
//   para comprar; con Extreme Fear, más señal para vender (evitar pánico).

// Parámetros de la estrategia, exportados para telemetría/dashboard.
export const STRATEGY_PARAMS = {
  momentumWeights: { h1: 0.5, h24: 0.35, d7: 0.15 },
  volumeBoost: { threshold: 20, up: 1.2, down: 0.8 },
  trendingBoost: 1.2,
  regimes: {
    greed: { fg: ">=75", buyThreshold: 3, sellThreshold: -1.5 },
    neutral: { fg: "26-74", buyThreshold: 1.5, sellThreshold: -2 },
    fear: { fg: "<=25", buyThreshold: 3, sellThreshold: -4 },
  },
  buyConfirmation: "24h > 0 AND 7d > -15% AND volume24h rising",
  // H5 (hipótesis del operador, adoptada 10-jun): no perseguir velas horarias
  // verticales — backtest: +1.46pp de retorno con veto en 2.5%
  maxEntry1hPct: 2.5,
  // Módulo BREAKOUT: compra rupturas de máximos de 48h con volumen.
  // Entra al nacer la tendencia, antes de que el momentum acumulado confirme.
  breakout: {
    entryIf: "precio > máximo 48h × 1.005 AND vol24h subiendo >25% AND 1h > +0.3%",
    minPct7d: -10, // no comprar rupturas dentro de desplomes del token
    maxMarketDecline7d: -3, // ni con el mercado global cayendo (bear rallies)
    minFearGreed: 35, // las rupturas sostenibles necesitan apetito de riesgo
    exits: "como momentum: stop -5% + trailing",
  },
  // Módulo RANGE (reversión a la media): solo opera en mercado lateral.
  // Doble puerta validada por backtest: el TOKEN debe estar lateral Y el
  // MERCADO GLOBAL también — en bajista, lo "lateral" es consolidación
  // antes de seguir cayendo y el módulo pierde (verificado: -6.5% vs -4.8%).
  range: {
    sidewaysIf: "|7d| <= 5% AND |24h| <= 2.5%",
    entryIf: "24h <= -1.2% AND 1h >= +0.2% (dip girándose dentro del rango)",
    minFearGreed: 40, // en miedo los rangos se rompen: módulo apagado
    maxMarketDecline7d: -3, // media de 7d de la watchlist debe ser > -3%
    targetPct: 3,
    stopPct: 3,
    // H6 (hipótesis del operador, adoptada 10-jun): comprar el dip solo a
    // <2% del soporte (mínimo 48h) — backtest: +0.43pp, DD -0.4pp, WR 50%
    nearSupportPct: 2,
  },
};

export function momentumScore(s: TokenSignal): number {
  const m = s.percentChange1h * 0.5 + s.percentChange24h * 0.35 + s.percentChange7d * 0.15;
  const volBoost = s.volumeChange24h > 20 ? 1.2 : s.volumeChange24h < -20 ? 0.8 : 1;
  return m * volBoost;
}

function regimeAdjustment(fearGreed: number): { buyThreshold: number; sellThreshold: number } {
  // Base: comprar si score > 1.5, vender si score < -2.
  // El backtest desmintió la versión contrarian original (buyTh=1 en fear
  // producía whipsaws constantes en tendencia bajista): en los extremos del
  // sentimiento se exige MÁS momentum para entrar, no menos.
  const fearTh = Number(process.env.TEST_FEAR_TH ?? 3);
  const neutralTh = Number(process.env.TEST_NEUTRAL_TH ?? 1.5);
  if (fearGreed >= 75) return { buyThreshold: 3, sellThreshold: -1.5 }; // greed: cautela al comprar
  if (fearGreed <= 25) return { buyThreshold: fearTh, sellThreshold: -4 }; // fear: solo momentum fuerte y confirmado
  return { buyThreshold: neutralTh, sellThreshold: -2 };
}

export function decide(ctx: MarketContext, portfolio: Portfolio): Decision[] {
  const { buyThreshold, sellThreshold } = regimeAdjustment(ctx.fearGreedValue);
  const held = new Set(portfolio.positions.map((p) => p.symbol));
  // Posiciones BULL: sus salidas las gobierna SOLO el risk manager (trailing
  // ancho) — la señal de venta del momentum no debe bajarlas del tren.
  const heldBull = new Set(portfolio.positions.filter((p) => p.strategy === "bull").map((p) => p.symbol));

  const trending = new Set(ctx.trending);
  // Salud global del mercado: media del 7d de toda la watchlist. Los
  // harnesses de token único (scan-universe) inyectan un override con una
  // cesta de majors — sin él, "mercado" sería el propio token (worklist 5).
  const marketAvg7d = ctx.marketAvg7d ?? ctx.signals.reduce((sum, x) => sum + x.percentChange7d, 0) / (ctx.signals.length || 1);
  // TEST filtro de líderes: media 24h del mercado (BTC/ETH mandan: si el
  // mercado cae hoy, la fuerza individual de una alt suele ser arrastrada)
  const marketAvg24h = ctx.signals.reduce((sum, x) => sum + x.percentChange24h, 0) / (ctx.signals.length || 1);
  const LEADER_GATE = Number(process.env.TEST_LEADER_GATE ?? -99); // -99 = apagado

  // Risk-on global: mercado no cayendo + sentimiento fuera del miedo
  const riskOn = marketAvg7d > -3 && ctx.fearGreedValue >= 35;

  // TEST_REGIME_POS (lab, RECHAZADO 12-jun): cupo adaptativo al régimen.
  // No muerde: con F&G<25 el umbral fear ya bloquea casi todas las entradas
  // y rara vez hay 4+ posiciones (1000d idéntico al base; épocaA -1pp). La
  // magia de POS4 era capar exposición SIEMPRE, no solo en miedo.
  const REGIME_POS = Number(process.env.TEST_REGIME_POS ?? 0); // 0 = apagado
  const REGIME_FG = Number(process.env.TEST_REGIME_FG ?? 25);
  const regimeFull = REGIME_POS > 0 && ctx.fearGreedValue < REGIME_FG && held.size >= REGIME_POS;

  // TEST_SKIP_WEEKEND (lab, RECHAZADO 12-jun): sin entradas sáb/dom UTC.
  // Inconsistente entre épocas (épocaA +9.3pp pero 365d -1.4pp y 90d -0.4):
  // el efecto finde no es estable — no hay forma honesta de quedárselo.
  const SKIP_WKND = process.env.TEST_SKIP_WEEKEND === "1";

  // TEST_BREAKER (lab, RECHAZADO 12-jun): cesta a -X% de su máx 7d corta
  // entradas. El dial se contradice entre épocas (365d: monótono hacia 8,
  // -17.7 vs -26.8; épocaA: 8 DAÑA -56.0 y 12 es pico aislado) — el umbral
  // bueno depende de si los desplomes rebotan en V o siguen cayendo, que
  // solo se sabe a posteriori. Sin meseta = sin parámetro elegible.
  const BREAKER = Number(process.env.TEST_BREAKER ?? 0); // 0 = apagado
  let breakerOn = false;
  if (BREAKER > 0 && ctx.high168h) {
    let sum = 0;
    let n = 0;
    for (const sig of ctx.signals) {
      const h = ctx.high168h[sig.symbol];
      if (h && h > 0) {
        sum += (sig.priceUsd / h - 1) * 100;
        n++;
      }
    }
    breakerOn = n > 0 && sum / n <= -BREAKER;
  }

  // TEST_ONLY_SYMBOLS (lab, 12-jun): restringe las COMPRAS a una sublista
  // (ej. "ETH,DOGE,CAKE,XRP" — majors baratos) manteniendo el resto de la
  // watchlist como contexto de mercado. Hallazgo: la cesta de alts es la
  // sangría estructural (cuarteto: épocaA -7.7 vs -54.8 del baseline).
  const ONLY = (process.env.TEST_ONLY_SYMBOLS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

  return ctx.signals.map((s) => {
    // Guarda común de los knobs de laboratorio: bloquea ENTRADAS nuevas
    // (nunca ventas) cuando el cupo de régimen, el finde, el breaker o la
    // sub-cesta mandan.
    const entriesBlocked =
      regimeFull ||
      breakerOn ||
      (SKIP_WKND && [0, 6].includes(new Date(s.timestamp).getUTCDay())) ||
      (ONLY.length > 0 && !ONLY.includes(s.symbol));
    // Tokens de alta beta (trending volátiles): SOLO comprables en risk-on.
    // En bajista, sus rebotes-trampa duplican el drawdown (validado).
    const betaBlocked = config.watchlist[s.symbol]?.highBeta === true && !riskOn;

    let score = momentumScore(s);
    // Boost de atención: momentum positivo + trending en CMC = mayor
    // probabilidad de continuación (la atención amplifica los movimientos).
    const isTrending = trending.has(s.symbol);
    if (isTrending && score > 0) score *= 1.2;
    const reasons: string[] = [
      `momentum=${score.toFixed(2)} (1h=${s.percentChange1h.toFixed(2)}%, 24h=${s.percentChange24h.toFixed(2)}%, 7d=${s.percentChange7d.toFixed(2)}%)${isTrending ? " 🔥trending" : ""}`,
      `volChange24h=${s.volumeChange24h.toFixed(1)}%`,
      `F&G=${ctx.fearGreedValue} (${ctx.fearGreedLabel}) -> buyTh=${buyThreshold}, sellTh=${sellThreshold}`,
    ];

    // Filtros de confirmación anti-whipsaw (validados por backtest):
    // - el 24h debe acompañar (no comprar rebotes de 1h dentro de caídas)
    // - no comprar cuchillos cayendo (7d peor que -15%)
    // H2 (lab): entrada anticipada guiada por volumen — si el volumen explota
    // y la última hora empuja fuerte, no esperar al 24h verde
    const earlyVolEntry =
      process.env.TEST_EARLY_VOL === "1" && s.volumeChange24h > 50 && s.percentChange1h > 1.5 && s.percentChange7d > -15;
    const confirmed = (s.percentChange24h > 0 && s.percentChange7d > -15 && s.volumeChange24h > 0) || earlyVolEntry;

    // H5 (adoptada): veto de sobreextensión — no perseguir velas horarias ya
    // verticales (comprar el pico del latigazo = entrada tardía)
    const MAX_1H = Number(process.env.TEST_MAX_1H ?? STRATEGY_PARAMS.maxEntry1hPct);
    const overextended = s.percentChange1h > MAX_1H;

    // H7 (lab): veto de resistencia — no comprar momentum justo DEBAJO de la
    // resistencia semanal (zona de oferta). Ese territorio es del breakout:
    // o la rompe con volumen, o la rechaza y no había que estar dentro.
    const RES_PCT = Number(process.env.TEST_RESISTANCE_PCT ?? 0); // 0 = apagado
    const hi168 = ctx.high168h?.[s.symbol];
    const underResistance =
      RES_PCT > 0 && hi168 != null && s.priceUsd < hi168 && s.priceUsd > hi168 * (1 - RES_PCT / 100);

    // PUMP-PROTECTION (ADOPTADA, robada de NostalgiaForInfinity): no comprar
    // nada cuyo rango high/low 24h supere 35% — el dip de algo que acaba de
    // hacer x1.35 no es un dip, es la primera pata del desplome. Backtest
    // neutro pero es airbag real contra los dump-traps de BSC.
    const PUMP_MAX = Number(process.env.TEST_PUMP_MAX ?? 35);
    const pumped = PUMP_MAX > 0 && (ctx.range24hPct?.[s.symbol] ?? 0) > PUMP_MAX;

    // Módulo BULL (lab): seguimiento de tendencia para regímenes alcistas.
    // Diagnóstico (campaña 11-jun, 2000d: bot -66% vs B&H +256%): en bull el
    // momentum no entra (exige explosividad que un bull que muele +1%/día no
    // da) y cuando entra, el trailing fino lo baja del tren en +5%. Aquí se
    // entra por TENDENCIA SOSTENIDA (7d) y la salida la pone el manager con
    // correa larga. Va ANTES del momentum para reclamar la entrada con su
    // perfil de salida cuando el régimen es alcista.
    if (process.env.TEST_BULL_MODE === "1") {
      const BULL_FG = Number(process.env.TEST_BULL_FG ?? 55);
      const BULL_7D = Number(process.env.TEST_BULL_7D ?? 5);
      // TEST_FG_VEL (lab, RECHAZADO 12-jun): puerta por VELOCIDAD del F&G
      // (Δ7d≥X despierta el bull bajo el umbral). Trampa confirmada: los
      // rallies de oso suben el F&G +10-15 y el bull entra con stop ancho
      // (365d -34.7 con VEL10 y -32.4 con VEL15, vs -26.8 base). Curioso:
      // mejoraba el 90d actual (-8.0, mejor semana 8.7) — anotado, no vale.
      const FG_VEL = Number(process.env.TEST_FG_VEL ?? 0); // 0 = apagado
      const fgVelOk = FG_VEL > 0 && (ctx.fearGreedDelta7d ?? -Infinity) >= FG_VEL;
      const bullRegime = (ctx.fearGreedValue >= BULL_FG || fgVelOk) && marketAvg7d > 0;
      if (bullRegime && s.percentChange7d >= BULL_7D && s.percentChange24h > 0 && !overextended && !pumped && !entriesBlocked && !held.has(s.symbol)) {
        return {
          symbol: s.symbol,
          action: "BUY" as const,
          confidence: 0.7,
          reasons: [
            `BULL: tendencia 7d +${s.percentChange7d.toFixed(1)}% con mercado alcista (media7d +${marketAvg7d.toFixed(1)}%, F&G ${ctx.fearGreedValue})`,
            ...reasons.slice(1),
          ],
          signal: s,
          strategy: "bull" as const,
        };
      }
    }

    // DONCHIAN (lab, RECHAZADO 12-jun — no reabrir sin idea nueva): ruptura
    // del máximo de N días con puerta F&G. El cribado a nivel señal era
    // prometedor (+2.6-3.2%/trade neto en 1000d/épocaA), pero en CARTERA
    // pierde de las dos formas: añadido al BULL canibaliza (las rupturas
    // que el filtro de fuerza 7d rechazaba son las débiles, y bloquean
    // slots: 365d -31.0 vs -26.8); sustituyendo al BULL es mucho peor
    // (1000d -55.5 vs -37.2: el gatillo fuerza-7d vale ~18pp). Lección:
    // los cribados por-trade no ven la competencia por capital.
    const DONCH_N = Number(process.env.TEST_DONCHIAN ?? 0);
    if (DONCH_N > 0) {
      const BULL_FG = Number(process.env.TEST_BULL_FG ?? 55);
      const dHigh = ctx.donchianHighUsd?.[s.symbol];
      if (ctx.fearGreedValue >= BULL_FG && dHigh != null && dHigh > 0 && s.priceUsd > dHigh && !pumped && !entriesBlocked && !held.has(s.symbol)) {
        return {
          symbol: s.symbol,
          action: "BUY" as const,
          confidence: 0.7,
          reasons: [
            `DONCHIAN: ruptura del máximo ${DONCH_N}d ($${dHigh.toFixed(4)}) con F&G ${ctx.fearGreedValue}`,
            ...reasons.slice(1),
          ],
          signal: s,
          strategy: "bull" as const,
        };
      }
    }

    // H8 (lab): umbral adaptativo a la volatilidad — un umbral fijo significa
    // cosas distintas según el pulso del día. TEST_ADAPTIVE_TH = rango 24h
    // "pivote" en % (el umbral escala rango/pivote, acotado 0.6–1.8×); 0 = off.
    const ADAPT = Number(process.env.TEST_ADAPTIVE_TH ?? 0);
    let effBuyTh = buyThreshold;
    if (ADAPT > 0) {
      const rng = ctx.range24hPct?.[s.symbol];
      if (rng != null && rng > 0) effBuyTh = buyThreshold * Math.min(1.8, Math.max(0.6, rng / ADAPT));
    }

    // TEST_INVERT (lab, 13-jun, hipótesis del operador — RECHAZADO 4/4 épocas):
    // ESPEJO del momentum (comprar debilidad, vender fuerza). El operador
    // observó 2 perdedoras seguidas (ATOM, DOGE) y propuso invertir. Probado
    // a fee real + compliance: PEOR en todo — 90d -20.6 vs -9.6 · 365d -59.8
    // vs -45.8 · 1000d -89.9 vs -60.6 · épocaA -91.8 vs -76.0; WR cae a 24%.
    // Diagnóstico de retornos forward (sobre 1M+ horas): el momentum SÍ
    // predice (1000d monótono: bucket >8 → +1.0%/24h); el único sitio donde
    // la debilidad rebota es la capitulación profunda (<-8: +1.3-3.9% bruto),
    // PERO < el peaje de 1.6% (ya muerto 3 veces: dip, perdedor-24h, capit).
    // Las 2 perdedoras del operador son la experiencia normal de un sistema
    // WR~33% (P(2 seguidas)~45%), no una señal invertida. NO REABRIR.
    // Mismo overlay de riesgo; filtros direccionales espejados; pump se queda.
    const INVERT = process.env.TEST_INVERT === "1";
    if (INVERT) {
      const invScore = -score;
      const invConfirmed = s.percentChange24h < 0 && s.percentChange7d > -25;
      const invKnife = s.percentChange1h < -MAX_1H; // caída vertical de 1h: esperar
      if (invScore >= effBuyTh && invConfirmed && !invKnife && !betaBlocked && !pumped && !entriesBlocked && !held.has(s.symbol)) {
        const confidence = Math.min(0.95, 0.5 + (invScore - effBuyTh) / 10);
        return {
          symbol: s.symbol,
          action: "BUY" as const,
          confidence,
          reasons: [`INVERT: compra de debilidad, momentum ${score.toFixed(2)} (24h=${s.percentChange24h.toFixed(2)}%)`, ...reasons.slice(1)],
          signal: s,
          strategy: "momentum" as const,
        };
      }
      if (invScore <= sellThreshold && held.has(s.symbol) && !heldBull.has(s.symbol)) {
        const confidence = Math.min(0.95, 0.5 + (sellThreshold - invScore) / 10);
        return { symbol: s.symbol, action: "SELL" as const, confidence, reasons, signal: s, strategy: "momentum" as const };
      }
      return { symbol: s.symbol, action: "HOLD" as const, confidence: 0, reasons, signal: s };
    }

    if (score >= effBuyTh && confirmed && !betaBlocked && !overextended && !underResistance && !pumped && !entriesBlocked && marketAvg24h > LEADER_GATE && !held.has(s.symbol)) {
      const confidence = Math.min(0.95, 0.5 + (score - effBuyTh) / 10);
      return { symbol: s.symbol, action: "BUY" as const, confidence, reasons, signal: s, strategy: "momentum" as const };
    }
    if (score <= sellThreshold && held.has(s.symbol) && !heldBull.has(s.symbol)) {
      const confidence = Math.min(0.95, 0.5 + (sellThreshold - score) / 10);
      return { symbol: s.symbol, action: "SELL" as const, confidence, reasons, signal: s, strategy: "momentum" as const };
    }

    // Módulo BREAKOUT: ruptura de máximos de 48h con confirmación de volumen.
    const B = STRATEGY_PARAMS.breakout;
    const hi48 = ctx.high48h?.[s.symbol];
    if (
      hi48 &&
      s.priceUsd > hi48 * 1.005 &&
      s.volumeChange24h > 25 &&
      s.percentChange1h > 0.3 &&
      s.percentChange7d > B.minPct7d &&
      marketAvg7d > B.maxMarketDecline7d &&
      ctx.fearGreedValue >= B.minFearGreed &&
      !entriesBlocked &&
      !held.has(s.symbol)
    ) {
      const confidence = Math.min(0.9, 0.62 + s.volumeChange24h / 300);
      return {
        symbol: s.symbol,
        action: "BUY" as const,
        confidence,
        reasons: [
          `BREAKOUT: precio ${s.priceUsd.toFixed(4)} > máximo 48h ${hi48.toFixed(4)} con volumen +${s.volumeChange24h.toFixed(0)}%`,
          ...reasons.slice(1),
        ],
        signal: s,
        strategy: "breakout" as const,
      };
    }

    // Módulo DIP (lab, escuela E0V1E — la dominante del spot open source):
    // sobreventa AGUDA de corto plazo (RSI4 hundido) con caída aún en curso
    // (RSI20 decreciente), precio claramente bajo su media, pero VETADO el
    // pánico estructural (RSI14 con suelo). Salida estilo range: ±3% y fuera.
    if (process.env.TEST_DIP === "1") {
      const t = ctx.ta?.[s.symbol];
      if (
        t &&
        Number.isFinite(t.sma15) &&
        s.priceUsd < t.sma15 * 0.96 &&
        t.rsi4 < 35 &&
        t.rsi14 > 28 &&
        t.rsi20 < t.rsi20Prev &&
        s.percentChange7d > -15 &&
        !pumped &&
        !betaBlocked &&
        !entriesBlocked &&
        !held.has(s.symbol)
      ) {
        return {
          symbol: s.symbol,
          action: "BUY" as const,
          confidence: 0.65,
          reasons: [
            `DIP: precio ${(100 * (s.priceUsd / t.sma15 - 1)).toFixed(1)}% bajo SMA15 con RSI4=${t.rsi4.toFixed(0)} (RSI14=${t.rsi14.toFixed(0)} sano)`,
            ...reasons.slice(1),
          ],
          signal: s,
          strategy: "range" as const,
        };
      }
    }

    // Módulo RANGE: si momentum no ve nada, buscar reversión a la media en
    // tokens lateralizados — comprar el dip que se está girando, con target
    // y stop cortos. Apagado en pánico (los rangos se rompen a la baja).
    const R = STRATEGY_PARAMS.range;
    const sideways = Math.abs(s.percentChange7d) <= 5 && Math.abs(s.percentChange24h) <= 2.5;
    const dipTurning = s.percentChange24h <= -1.2 && s.percentChange1h >= 0.2;
    const marketSideways = marketAvg7d > R.maxMarketDecline7d;
    // H6 (lab): comprar el dip solo CERCA DEL SOPORTE (mínimo 48h) — el suelo
    // del rango, no cualquier punto de la caída
    const lo48 = ctx.low48h?.[s.symbol];
    // Si aún no hay datos de mínimos (radar calentando), se permite la entrada
    // clásica; con datos, se exige proximidad al soporte.
    const supportPct = Number(process.env.TEST_SUPPORT_PCT ?? R.nearSupportPct);
    const nearSupport = lo48 == null || s.priceUsd <= lo48 * (1 + supportPct / 100);
    if (sideways && dipTurning && marketSideways && nearSupport && ctx.fearGreedValue >= R.minFearGreed && !entriesBlocked && !held.has(s.symbol)) {
      const confidence = Math.min(0.85, 0.6 + Math.abs(s.percentChange24h) / 20);
      return {
        symbol: s.symbol,
        action: "BUY" as const,
        confidence,
        reasons: [
          `RANGE: lateral (7d=${s.percentChange7d.toFixed(2)}%, 24h=${s.percentChange24h.toFixed(2)}%) con dip girándose (1h=+${s.percentChange1h.toFixed(2)}%)`,
          ...reasons.slice(1),
        ],
        signal: s,
        strategy: "range" as const,
      };
    }

    return { symbol: s.symbol, action: "HOLD" as const, confidence: 0, reasons, signal: s };
  });
}
