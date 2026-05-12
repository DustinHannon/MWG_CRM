# Phase 29 §7 — Dockerfile for running the ClickDimensions extraction
# script on AZ-UTIL-AICHAT or any Linux host with X-forwarding. The
# script runs headed by design (operator completes MFA interactively).

FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Install deps first for cache friendliness.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy the rest of the source.
COPY tsconfig.json ./
COPY src ./src

# Default command: build, then prompt for the operator to choose
# `auth` or `extract`. Override with `docker run … npm run extract`.
CMD ["npm", "run", "extract"]
