import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@react-pdf/renderer",
    "@tanstack-json-render/react-pdf",
  ],
};

export default nextConfig;
