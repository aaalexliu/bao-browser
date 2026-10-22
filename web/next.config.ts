import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: path.join(__dirname) },
  serverExternalPackages: ["@electric-sql/pglite", "@neondatabase/serverless", "pg"],
};

export default nextConfig;
