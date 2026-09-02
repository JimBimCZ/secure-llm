import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle so the runtime image does not need
  // node_modules. See Dockerfile.
  output: "standalone",

  // The embedding model runs on onnxruntime, which loads native binaries and a
  // shared library at runtime. Module tracing follows imports and so copies the
  // JavaScript but misses the .so/.node files beside it, and the failure only
  // appears in the built image — never in `next dev`. Force them in.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/onnxruntime-node/bin/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
    ],
  },
};

export default nextConfig;
