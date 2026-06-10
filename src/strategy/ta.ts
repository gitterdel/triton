// Indicadores técnicos mínimos sobre series de cierres horarios.
// Solo lo que usan los módulos: SMA y RSI clásico (media simple de
// ganancias/pérdidas — suficiente y estable para gates de entrada).

export interface TaSnapshot {
  sma15: number;
  rsi4: number;
  rsi14: number;
  rsi20: number;
  rsi20Prev: number;
}

export function sma(closes: number[], period: number): number {
  if (closes.length < period) return NaN;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period: number, offset = 0): number {
  // offset=1 → RSI de la vela anterior
  const end = closes.length - offset;
  if (end < period + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = end - period; i < end; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (gains + losses === 0) return 50;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function taSnapshot(closes: number[]): TaSnapshot | null {
  if (closes.length < 22) return null;
  return {
    sma15: sma(closes, 15),
    rsi4: rsi(closes, 4),
    rsi14: rsi(closes, 14),
    rsi20: rsi(closes, 20),
    rsi20Prev: rsi(closes, 20, 1),
  };
}
