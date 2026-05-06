# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.30.0] - 2026-05-02

### Added
- Captura del `was_price` (precio recomendado / tachado de Amazon) durante el scrape — se guarda en la columna `was_price` de `products`
- Las listas de recomendación muestran el precio recomendado tachado y el porcentaje de ahorro calculado sobre ese precio (no sobre el máximo histórico)
- Migración 28: columna `was_price NUMERIC(10,2)` en `products`

### Changed
- Editor de listas de admin: sustituido el `<select>` con 590+ productos por un campo de búsqueda live con debounce 220 ms — muestra hasta 20 resultados filtrados por nombre, ASIN o ID
- Nuevo endpoint `GET /admin/lists/:id/search-products?q=` que excluye productos ya en la lista

## [2.29.1] - 2026-05-02

### Fixed
- Scraper: detección de bloqueo ampliada — además de comprobar el título, se verifica que `#dp` / `#dp-container` sea visible en 2 s; si no lo es, se considera bloqueo independientemente del texto de la página
- Scraper: al detectar un bloqueo se resetea `_storageStatePromise` a `null` para no arrastrar cookies envenenadas en scrapes posteriores
- Scraper: `getBrowser()` lanza `CaptchaDetectedError` durante el cooldown de captcha (antes lanzaba `Error` genérico, lo que incrementaba `consecutive_failures` erróneamente)
- Scraper: `image` y `font` eliminados de `BLOCKED_TYPES` — bloquearlos era una señal de bot que aumentaba la tasa de captchas

## [2.29.0] - 2026-05-06

### Fixed
- Scraper: `--js-flags` de Chromium pasaba comillas literales (`"--max-old-space-size=256"`) que Chromium ignoraba — corregido a `--js-flags=--max-old-space-size=256`
- Scraper: `timeoutHandle` tipado como `any` — cambiado a `ReturnType<typeof setTimeout> | null` para que `npm run build` pase en GitHub Actions
- Scraper: `route.continue()` sin `return` en `optimizePageForScraping` — bajo concurrencia alta Playwright lanzaba "Route is already handled!"

### Summary (v2.28–2.29)
- **Carga Crítica (CPU & Red):** Chromium args `--disable-features=IsolateOrigins,site-per-process` y `--js-flags=--max-old-space-size=256`; interceptación de rutas para abortar `image`, `font`, `media`, `other`, `ping`, `beacon`; blacklist de dominios de telemetría Amazon
- **Higiene de Procesos:** `page.close({ runBeforeUnload: false })` en todos los `finally`; `LOCATOR_TIMEOUT_MS` a 10s; tipado estricto de `timeoutHandle`
- **Anti-Bloqueo (Captcha Cooldown):** variable global `captchaDetectedAt`; pausa de 10 min en `getBrowser()` si se detecta captcha; detección de "Robot Check" / "Introduce los caracteres"

## [2.27.0] - 2026-05-02

### Added
- Detección de oferta por tiers basada en el máximo histórico de todos los tiempos (no ventana de 3 días)
- Columna `sale_tier` (`oferta` / `super-oferta` / `mega-oferta` / `broooooferton` / `67oferta`) en `products`
- Columna `deal_score` (porcentaje de descuento sobre el máximo histórico, 1 decimal) en `products`
- Mínimo de datos requerido: ≥5 scrapes, ≥2 días de historia y al menos una bajada real respecto al máximo histórico

### Changed
- Referencia para detección de oferta cambiada de máximo de 3 días → máximo histórico de todos los tiempos
- Tiers: `oferta` 7–15% · `super-oferta` 15–30% · `mega-oferta` 30–50% · `broooooferton` 50–67% · `67oferta` >67%
- `is_public` es control exclusivo del admin — el scheduler ya no lo modifica nunca
- Migración 27 reinicia `is_on_sale` a FALSE en todos los productos; el scheduler recalcula con la nueva lógica en el siguiente ciclo

## [2.26.0] - 2026-05-02

### Added
- Variable de entorno `RETRY_FAILED_PER_CYCLE` (por defecto 30): al inicio de cada ciclo, hasta N productos marcados como `is_failed` se re-encolan automáticamente para reintento (ordenados por `id ASC` para drenar el backlog de forma predecible)
- Con 30/ciclo y cron horario, 512 productos fallidos se recuperan en ~17 ciclos (~17 horas)
- Poner a 0 deshabilita el reintento automático

## [2.25.0] - 2026-05-02

