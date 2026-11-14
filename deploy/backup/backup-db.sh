#!/bin/bash
# Volcado diario de la base de datos de OjoAlPrecio (PostgreSQL, formato -Fc, ya comprimido).
#   - Se guardan los 14 ultimos en /home/david/backups-ojoalprecio/db  (modo 600, carpeta 700).
#   - Antes de darlo por bueno se comprueba que se puede leer (pg_restore --list) y que tiene las tablas.
#   - Lo recoge la Pi 5 cada noche (clave de SOLO LECTURA limitada a esa carpeta) y lo guarda cifrado.
#   - Tambien se guarda el docker-compose.yml del servidor (no lleva secretos: usa variables del .env).
#     El .env NO se copia a proposito (lleva claves): esta en el gestor de contrasenas.
# Programado en el cron de david: 30 3 * * *  (UTC).  Registro: backups-ojoalprecio/backup-db.log
# PARA RESTAURAR (ver tambien la nota "Proyecto · OjoAlPrecio"):
#   docker compose up -d postgres ; docker cp ojoalprecio_AAAAMMDD_hhmm.dump ojoalprecio-db:/tmp/
#   docker exec ojoalprecio-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --role="$POSTGRES_USER" --clean --if-exists /tmp/ojoalprecio_AAAAMMDD_hhmm.dump'
set -uo pipefail
DIR=/home/david/backups-ojoalprecio/db
LOG=/home/david/backups-ojoalprecio/backup-db.log
STAMP=$(date -u +%Y%m%d_%H%M)
OUT="$DIR/ojoalprecio_$STAMP.dump"
log(){ echo "$(date -u '+%F %T')Z  $*" >> "$LOG"; }
mkdir -p "$DIR"; chmod 700 "$DIR"
umask 077

if ! docker exec ojoalprecio-db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -d "$POSTGRES_DB"' > "$OUT.parcial" 2>>"$LOG"; then
  rm -f "$OUT.parcial"; log "ERROR: fallo pg_dump"; exit 1
fi
TABLAS=$(docker exec -i ojoalprecio-db pg_restore --list < "$OUT.parcial" 2>/dev/null | grep -c ' TABLE public ')
BYTES=$(stat -c %s "$OUT.parcial")
# Hoy: 34 tablas y ~19 MB. Por debajo de estos minimos algo va mal (base vacia, volcado cortado).
if [ "${TABLAS:-0}" -lt 30 ] || [ "$BYTES" -lt 5000000 ]; then
  rm -f "$OUT.parcial"; log "ERROR: volcado sospechoso (tablas=$TABLAS bytes=$BYTES), descartado"; exit 1
fi
mv "$OUT.parcial" "$OUT"
cp -f /home/david/ojoalprecio/docker-compose.yml "$DIR/docker-compose.yml"
# Retencion: los 14 mas recientes.
ls -1 "$DIR"/ojoalprecio_*.dump 2>/dev/null | sort -r | tail -n +15 | xargs -r rm -f
log "ok  $(basename "$OUT")  $(du -h "$OUT" | cut -f1)  tablas=$TABLAS  guardados=$(ls -1 "$DIR"/ojoalprecio_*.dump | wc -l)"
date +%s > /home/david/backups-ojoalprecio/.ultimo_ok
