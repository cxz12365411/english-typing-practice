import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    assetsDir: "assets"
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8091",
        changeOrigin: false
      }
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
