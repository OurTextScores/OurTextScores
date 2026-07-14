/** @type {import('next').NextConfig} */
const SCORE_EDITOR_API_ORIGIN = process.env.SCORE_EDITOR_API_ORIGIN?.trim();

const nextConfig = {
  reactStrictMode: true,
  // Long-running upload+conversion requests can exceed Next's default proxy timeout (30s).
  // Keep rewrite proxying alive long enough for heavy MuseScore conversions.
  experimental: {
    proxyTimeout: 15 * 60 * 1000, // 15 minutes
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
        destination: 'http://minio:9000/:bucket/:path*',
      },
      // Proxy to backend API, but EXCLUDE Next.js API routes (/api/auth/*, /api/proxy/*,
      // and /api/score-editor/* which is handled by local proxy routes and explicit rewrites above).
      // This uses a negative lookahead regex to skip routes that Next.js should handle
      {
        source: '/api/:path((?!auth|proxy|score-editor).*)*',
        destination: 'http://backend:4000/api/:path*',
      },
    ];
    return rewrites;
  },
};

export default nextConfig;
