/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Long-running upload+conversion requests can exceed Next's default proxy timeout (30s).
  // Keep rewrite proxying alive long enough for heavy MuseScore conversions.
  experimental: {
    proxyTimeout: 15 * 60 * 1000, // 15 minutes
  },
  async rewrites() {
    return [
      // MinIO file access
      {
        source: '/files/:bucket/:path*',
        destination: 'http://minio:9000/:bucket/:path*',
      },
      // Proxy to backend API, but EXCLUDE Next.js API routes (/api/auth/* and /api/proxy/*)
      // This uses a negative lookahead regex to skip routes that Next.js should handle
      {
        source: '/api/:path((?!auth|proxy).*)*',
        destination: 'http://backend:4000/api/:path*',
      },
    ];
  },
};

export default nextConfig;
