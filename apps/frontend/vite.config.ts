import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { config } from "dotenv";

config({ path: resolve(__dirname, "../../.env") });

const apiPort = process.env.API_PORT ?? "3000";
const frontendPort = parseInt(process.env.FRONTEND_PORT ?? "5173", 10);

// Post-E2EE-removal: no client-side Service Worker anymore (streaming is a
// real HTTP Range-proxy through the API — see apps/api/src/handlers/stream.ts
// and docs/hermes/concept.md section 4.2), so the SW build plugin is gone.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: frontendPort,
    allowedHosts: ["discordrive.cikowice.pl", "discordrive-test.cikowice.pl", "ddrive.cikowice.pl", "ddrive-test.cikowice.pl"],
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/graphql": `http://localhost:${apiPort}`,
    },
  },
  preview: {
    host: "0.0.0.0",
    port: frontendPort,
    allowedHosts: ["discordrive-test.cikowice.pl", "discordrive.cikowice.pl", "ddrive.cikowice.pl", "ddrive-test.cikowice.pl"],
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/graphql": `http://localhost:${apiPort}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
});
