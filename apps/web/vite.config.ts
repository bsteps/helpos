import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API runs on its own port in development (`pnpm dev`); the dev server forwards API calls
// to it, so the dashboard and the API share one origin, as they do in production.
const api = process.env.HELPOS_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/v1": { target: api } },
  },
  build: { sourcemap: true },
});
