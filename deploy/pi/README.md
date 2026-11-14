# Scraper remoto en la Pi

La Pi ejecuta Chromium con su IP y devuelve el resultado al servidor principal por Tailscale.
No tiene acceso a la base de datos ni a datos de usuarios.

## En la Pi
1. `cd /home/pi/ojoalprecio-scraper` y copia esta carpeta (`docker-compose.yml`, `chromium-nice.sh`, `.env.example`).
2. `cp .env.example .env` y rellena `SCRAPER_SERVICE_TOKEN` (≥ 24 caracteres) y `TAILSCALE_IP`.
3. `docker compose pull && docker compose up -d`
4. Comprueba: `curl -s -H "Authorization: Bearer $TOKEN" http://$TAILSCALE_IP:8890/health`

## En el servidor principal (Hetzner)
- En su `.env`: `SCRAPER_REMOTES=pi|http://<TAILSCALE_IP_DE_LA_PI>:8890` y `SCRAPER_REMOTE_TOKEN=<el mismo token>`
- Activar: `UPDATE app_settings SET value='1' WHERE key='scraper_remote_concurrency'` (0 = desactivado).
  Si la fila no existe: `INSERT INTO app_settings (key, value) VALUES ('scraper_remote_concurrency', '1')`.
- Desactivar sin redesplegar: poner el valor a `0`.

## Actualizar
Misma imagen que el servidor: `docker compose pull && docker compose up -d` en ambos cuando haya versión nueva.
