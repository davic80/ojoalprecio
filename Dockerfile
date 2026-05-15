# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Lockfile was generated with npm 11 (esbuild optionalDependencies layout
# differs from npm 10). Bump npm before `npm ci` to keep parse compatible.
RUN npm install -g npm@11

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS production

# Install Chromium from system packages — much lighter than Playwright's bundled
# Chromium, and has native arm64 support for Raspberry Pi.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       libappindicator3-1 \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcairo2 \
       libcups2 \
       libdbus-1-3 \
       libexpat1 \
       libfontconfig1 \
       libgbm1 \
       libglib2.0-0 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libpangocairo-1.0-0 \
       libx11-6 \
       libx11-xcb1 \
       libxcb1 \
       libxcomposite1 \
       libxcursor1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxi6 \
       libxrandr2 \
       libxrender1 \
       libxss1 \
       libxtst6 \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium instead of downloading its own binary
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Same npm version bump as the build stage
RUN npm install -g npm@11

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output, views, and static assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/views ./dist/views
COPY public/ ./public/

# Non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser -m appuser
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://localhost:3000/auth/login', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

# Build-time args (passed by GitHub Actions)
ARG GIT_COMMIT=dev
ARG APP_VERSION=1.0.0

ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    APP_VERSION=${APP_VERSION}

CMD ["node", "dist/index.js"]
