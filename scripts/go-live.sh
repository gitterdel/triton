#!/usr/bin/env bash
# go-live.sh — Secuencia de encendido de la semana puntuable (BNB HACK).
#
# Qué hace, en orden:
#   1) Mide la fricción REAL (quote-only, no gasta) ya con el waiver de la
#      trading week activo → fija TEST_FEE_PCT al valor medido (con guardas).
#   2) Pasa a modo carrera: EXECUTION_MODE=live + PUBLIC_FEED_DELAY_MINUTES=60
#      + DISCLOSE_PARAMS=true (transparencia del submission).
#   3) Archiva y resetea el estado → track record 100% live (sin mezclar paper).
#   4) Arranca el watcher de failsafes (ejecuta las automations TWAK de stop).
#   5) Reinicia el agente.
#
# SEGURIDAD: por defecto corre en DRY-RUN (solo imprime lo que haría). Para
# ejecutar de verdad:   GO_LIVE_CONFIRM=1 bash scripts/go-live.sh
#
# Pensado para el VPS (/root/triton). >>> PROBAR EN SECO EL DOMINGO <<< antes de
# armar el timer del lunes 02:00.
set -uo pipefail

ROOT="${TRITON_ROOT:-/root/triton}"
ENV="$ROOT/.env"
DATA="$ROOT/data"
LOG="$DATA/go-live.log"
CONFIRM="${GO_LIVE_CONFIRM:-0}"
FALLBACK_FEE="0.008"   # conservador (media cesta pre-waiver) si la medición falla

say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
run(){ if [ "$CONFIRM" = "1" ]; then eval "$@"; else say "DRY-RUN » $*"; fi; }
set_env(){ # set_env KEY VALUE — idempotente
  local k="$1" v="$2"
  if [ "$CONFIRM" = "1" ]; then
    if grep -qE "^${k}=" "$ENV" 2>/dev/null; then sed -i "s|^${k}=.*|${k}=${v}|" "$ENV"
    else echo "${k}=${v}" >> "$ENV"; fi
  fi
  say "env  $k=$v"
}

mkdir -p "$DATA" 2>/dev/null || true
say "===== GO-LIVE BNB HACK  ($([ "$CONFIRM" = 1 ] && echo '*** REAL ***' || echo 'DRY-RUN'))  ====="

# ── 1) MEDIR FRICCIÓN REAL → TEST_FEE_PCT ────────────────────────────────────
say "1) Midiendo fricción real (quote-only, no gasta)..."
MEAN=$(cd "$ROOT" && npx tsx scripts/quote-friction.ts 20 2>/dev/null \
        | grep -oE "Media cesta: [0-9.]+" | grep -oE "[0-9.]+" | head -1)
FEE="$FALLBACK_FEE"
if [ -n "${MEAN:-}" ]; then
  CAND=$(python3 -c "m=$MEAN; s=m/2/100; print(f'{s:.5f}' if 0.0005<=s<=0.01 else '')" 2>/dev/null)
  if [ -n "$CAND" ]; then FEE="$CAND"; say "   fricción RT medida: ${MEAN}% → TEST_FEE_PCT=$FEE"
  else say "   ⚠ medición fuera de rango ($MEAN% RT) → fallback conservador $FALLBACK_FEE"; fi
else
  say "   ⚠ no se pudo medir → fallback conservador $FALLBACK_FEE"
fi
set_env TEST_FEE_PCT "$FEE"

# ── 2) MODO CARRERA ──────────────────────────────────────────────────────────
say "2) Activando modo carrera..."
set_env EXECUTION_MODE "live"
set_env PUBLIC_FEED_DELAY_MINUTES "60"
set_env DISCLOSE_PARAMS "true"

# ── 3) ARCHIVAR + RESETEAR estado (track record 100% live) ───────────────────
STAMP=$(date -u +%Y%m%d-%H%M%S)
BK="$ROOT/backups/pre-live-$STAMP"
say "3) Archivando estado en $BK y reseteando..."
run "mkdir -p '$BK'"
for f in portfolio.json equity.json state.json trade-journal.jsonl compliance-attempts.json; do
  run "cp -a '$DATA/$f' '$BK/' 2>/dev/null || true"
done
# Reset: curvas/journal/compliance a cero; portfolio se recrea desde balances
# reales al arrancar en live (la wallet es la fuente de verdad — al go-live
# debe estar 100% USDT = flat).
run "rm -f '$DATA/equity.json' '$DATA/state.json' '$DATA/trade-journal.jsonl' '$DATA/compliance-attempts.json'"
run "rm -f '$DATA/portfolio.json'"
# >>> VERIFICAR EL DOMINGO: confirmar que en LIVE el agente reconcilia el
#     portfolio desde la wallet real (no asume flat a ciegas). Si lo asume,
#     dejar portfolio.json reseteado a {cash=balance USDT, positions:[]} a mano.

# ── 4) WATCHER DE FAILSAFES ──────────────────────────────────────────────────
say "4) Arrancando watcher de failsafes (twak-watch)..."
run "systemctl enable --now twak-watch"

# ── 5) REINICIAR EL AGENTE ───────────────────────────────────────────────────
say "5) Reiniciando el agente..."
run "systemctl restart triton"

say "===== HECHO. Verifica: 'systemctl status triton', 'journalctl -u triton -f', dashboard retador ====="
[ "$CONFIRM" = "1" ] || say "(era DRY-RUN — nada cambiado. Para ejecutar: GO_LIVE_CONFIRM=1 bash scripts/go-live.sh)"