### Added
- Variable de entorno `SCRAPER_TIMEOUT_SECONDS` (valor en **segundos**, por defecto 25, mínimo 10)
- Constantes de timeout con nombres declarativos: `HARD_TIMEOUT_MS`, `PAGE_LOAD_TIMEOUT_MS`, `LOCATOR_TIMEOUT_MS`, `PRICE_SELECTOR_WAIT_MS`, `PRICE_LOCATOR_TIMEOUT_MS`
- Logs con prefijo identificador por tipo de timeout: `[hard_timeout]`, `[page_load_timeout]`, `[locator_timeout]`, `[price_selector_timeout]`, `[price_locator_timeout]`

### Changed
- Variable de entorno renombrada `SCRAPER_TIMEOUT_MS` → `SCRAPER_TIMEOUT_SECONDS` — actualizar `.env` en Raspberry Pi

## [2.13.0] - 2026-05-02

### Added
- Dashboard (admin): botón ↺ por cada card para actualizar el precio manualmente sin esperar el ciclo
- Dashboard (admin): contador de fallos — `N/3` (consecutivos) y `N tot` (totales históricos) visible en cada card; en rojo si el producto está marcado como fallido
- Dashboard: 6 pills de filtro siempre visibles (Con precio / Sin scrapear / En oferta / Con error / Fallidos / Sin stock) — cada pill filtra la lista al clicar
- Tracking: `utm_source=telegram` y `utm_source=email` añadidos a todos los links de notificación (bot, canal, emails de alerta y back-in-stock)
- Migración 26: columna `total_failures INTEGER DEFAULT 0` en `products` — acumula fallos de por vida sin resetearse

### Changed
- Dashboard: botón Eliminar reducido a × rojo (sin texto)

### Fixed
- Tracking: visitas desde Telegram y email aparecían como "Directo" por falta de header `Referer` — corregido con fallback a `utm_source`
- Dashboard: stats (`onSale`, `failed`, `withError`) devolvían 0 por confusión camelCase/snake_case en el filtro JS
- Dashboard: contador de fallos no aparecía si `totalFailures = 0` aunque hubiera `consecutiveFailures > 0`
- Producto (admin): UX del botón de actualizar manual mejorada — se deshabilita durante la carga y muestra "Actualizando…"

## [2.12.0] - 2026-05-02

### Added
- Tracking de fuente de tráfico (`source`): Telegram, Google, Bing, Instagram, Twitter/X, Directo, Otro — detectado desde el header `Referer` con fallback a `utm_source`
- Tracking de dispositivo (`device_type`): Escritorio, Móvil, Tablet, Bot — detectado desde `User-Agent` sin dependencias externas
- Navegación interna (mismo dominio) no se registra para no inflar "Otro"
- Admin Stats: nueva sección "Fuentes y dispositivos" con dos tablas en grid (fuentes excluyen bots; dispositivos muestran bots por separado con porcentajes)
- Migración 25: columnas `source` y `device_type` en `page_views`; clave primaria ampliada a `(path, day, source, device_type)`

## [2.11.5] - 2026-05-01

### Added
- Admin Stats: variable de entorno `MIN_AGE_MS_MINUTES` (minutos mínimos entre scrapes de un producto, por defecto 59) — documentada en `.env.example` y `docker-compose.yml`
- Admin Stats: gráfica de visitas y de alertas muestran el valor máximo sobre el eje Y
- Admin Stats: tooltip flotante en ambas gráficas con fecha formateada en español (ej. "1 may 2026") y número de eventos al pasar el cursor
- Admin Stats: barras con cero eventos se renderizan con altura 0 (antes siempre 2 px mínimo, lo que hacía el gráfico visualmente incorrecto)

## [2.11.4] - 2026-05-01

### Added
- Scrape widget: muestra "X/Y · Z total" en el botón — X=hechos, Y=pendientes en el ciclo actual, Z=productos activos totales
- Scrape widget: el dropdown explica "X/Y en este ciclo (Z activos en total)" para eliminar la confusión entre productos del ciclo y productos totales

## [2.11.3] - 2026-05-01

### Fixed
- Docker: `init: true` en el servicio app — tini actúa como PID 1 y reap correctamente los procesos Chromium zombies que quedan al reciclar el browser

## [2.11.2] - 2026-05-01

### Fixed
- Social: cron ahora usa `timezone: 'Europe/Madrid'` — los posts se publican a las 9:00, 13:00 y 21:00 hora española, correctos tanto en verano (UTC+2) como en invierno (UTC+1)

## [2.11.1] - 2026-05-01

### Changed
- Social: horarios de publicación cambiados a 8:00, 13:00 y 21:00 (antes 9:05, 13:05, 21:05)

