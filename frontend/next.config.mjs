/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/files/:bucket/:path*',
        destination: 'http://minio:9000/:bucket/:path*',
      },
    ];
  },
};

export default nextConfig;
