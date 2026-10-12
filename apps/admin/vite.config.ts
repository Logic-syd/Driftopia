import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("apps/admin"),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    fs: { allow: [resolve(".")] },
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { outDir: resolve("dist/admin"), emptyOutDir: true },
});
