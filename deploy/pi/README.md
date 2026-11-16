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
- **Protección automática:** si la Pi llega a estado crítico (memoria libre < 600 MB, temperatura ≥ 82 °C, swap +1,5 GB, **DNS de la Pi tardando ≥ 400 ms**, o carga > 10), el worker remoto se pausa 10 minutos, te llega un correo y se reanuda tras 2 comprobaciones sanas seguidas.
  Avisos (sin pausa) desde: memoria libre < 1 GB, 75 °C, swap +600 MB, DNS ≥ 120 ms, carga > 6, o el contenedor al 90 % de su límite.
  La carga media es solo una red de seguridad: un Chromium con prioridad baja y 2 núcleos mantiene la Pi 4 entre 2 y 6 con normalidad. Lo que protege de verdad a Pi-hole es la latencia DNS medida desde el propio contenedor.

## Notas de la instalación en la Pi 4 (2026-11-14)
- Ejecutor `pi4` → `http://100.108.118.84:8890`. Límites: 2 CPUs. **El kernel de esa Pi no tiene cgroup de memoria**
  (`docker info` avisa "No memory limit support"), así que `mem_limit` no se aplica: se protege con `oom_score_adj: 1000`,
  el rechazo de scrapes nuevos si la memoria libre baja de 500 MB y la pausa automática del servidor principal.
  Para tener el límite real hay que añadir `cgroup_enable=memory cgroup_memory=1` a `/boot/firmware/cmdline.txt` y reiniciar
  (la Pi 4 es el DNS/DHCP de la casa: hacerlo en un momento tranquilo).
- Es lenta con la ficha pesada de Amazon: ~27-36 s por ficha con los 2 núcleos al 100 %. Por eso el servidor principal usa
  `scraper_remote_timeout_seconds` (75 s por defecto) para los ejecutores remotos, aparte de `scraper_timeout_seconds`.
- Medido bajo carga: la latencia DNS de Pi-hole no cambió (mediana 23 ms, máx 31 ms; en reposo 0-27 ms).


## Memoria del contenedor en la Pi 4 (2026-11-14)

Con el cgroup de memoria activado (`cgroup_enable=memory cgroup_memory=1` en `/boot/firmware/cmdline.txt`) el límite se aplica de verdad. Con **2 trabajadores** y **1 GB** el contenedor vivía pegado al tope (570-880 MB): llegó a morir el servicio por memoria (`dmesg`: *Memory cgroup out of memory*) y, al rozar el límite, el contenedor se atascaba (swap) y la prueba de DNS hecha desde dentro fallaba aunque el Pi-hole respondía a la casa en ~1 ms (visto en `pihole-FTL.db`). Ahora: **`SCRAPER_MEM=1536m`** y **`memswap_limit` igual** (sin swap para el contenedor). Uso medido tras el cambio: 265-545 MiB, sin eventos de límite.

Para volver al límite anterior: `SCRAPER_MEM=1g` en el `.env` de la Pi y `docker compose up -d --force-recreate` (hay que recrear: el límite se fija al crear el contenedor).


## El servicio se recicla solo (2026-11-15)

El proceso Node del servicio (`dist/scraper-service.js`) crece ~300 MB por hora y, aun con 1,5 GiB, el kernel lo mató a las 08:04 y a las 11:28 (*Memory cgroup out of memory*, node con ~890 MB). Ahora **se reinicia él mismo** antes de que pase: cuando el Node supera `SCRAPER_RECYCLE_RSS_MB` (700) o, como red de seguridad, tras `SCRAPER_RECYCLE_AFTER` consultas (400), deja de aceptar trabajo nuevo (responde 503 `recycling`), espera a que terminen las consultas en curso (máx. 90 s), sale, y Docker (`restart: unless-stopped`) lo levanta limpio en unos segundos. El servidor principal lo trata como una pausa normal: no cuenta como fallo, no abre el cortacircuitos ni manda correo, y deja ese ejecutor en reposo 45 s.

Además, el contenedor sube a **2 GiB** (`SCRAPER_MEM=2048m`, sin swap) para que Chromium y el Node tengan holgura. Cada 5 minutos el servicio escribe en el log una línea `[mem] node rss=… heap=… external=… buffers=… consultas=…` para ver de dónde crece la memoria (montón de JS, buffers o nativa) y poder arreglar la causa. Se ve con `docker logs ojoalprecio-scraper | grep '\[mem\]'`.

Para cambiar los límites: `SCRAPER_RECYCLE_RSS_MB` / `SCRAPER_RECYCLE_AFTER` en el `.env` de la Pi (0 = desactivado) y `docker compose up -d --force-recreate`. Marcha atrás de los 2 GiB: `SCRAPER_MEM=1536m` y recrear.


### Ajuste del 2026-11-16 (v3.64.0): el reinicio es una bandera, no una puerta cerrada

El tercer reciclado (06:08) dejó un aviso suelto: el servicio cerraba el puerto en cuanto terminaba su última consulta, y la siguiente petición del servidor principal encontraba el puerto cerrado ("sin conexión") en vez de un aviso de reinicio. Ahora:
- **Bandera:** en cuanto el Node supera el límite de memoria (se mira al terminar cada consulta **y al llegar cada petición**) el servicio queda marcado como "reciclando". Desde ese momento **no acepta trabajo nuevo** (responde 503 `recycling`), termina lo que tiene en marcha (máx. 90 s) y **lo siguiente es el reinicio**. Ninguna consulta se queda a medias.
- **Margen de cortesía:** ya sin trabajo, espera 8 s (`SCRAPER_RECYCLE_GRACE_MS`) con el puerto abierto contestando "reciclando", y solo entonces cierra Chromium y sale. Así la siguiente petición del servidor principal recibe el aviso (una pausa normal de 45 s, sin fallo ni cortacircuitos) y no un puerto cerrado.
- **Límite más alto:** `SCRAPER_RECYCLE_RSS_MB` pasa de 700 a **850 MB** (reciclado cada ~2,5 h en vez de ~2 h). El contenedor sigue en 2 GiB.
