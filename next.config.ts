import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image builds a self-contained server; `npm start` uses the regular one.
  output: process.env.STANDALONE ? "standalone" : undefined,
  // The marketing page is a hand-built static file; serve it at the root.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/landing.html" }] };
  },
  experimental: { serverActions: { bodySizeLimit: "12mb" } },
};

export default nextConfig;
