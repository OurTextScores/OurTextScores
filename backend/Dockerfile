# syntax=docker/dockerfile:1

FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    QT_QPA_PLATFORM=offscreen
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
        fossil && \
    pip3 install --no-cache-dir \
        linearized-musicxml \
        musicdiff \
        imslp \
        PyPDF2 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

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

EXPOSE 4000
CMD ["node", "dist/main.js"]
