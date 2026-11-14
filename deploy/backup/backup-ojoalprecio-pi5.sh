#!/bin/bash
# Trae a la Pi 5 el volcado diario de la base de datos de OjoAlPrecio (la genera el Hetzner a las 03:30 UTC)
# y lo guarda CIFRADO (AES-256, gpg simetrico). Mismo criterio y MISMA contrasena que backup-datos.sh:
# la de las copias de Home Assistant, que se lee de .storage/backup en cada ejecucion y esta en el gestor
# de contrasenas de David. El volcado lleva emails y hashes de contrasena de usuarios: nunca en claro.
#
#   - Direccion: la Pi 5 TIRA del Hetzner (pull). La clave id_ed25519_ojoalprecio_pull es de SOLO LECTURA
#     (rrsync -ro limitado a /home/david/backups-ojoalprecio/db y a la IP 100.99.209.115): si alguien entra
#     en la Pi 5 no puede tocar el Hetzner, y si cae el Hetzner no puede borrar estas copias.
#   - El texto en claro solo pasa por /dev/shm (RAM): no toca el disco. Cada copia se verifica descifrandola
#     y comparando el tamano con el original antes de darla por buena.
#   - Retencion: los 30 ultimos dias + el de cada dia 1 (12 meses). Se guarda tambien el docker-compose.yml.
#   - Programado: 0 5 * * *   (despues de las 04:30 hora de Madrid, cuando el Hetzner ya ha volcado).
#
# PARA RESTAURAR (a una base nueva; ver la nota "Proyecto · OjoAlPrecio"):
#   /home/pi/cleanup/backup-ojoalprecio.sh --descifrar /home/pi/backups-extra/ojoalprecio/ojoalprecio_AAAAMMDD_hhmm.dump.gpg > ojoalprecio.dump
#   y despues, en el servidor:  pg_restore -U <usuario> -d <base> --no-owner --role=<usuario> --clean --if-exists ojoalprecio.dump
set -uo pipefail
BASE=/home/pi/backups-extra/ojoalprecio
LOG=/home/pi/cleanup/logs/backup-ojoalprecio.log
KEY=/home/pi/.ssh/id_ed25519_ojoalprecio_pull
REMOTE=david@100.96.69.24
SSH="ssh -i $KEY -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=yes"
umask 077
mkdir -p "$BASE" "$(dirname "$LOG")"; chmod 700 "$BASE"
log(){ echo "$(date "+%F %T")  $*" >> "$LOG"; }

