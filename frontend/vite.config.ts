import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development the UI runs on :5173 and forwards API calls to FastAPI,
    // so the session cookie stays same-origin.
    proxy: { "/api": "http://localhost:8000" },
  },
});
