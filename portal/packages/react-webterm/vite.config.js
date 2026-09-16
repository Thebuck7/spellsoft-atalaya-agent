import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build ESM library. React stays external (peer dep); xterm is bundled.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.js"),
      formats: ["es"],
      fileName: "react-webterm",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
    sourcemap: true,
  },
});
