# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
