import type { NextConfig } from "next";
import { securityHeaderEntries } from "./security-headers";

const isDevelopment = process.env.NODE_ENV === "development";
const securityHeaders = securityHeaderEntries(isDevelopment);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