### Added
- Social: contador regresivo en tiempo real en `/admin/social` — muestra la hora del próximo post y cuánto falta (HH:mm:ss)

## [2.11.0] - 2026-05-01

### Added
- Detección de productos fallidos: tras 3 errores consecutivos de scraping el producto se marca como `is_failed = true` y se excluye del ciclo automático
- Badge "Fallido" (rojo) en las cards del dashboard y filtro "Fallidos" en el selector de estado
- Contador de fallidos en la barra de stats del dashboard
- El estado se limpia automáticamente en el primer scraping exitoso (manual o automático tras reactivación)
- Migración 24: columnas `consecutive_failures` e `is_failed` en la tabla `products`

## [2.10.1] - 2026-05-01

### Fixed
- Dashboard: eliminado enlace "Stats" del navbar — solo debe aparecer dentro de la sección admin

## [2.10.0] - 2026-05-01

### Added
- Admin: página `/admin/users` con listado de todos los usuarios registrados — email, estado de verificación, Telegram, productos seguidos, alertas activas / totales y notificaciones recibidas
- Admin: enlace "Usuarios" añadido al navbar de todas las vistas de administración

### Performance
- Scraper: `--disable-gpu-compositing` y `--disable-software-rasterizer` en args de Chromium — elimina el proceso GPU (swiftshader), ahorra ~100 MB RSS y ~1.5% CPU constante
- Scraper: concurrencia por defecto subida a 3 workers (antes 5 en código, 2 recomendado para Pi 4)
- Scheduler: intervalo por defecto cambiado a cada hora (`0 * * * *`) y MIN_AGE_MS a 59 min

## [2.9.2] - 2026-05-01

### Performance
- Scraper: browser Chromium compartido entre todos los productos del ciclo (antes se lanzaba y destruía uno por producto — mayor reducción de carga)
- Scraper: sesión Amazon (`storageState`) obtenida una sola vez por ciclo de browser, reutilizada en todos los contextos (elimina visita a amazon.es por producto)
- Scraper: bloqueo ampliado a `image`, `font`, `media` y `stylesheet` — los atributos `src` de imágenes siguen disponibles en el DOM
- Scraper: timeout duro de 45s por producto para evitar workers bloqueados indefinidamente
- Scraper: `page` y `context` siempre cerrados en bloque `finally`, incluso con error
- Scraper: `closeBrowser()` llamado en SIGTERM/SIGINT para cierre limpio del proceso
- Scraper: browser se recicla automáticamente cada 120 productos para evitar memory leaks

## [2.6.3] - 2026-04-30

### Added
- Mejores chollos: muestra hasta 100 productos (antes 50) con filtros por categoría, visibilidad (público/privado) y "solo mínimo histórico"
- Footer con enlace al canal de Telegram en todas las páginas públicas (product, category, dashboard) y emails
- Email de bienvenida: enlace al canal de Telegram en la lista de funciones y en el footer
- Email de alerta de precio: enlace al canal de Telegram en el footer

### Fixed
- Navbar de admin Chollos: añadido enlace a Social

## [2.6.2] - 2026-04-30

### Fixed
- Correo de alerta de precio: emoji 👁 en cabecera y asunto, imagen y título del producto enlazados a Amazon, muestra la bajada en % y euros vs precio anterior, botón "Ver historial" lleva a la ficha del producto en OjoAlPrecio, enlace "Gestionar mis alertas" apunta a /account

## [2.6.1] - 2026-04-30

### Added
- Dashboard: filtro "Con precio" (oculta productos sin scrapear) y filtro "Sin scrapear" (muestra solo los pendientes)
- Admin Stats: sección de estadísticas de alertas — totales por canal (email / Telegram / ambos), gráfico de barras de los últimos 30 días, top productos y top usuarios por alertas recibidas

### Fixed
- Filtros del dashboard: eliminado HTMX `hx-target="body"` que fallaba silenciosamente en HTMX 2.x; reemplazado por formulario GET nativo con auto-submit `onchange` y debounce JS para el buscador de texto

## [2.5.0] - 2026-04-30

### Added
- Dashboard: filtro "Sin scrapear" para ver productos que aún no tienen historial de precios
- Email de bienvenida enviado automáticamente al verificar la cuenta, con CTA para añadir el primer producto

## [2.4.0] - 2026-04-30

### Added
- Dashboard (admin): selección múltiple de productos con checkboxes, botones "Todos" / "Ninguno", arrastrar para seleccionar, y asignación masiva de categoría desde la barra de acción
- Ficha de producto: imagen, título y caja "Precio actual" son ahora enlaces a Amazon.es

