import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is a plain SPA rooted at src/ui. In dev, Vite serves it on 3401 and
// proxies /api to the daemon on 3400. In prod, the daemon serves dist/ui itself.
export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3400",
        changeOrigin: false,
      },
    },
  },
});
