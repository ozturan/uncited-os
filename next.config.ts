import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Removed 'output: export' to support Supabase middleware
  // If you need static export, you can use localStorage-only mode
  images: {
    // unoptimized: true, // Enabled image optimization
  },
  // Exclude journals from serverless bundles - they're served as static files
  outputFileTracingExcludes: {
    '*': [
      './public/data/journals/**/*',
      './public/data/entry-index.json',
    ],
  },
};

export default nextConfig;