### Fixed
- Badges de producto (Oferta, Precio mínimo, Sin stock) movidos al pie de la imagen con overlay de ancho completo — ya no se cortan con la imagen de 72×72 px
- Pequeño margen izquierdo en la etiqueta de categoría de las tarjetas de producto
- GitHub Actions: opt-in a Node.js 24 para eliminar warnings de deprecación
- Correo electrónico: el campo SMTP_FROM ya estaba desacoplado de SMTP_USER; `.env.example` actualizado para documentar configuración con Resend (dominio @ojoalprecio.com)

## [2.3.0] - 2026-04-30

### Added
- Página "Mi cuenta" en `/account`: cambio de contraseña (con validación de contraseña actual) y listado completo de alertas con acciones de reactivar y eliminar
- El email del usuario en la barra de navegación es ahora un enlace a `/account` en todas las páginas

## [2.2.0] - 2026-04-29

### Fixed
- El admin ya puede acceder a la ficha de cualquier producto (incluyendo los importados por el sistema): `/products/:id`, refresh, toggle-public, set-category y delete ya no filtran por `user_id` cuando el usuario es admin

## [2.1.0] - 2026-04-29

### Added
- Contador de páginas vistas (solo admin): middleware fire-and-forget registra visitas en tabla `page_views` (path + día); `/admin/stats` muestra total, gráfico de barras de los últimos 30 días y top 20 páginas
- Enlace "Stats" en la barra de navegación del admin y del dashboard (solo para admin)

### Fixed
- Scheduler de importación de categorías: `ORDER BY last_imported_at ASC NULLS FIRST` — antes los NULL iban al final (comportamiento por defecto de PostgreSQL), haciendo que siempre se escogiera la misma categoría ya importada en lugar de rotar por las que aún no tenían fecha

## [2.0.0] - 2026-04-28

### Added
- URLs limpias para categorías: `/c/:slug` (ej. `/c/foto`) — página pública con todos los productos en oferta de esa categoría
- Sistema de listas de recomendación: rutas `/:slug` en la raíz (ej. `/alberto`) muestran una lista curada de productos con notas opcionales y enlace a Amazon
- Panel admin en `/admin/lists` para crear, editar y eliminar listas; `/admin/lists/:id` para añadir/quitar productos con nota y ver precio actual
- Migración 19: tablas `recommendation_lists` y `recommendation_items`
- Nav admin actualizado: enlace "Listas" en todas las páginas de administración

### Changed
- Los tags de categoría en las tarjetas del dashboard ahora enlazan a `/c/:slug` en lugar de `/?category=ID`
- Los nombres de categoría en la página de admin ahora enlazan a `/c/:slug`
- El slug de la categoría se incluye en la consulta del dashboard

## [1.11.0] - 2026-04-29

### Added
- Página de producto: diferencia del precio actual al mínimo histórico en el stat box ("+X € vs mínimo (Y%)") y badge "Precio mínimo histórico" cuando está en el suelo
- Página de producto: tabla de últimos 50 registros con highlight verde para el precio mínimo y naranja para el máximo, y columna de variación registro a registro
- Auto-import de categorías Amazon: cada hora a las :10 se escanea la categoría menos reciente de `amazon_category_sources` y se añaden hasta 40 productos nuevos, uno por minuto
- Función `scrapeAmazonCategory()` en el scraper — extrae hasta N ASINs de cualquier página de Amazon.es (bestsellers, búsquedas, etc.)
- Tabla `amazon_category_sources` con 10 categorías de Amazon.es preconfiguradas (Electrónica, Informática, Hogar, Deportes, Juguetes, Cámara, Bricolaje, Salud, Ropa, Jardín)
- Usuario sistema `system@ojoalprecio.local` como propietario de los productos auto-importados

## [1.10.2] - 2026-04-29

### Fixed
- Scraper: detección más precisa de bloqueos de Amazon — cubre signin redirect, 503, validateCaptcha en URL y errores de CAPTCHA en subdirectorios; el mensaje de error ahora incluye la URL/título de la página recibida para facilitar el diagnóstico

## [1.10.1] - 2026-04-29

### Fixed
- Productos que suben de precio se auto-despublican (`is_public = false`) en el siguiente scrape; cuando vuelven a bajar se republican automáticamente

## [1.10.0] - 2026-04-29

### Added
- Mini sparkline SVG de tendencia de precio en cada card de /ofertas (verde si baja, rojo si sube)
- Carrusel automático de imágenes en hover: hasta 3 fotos cada 2 s (sólo si el scraper obtiene más de una imagen)
- El scraper extrae hasta 2 imágenes extra del panel #altImages de Amazon y las guarda en `extra_images`

