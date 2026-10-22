import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page shows live, per-organizer distribution state, so nothing is
  // cached or prerendered: all reads hit PostgreSQL at request time.
  serverExternalPackages: ["pg"],
  experimental: {
    serverActions: {
      // CSV imports send the mapped rows to the server for validation.
      bodySizeLimit: "4mb",
    },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
