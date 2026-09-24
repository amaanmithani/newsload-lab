import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Compression is the edge's job; serving identity bodies keeps the three lab
  // configurations comparable byte-for-byte.
  compress: false,
  // Cap the stale-while-revalidate window Next.js advertises on ISR pages
  // (default is one year). The edge proxy honours this header.
  expireTime: 300,
};

export default nextConfig;