### Removed
- ASIN y número de registros eliminados de las cards de /ofertas

## [1.9.0] - 2026-04-28

### Added
- Category tags on dashboard cards are now clickable links — filters the product list by that category in one click
- Price change badges on dashboard cards now show both percentage and euro delta (e.g. ↓ 5.2% · −3.40 €)
- Chart tooltip on the product detail page shows delta vs the previous data point (e.g. 29.99 €   −3.00 € (−9.1%)) — works on tap on mobile via Chart.js touch support
- "Variación" column in the last records table shows price delta per row — always visible with no interaction required, ideal for mobile
- Category filter on /ofertas: clicking a category hides the rest client-side; a "Todas" button resets the view

## [1.8.0] - 2026-04-27

### Added
- Forgot / reset password flow via email token

### Fixed
- Responsive grid on /ofertas — more columns on wider screens, correct lateral padding on mobile
- Product grid on /ofertas properly centered with flexbox

## [1.7.0] - 2026-04-27

### Added
- Email verification step on register — users must confirm their address before accessing the dashboard
- /ofertas is now the public landing page, showing all published products sorted by sale status

### Fixed
- Preserve dots in Gmail addresses during email normalisation (foo.bar@gmail.com no longer collapsed to foobar@gmail.com)
- Error page now shows the actual error message instead of a generic title

## [1.6.0] - 2026-04-27

### Added
- Dashboard sort by price (high → low, low → high) and by highest discount percentage
- Search, category filter, status filter, and per-page selector on the dashboard — all driven by htmx with URL push
- Pagination for the product list
- Alert history tab on the product detail page
- Wishlist import from a public Amazon wishlist URL (admin only)

## [1.5.0] - 2026-04-27

### Added
- Skip scrape on restart if the last recorded price is less than 59 minutes old — avoids redundant requests after container restarts
- Manual product refresh button restricted to admin users only

### Fixed
- APP_VERSION no longer overridden in docker-compose — value is baked into the image at build time
- Unified auto-tag and Docker build into a single GitHub Actions workflow

## [1.4.0] - 2026-04-27

### Added
- Sale detection: a product is marked on sale when its price drops more than 7% from the 3-day maximum (previously used the all-time maximum)
- Products are automatically published to /ofertas when marked as on sale
- Minimum price badge now requires at least 360 recorded data points before being shown

### Fixed
- Backfill `is_on_sale` flag from existing price history on application startup
- /ofertas now shows all public products, with on-sale items sorted first

## [1.3.0] - 2026-04-27

### Added
- Inline category management from the product detail page — create and assign categories without leaving the page
- Minimum price stat now shows the date tracking started
- Back-in-stock alert type: notifies when an unavailable product becomes available again, regardless of price

## [1.2.0] - 2026-04-26

### Added
- Smart dashboard with sparklines, trend badges, and price range (min / max) per product card
- Advanced alert types: fixed price threshold, percentage drop from current price, all-time low, back in stock
- Public product pages at /p/:asin — shareable price history for any product marked as public
- Curated category system with slug-based grouping on /ofertas
- Stock detection: products marked as unavailable when Amazon returns no price

### Fixed
- Affiliate tag `canidrone-21` appended to all Amazon product links
- Removed false-positive CAPTCHA detection triggered by the word "robot" in product descriptions
- Resolved product add failures caused by session handling, scraper timing, and incorrect HTMX target
- EJS views now correctly copied into dist/ during Docker build

## [1.1.0] - 2026-04-27

### Added
- Automatic GitHub release tag on every push to main
- Application version displayed in the footer on all pages (sourced from `APP_VERSION` env var baked at build time)

## [1.0.1] - 2026-04-23

### Fixed
- Host port is now configurable via the `HOST_PORT` environment variable (default: `8080`) to avoid conflicts with other services on the host

## [1.0.0] - 2026-04-16

### Added
- Amazon.es price tracking via Playwright with system Chromium
- Multi-user authentication: register, login, logout
- Hourly price scraping with configurable cron interval
- Full price history stored in PostgreSQL
- Interactive price history chart (Chart.js + date-fns adapter)
- Email alerts via SMTP when price drops below a configurable threshold
- Alert reset and reactivation flow
- Manual product refresh button
- Docker multi-arch image (linux/amd64 + linux/arm64) published to GHCR
- Cloudflare Tunnel support via `cloudflared` sidecar container
- GitHub Actions CI/CD pipeline with automated build and push
