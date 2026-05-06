import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: true,
    proxy: {
      "/socket": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  }
});
