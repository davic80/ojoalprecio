# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-04-14

### Added
- Initial release of OjoAlPrecio
- Amazon.es price tracking via Playwright + system Chromium
- Multi-user authentication (register / login / logout)
- Hourly price scraping with configurable cron interval
- Price history stored in PostgreSQL
- Interactive price history chart (Chart.js + date-fns adapter)
- Email alerts via SMTP when price drops below a configurable threshold
- Alert reset/reactivation flow
- Manual product refresh button
- Docker multi-arch image (linux/amd64 + linux/arm64) published to GHCR
- Cloudflare Tunnel support via `cloudflared` container
- GitHub Actions CI/CD pipeline mirroring yt2mp3 release scheme
