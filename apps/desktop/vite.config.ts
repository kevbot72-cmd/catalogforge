import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no clearing of its logs.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2021", sourcemap: false, chunkSizeWarningLimit: 4000 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as any);
