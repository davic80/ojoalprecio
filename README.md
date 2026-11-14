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
| `AMAZON_AFFILIATE_TAG` | ID de seguimiento de Amazon Afiliados que lleva cada enlace saliente (`tag=`) | `ojoalprecio0d-21` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciales OAuth para «Continuar con Google» (sin ellas el botón no aparece) | — |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Captcha de Cloudflare Turnstile en el formulario de registro (se exige solo si están las dos) | — |
| `PASSWORD_SIGNUP` | `off` cierra el registro con email y contraseña (solo se crean cuentas con Google) | `on` |
| `SESSION_COOKIE_SECURE` | Cookies seguras (HTTPS) | `true` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token del tunnel Cloudflare | — |
| `CHECK_INTERVAL_CRON` | Cron de comprobación de precios | `0 * * * *` (cada hora) |
| `SMTP_HOST` | Servidor SMTP | `smtp.gmail.com` |
| `SMTP_PORT` | Puerto SMTP | `587` |
| `SMTP_USER` | Usuario SMTP | — |
| `SMTP_PASSWORD` | Contraseña SMTP / App Password | — |
| `SMTP_FROM` | Dirección de envío | igual que `SMTP_USER` |

## Acceso con Google

Flujo OpenID Connect (código de autorización con PKCE, `state` y `nonce`); la firma del `id_token` se verifica con las claves públicas de Google y se exige `email_verified`.

- Misma cuenta si coincide el email: quien ya tenía usuario y entra con Google sigue siendo el mismo usuario (una persona, una cuenta). Si la cuenta antigua **no** tenía el email verificado, se descarta su contraseña (nadie había probado ser el dueño del correo; es lo que dejan los bots de registro) y se cancelan los enlaces de verificación y de restablecimiento pendientes.
- Quien llega nuevo con Google entra directamente, con la cuenta ya verificada y sin correo de verificación.
- Las cuentas creadas con Google no tienen contraseña (`password_set = false`); se puede crear una desde «Mi cuenta» y Google sigue funcionando.
- Configuración en Google Cloud: pantalla de consentimiento «Externo» publicada en producción, cliente OAuth «Aplicación web» con la URI de redirección `https://<dominio>/auth/google/callback`.

## Tallas y colores (variantes)

Cada talla o color de un artículo es **un producto propio** (su ASIN, su historial, sus seguidores y sus avisos), pero se muestran agrupados como en Amazon:

- Un grupo (`product_groups`) reúne las opciones de un artículo; cada producto guarda su nombre dentro del grupo (`variant_label`, p. ej. `Lona Azul · 43 EU`).
- El scraper lee el selector de Amazon (swatches de color y el desplegable de tallas) y el ASIN padre.
- El panel, `/ofertas`, las categorías y el buscador muestran **una tarjeta por artículo**; la ficha tiene un selector de opciones con el precio de cada una.
- Al añadir un producto se lee primero **su** opción; las demás se descubren solo si alguien sigue el producto, solo las que Amazon ofrece y con un tope por lectura, y se revisan después de las demás.
- En el campo de alta se acepta una URL, un ASIN suelto (`B0DJC3WYTP`) o un id de AliExpress.

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
