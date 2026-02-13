# syntax=docker/dockerfile:1

FROM ubuntu:22.04 AS base

ARG MUSESCORE4_APPIMAGE_URL="https://github.com/musescore/MuseScore/releases/download/v4.6.3/MuseScore-Studio-4.6.3.252940956-x86_64.AppImage"
ARG MUSESCORE_CLI=musescore4
ENV DEBIAN_FRONTEND=noninteractive \
    QT_QPA_PLATFORM=offscreen \
    MUSESCORE_EXPORT_TIMEOUT_MS=300000 \
    MUSESCORE_WRAPPER_TIMEOUT_SECONDS=300 \
    MUSESCORE_CLI=${MUSESCORE_CLI}
WORKDIR /app

# Install Node.js 20, MuseScore CLI, Python tooling, and helper utilities
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends \
        nodejs \
        python3 \
        python3-pip \
        unzip \
        git \
        musescore3 \
        xvfb \
        libopengl0 \
        ca-certificates \
        libpipewire-0.3-0 \
        fossil && \
    pip3 install --no-cache-dir \
        imslp \
        PyPDF2 && \
    apt-get install -y --no-install-recommends poppler-utils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install MuseScore 4 CLI via AppImage at build time.
# Solution from: https://markandruth.co.uk/2024/09/08/running-musescore-from-within-a-docker-container
# Key insight: Must extract AppImage and run the binary directly (not via AppRun wrapper)
RUN if [ -n "$MUSESCORE4_APPIMAGE_URL" ]; then \
      echo "Downloading MuseScore 4 AppImage from ${MUSESCORE4_APPIMAGE_URL}" && \
      curl -fsSL "${MUSESCORE4_APPIMAGE_URL}" -o /tmp/MuseScore-4.AppImage && \
      chmod +x /tmp/MuseScore-4.AppImage && \
      /tmp/MuseScore-4.AppImage --appimage-extract && \
      mv squashfs-root /opt/musescore4 && \
      printf '%s\n' \
        '#!/bin/sh' \
        '# Wrapper for MuseScore 4 with timeout and proper xvfb settings.' \
        '# The binary must be called directly (not via AppRun) for CLI to work properly.' \
        'TIMEOUT_SECONDS="${MUSESCORE_WRAPPER_TIMEOUT_SECONDS:-300}"' \
        'if [ "${TIMEOUT_SECONDS}" = "0" ]; then' \
        '  exec xvfb-run -a -s "-screen 0 640x480x24 -ac +extension GLX +render -noreset" /opt/musescore4/bin/mscore4portable "$@"' \
        'fi' \
        'exec timeout "${TIMEOUT_SECONDS}" xvfb-run -a -s "-screen 0 640x480x24 -ac +extension GLX +render -noreset" /opt/musescore4/bin/mscore4portable "$@"' \
      > /usr/local/bin/musescore4 && \
      chmod +x /usr/local/bin/musescore4 && \
      rm -f /tmp/MuseScore-4.AppImage; \
    fi

FROM base AS deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
COPY --from=build /app/python ./python
COPY --from=build /app/scripts ./scripts

EXPOSE 4000
CMD ["node", "dist/main.js"]
