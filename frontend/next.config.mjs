/** @type {import('next').NextConfig} */
const SCORE_EDITOR_API_ORIGIN = process.env.SCORE_EDITOR_API_ORIGIN?.trim();

// Where the /api and /files rewrites point. Inside Docker the defaults resolve
// by service name; a host-run `npm run dev` sets INTERNAL_API_URL (see
// .env.local) and MINIO_PROXY_ORIGIN so the browser's /api calls reach the
// published ports instead of 500ing on an unresolvable `backend` host.
const BACKEND_ORIGIN = (process.env.INTERNAL_API_URL?.trim() || 'http://backend:4000/api').replace(/\/api\/?$/, '');
const MINIO_ORIGIN = process.env.MINIO_PROXY_ORIGIN?.trim() || 'http://minio:9000';

const nextConfig = {
  reactStrictMode: true,
  // Long-running upload+conversion requests can exceed Next's default proxy timeout (30s).
  // Keep rewrite proxying alive long enough for heavy MuseScore conversions.
  experimental: {
    proxyTimeout: 15 * 60 * 1000, // 15 minutes
  },
  async redirects() {
    // The benchmark write-ups were plain markdown files; they are pages now.
    return [
      {
        source: '/benchmarks/public-core-vs-upstream-20260928.md',
        destination: '/ots-homr/benchmark',
        permanent: false,
      },
      {
        source: '/benchmarks/public-core-vs-upstream-20260928-protocol.md',
        destination: '/ots-homr/benchmark/method',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    const rewrites = [
      // Editor API proxy. /api/score-editor/music/* and /llm/* are handled by
      // route handlers (app/api/score-editor/{music,llm}/[...segments]) so they
      // can inject the app auth token; only fetch-score remains a plain rewrite.
      ...(SCORE_EDITOR_API_ORIGIN
        ? [
            {
              source: '/api/score-editor/fetch-score',
              destination: `${SCORE_EDITOR_API_ORIGIN}/api/fetch-score`,
            },
          ]
        : []),
      // MinIO file access
      {
        source: '/files/:bucket/:path*',
        destination: `${MINIO_ORIGIN}/:bucket/:path*`,
      },
      // Proxy to backend API, but EXCLUDE Next.js API routes (/api/auth/*, /api/proxy/*,
      // and /api/score-editor/* which is handled by local proxy routes and explicit rewrites above).
      // This uses a negative lookahead regex to skip routes that Next.js should handle
      {
        source: '/api/:path((?!auth|proxy|score-editor).*)*',
        destination: `${BACKEND_ORIGIN}/api/:path*`,
      },
    ];
    return rewrites;
  },
};

export default nextConfig;
