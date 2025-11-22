/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
