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

## Monitorización de la Pi (CPU, memoria, temperatura)
Desde que arranca, el servicio mide cada 10 s y lo escribe en su log cada 5 min (`docker logs ojoalprecio-scraper | grep metrics`):
CPU del contenedor (en % de 1 núcleo), memoria del contenedor frente a su límite, **memoria libre de la Pi**, **crecimiento del swap desde el arranque**, temperatura y carga.

- Ver el estado ahora: `curl -s -H "Authorization: Bearer $TOKEN" http://$TAILSCALE_IP:8890/health` (campo `system`) y el historial en `/metrics`.
- El servidor principal lo consulta cada 30 s, lo guarda cada minuto en la tabla `executor_metrics` (14 días) y lo muestra en `https://ojoalprecio.com/healthz/scraper`.
- **Protección automática:** si la Pi llega a estado crítico (memoria libre < 600 MB, temperatura ≥ 82 °C, swap +1,5 GB, carga > 3,8), el worker remoto se pausa 10 minutos, te llega un correo y se reanuda tras 2 comprobaciones sanas seguidas.
  Avisos (sin pausa) desde: memoria libre < 1 GB, 75 °C, swap +600 MB, carga > 3, o el contenedor al 90 % de su límite.