# ---------- contrasena de cifrado (la misma que backup-datos.sh) ----------
PASS=$(sudo -n python3 -c '
import json
d = json.load(open("/home/pi/homeassistant/.storage/backup"))["data"]
print(d["config"]["create_backup"]["password"] or "", end="")
' 2>/dev/null)
if [ -z "$PASS" ]; then
  [ "${1:-}" = "--descifrar" ] && echo "No pude leer la contrasena de cifrado" >&2
  log "ERROR: no pude leer la contrasena de cifrado de .storage/backup. No se genera nada."; exit 1
fi
descifrar(){
  gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d "$1" 3< <(printf %s "$PASS")
}
# Modo restauracion: escribe el volcado en claro por la salida estandar y termina.
if [ "${1:-}" = "--descifrar" ]; then
  [ -f "${2:-}" ] || { echo "Uso: $0 --descifrar fichero.dump.gpg > ojoalprecio.dump" >&2; exit 2; }
  descifrar "$2"; exit $?
fi
cifrar(){
  gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-fd 3 --symmetric --cipher-algo AES256 --compress-algo none \
      3< <(printf %s "$PASS")
}

TMP=$(mktemp -d /dev/shm/ojoalprecio.XXXXXX) || { log "ERROR: no pude crear la carpeta en /dev/shm"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

# ---------- 1. que hay en el Hetzner ----------
LISTA=$(rsync -e "$SSH" --list-only "$REMOTE:./" 2>>"$LOG") || { log "ERROR: no pude listar el Hetzner"; exit 1; }
mapfile -t REMOTOS < <(printf '%s\n' "$LISTA" | awk '{print $NF}' | grep -E '^ojoalprecio_[0-9]{8}_[0-9]{4}\.dump$' | sort)
if [ "${#REMOTOS[@]}" -eq 0 ]; then log "ERROR: el Hetzner no tiene ningun volcado"; exit 1; fi

# ---------- 2. traer, cifrar y verificar los que aun no estan ----------
nuevos=0; fallos=0
for f in "${REMOTOS[@]}"; do
  [ -e "$BASE/$f.gpg" ] && continue
  if rsync -a -e "$SSH" "$REMOTE:./$f" "$TMP/$f" 2>>"$LOG"; then
    if cifrar < "$TMP/$f" > "$BASE/$f.gpg.parcial" \
       && [ "$(descifrar "$BASE/$f.gpg.parcial" | wc -c)" = "$(stat -c %s "$TMP/$f")" ]; then
      mv "$BASE/$f.gpg.parcial" "$BASE/$f.gpg"
      log "ok  $f  $(du -h "$BASE/$f.gpg" | cut -f1)  (cifrado y verificado)"; nuevos=$((nuevos+1))
    else
      rm -f "$BASE/$f.gpg.parcial"; log "ERROR $f: fallo al cifrar o la verificacion no coincide"; fallos=$((fallos+1))
    fi
    rm -f "$TMP/$f"
  else
    log "ERROR $f: fallo al traerlo del Hetzner"; fallos=$((fallos+1))
  fi
done
# docker-compose.yml del servidor (sin secretos), cifrado igualmente; se sobrescribe cada dia.
if rsync -a -e "$SSH" "$REMOTE:./docker-compose.yml" "$TMP/docker-compose.yml" 2>>"$LOG" \
   && cifrar < "$TMP/docker-compose.yml" > "$BASE/docker-compose.yml.gpg.parcial"; then
  mv "$BASE/docker-compose.yml.gpg.parcial" "$BASE/docker-compose.yml.gpg"
else
  rm -f "$BASE/docker-compose.yml.gpg.parcial"; log "AVISO: no pude traer docker-compose.yml"
fi

# ---------- 3. retencion: 30 ultimos + el dia 1 de cada mes (12 meses) ----------
i=0; m=0
mapfile -t TODOS < <(ls -1 "$BASE"/ojoalprecio_*.dump.gpg 2>/dev/null | sort -r)
for f in "${TODOS[@]}"; do
  i=$((i+1)); [ "$i" -le 30 ] && continue
  dia=$(basename "$f" | sed -E 's/^ojoalprecio_[0-9]{6}([0-9]{2})_.*/\1/')
  if [ "$dia" = "01" ] && [ "$m" -lt 12 ]; then m=$((m+1)); continue; fi
  rm -f "$f"
done

# ---------- 4. el volcado mas reciente del Hetzner no puede estar atrasado ----------
# Nombre: ojoalprecio_AAAAMMDD_hhmm.dump (hora UTC). Si el Hetzner deja de volcar, esto lo detecta aunque aqui todo "funcione".
ULTIMO="${REMOTOS[-1]}"; FECHA_U=$(echo "$ULTIMO" | sed -E 's/^ojoalprecio_([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})\.dump$/\1-\2-\3 \4:\5:00/')
EDAD_H=$(( ( $(date +%s) - $(date -u -d "$FECHA_U" +%s 2>/dev/null || echo 0) ) / 3600 ))
if [ "$EDAD_H" -gt 36 ]; then
  log "ERROR: el ultimo volcado del Hetzner ($ULTIMO) tiene $EDAD_H h: el Hetzner no esta volcando"; fallos=$((fallos+1))
fi

# ---------- sello y latido a Uptime Kuma (monitor Push "copia de la base", avisa por correo si deja de llegar) ----------
KUMA_FILE=/home/pi/cleanup/.kuma_push_ojoalprecio
latido(){
  [ -r "$KUMA_FILE" ] || return 0
  curl -fsS -m 15 -G --data-urlencode "status=$1" --data-urlencode "msg=$2" "$(cat "$KUMA_FILE")" >/dev/null 2>&1 \
    || log "AVISO: no pude avisar a Uptime Kuma"
}
if [ "$fallos" -eq 0 ]; then
  date +%s > "$BASE/.ultimo_ok"; log "todo correcto (nuevos: $nuevos, guardados: $(ls -1 "$BASE"/ojoalprecio_*.dump.gpg | wc -l))"
  latido up "OK ultimo volcado $ULTIMO (${EDAD_H} h), guardados $(ls -1 "$BASE"/ojoalprecio_*.dump.gpg | wc -l)"
else
  log "terminado con $fallos fallo(s)"
  latido down "$fallos fallo(s): ver /home/pi/cleanup/logs/backup-ojoalprecio.log"
fi
exit $fallos
