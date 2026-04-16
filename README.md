# OjoAlPrecio

Seguimiento de precios en Amazon.es con historial gráfico y alertas por email.

## Características

- Añade artículos de Amazon.es por URL
- Comprueba precios automáticamente según un intervalo configurable (por defecto cada hora)
- Historial de precios almacenado en PostgreSQL con gráfica interactiva (Chart.js)
- Alertas por email cuando el precio baja de tu umbral (SMTP genérico / Gmail)
- Multi-usuario: registro y login propio
- Imagen Docker multi-arch (`linux/amd64` + `linux/arm64`) → Raspberry Pi nativa
- Cloudflare Tunnel integrado para acceso externo sin abrir puertos

## Requisitos previos

- Docker y Docker Compose
- Una cuenta de Cloudflare (para el tunnel, opcional pero recomendado)
- Un token de acceso a la imagen en GHCR (si el repositorio es privado)

## Instalación en Raspberry Pi

```bash
# 1. Clona el repositorio (o descarga solo docker-compose.yml + .env.example)
git clone https://github.com/davic80/ojoalprecio.git
cd ojoalprecio

# 2. Crea el fichero de entorno
cp .env.example .env
# Edita .env con tus credenciales

# 3. Arranca los contenedores
docker compose pull
docker compose up -d

# 4. Consulta los logs
docker compose logs -f app
```

La aplicación estará disponible en `http://<ip-raspberry>:3000`.

## Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `POSTGRES_PASSWORD` | Contraseña PostgreSQL | **obligatorio** |
| `SESSION_SECRET` | Secreto de sesión (aleatorio) | **obligatorio** |
| `SITE_URL` | URL pública de la app | `http://localhost:3000` |
| `SESSION_COOKIE_SECURE` | Cookies seguras (HTTPS) | `true` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token del tunnel Cloudflare | — |
| `CHECK_INTERVAL_CRON` | Cron de comprobación de precios | `0 * * * *` (cada hora) |
| `SMTP_HOST` | Servidor SMTP | `smtp.gmail.com` |
| `SMTP_PORT` | Puerto SMTP | `587` |
| `SMTP_USER` | Usuario SMTP | — |
| `SMTP_PASSWORD` | Contraseña SMTP / App Password | — |
| `SMTP_FROM` | Dirección de envío | igual que `SMTP_USER` |

## Actualizar a una nueva versión

```bash
docker compose pull
docker compose up -d
```

O fijar una versión concreta:

```bash
IMAGE_TAG=1.1.0 docker compose up -d
```

## Desarrollo local

```bash
npm install
# Levanta solo PostgreSQL
docker compose up postgres -d
# Copia el .env y ajusta DATABASE_URL a localhost
cp .env.example .env
npm run dev
```

## Licencia

MIT
