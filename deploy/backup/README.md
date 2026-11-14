# Copia de seguridad de la base de datos

Copia diaria de PostgreSQL desde el Hetzner a la Pi 5, cifrada. Estos scripts viven en los servidores; aquí hay una copia versionada.

| Dónde | Script (ruta en el servidor) | Cuándo | Qué hace |
|---|---|---|---|
| Hetzner | `~/backups-ojoalprecio/backup-db.sh` (`backup-db.sh`) | cron `30 3 * * *` (UTC) | `pg_dump -Fc`, lo verifica (`pg_restore --list`, 34 tablas) y guarda los 14 últimos en `~/backups-ojoalprecio/db` (modo 600). También copia el `docker-compose.yml` (sin secretos). El `.env` no se copia. |
| Pi 5 | `/home/pi/cleanup/backup-ojoalprecio.sh` (`backup-ojoalprecio-pi5.sh`) | cron `0 5 * * *` (Madrid) | Tira del Hetzner con una clave de **solo lectura** (`rrsync -ro`, limitada a esa carpeta y a la IP de la Pi 5), cifra con AES-256 (misma contraseña que las copias de Home Assistant), verifica descifrando y conserva 30 diarias + la del día 1 de cada mes (12 meses). Avisa a Uptime Kuma (monitor Push) con la URL guardada en `/home/pi/cleanup/.kuma_push_ojoalprecio` (600, no está en el script). |

Restaurar: en la Pi 5, `backup-ojoalprecio.sh --descifrar <fichero>.dump.gpg > ojoalprecio.dump` y después `pg_restore -U <usuario> -d <base> --no-owner --role=<usuario> --clean --if-exists ojoalprecio.dump` en el servidor.

La clave de la Pi 5 está autorizada en el Hetzner (`~/.ssh/authorized_keys`) con:
`command="/usr/bin/rrsync -ro /home/david/backups-ojoalprecio/db",from="100.99.209.115",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc ssh-ed25519 <clave pública de la Pi 5>`
