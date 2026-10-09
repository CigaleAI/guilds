import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Storybook and the package's Tailwind entry share this Vite config. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
