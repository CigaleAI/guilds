import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vite";

/**
 * How the operator app is built and served in development, for this package and for an edition's
 * package that mounts the app with its own slots. The app is the whole site; the orchestrator
 * answers its API, avatars and health check.
 */
export function appConfig(): UserConfig {
  return {
    base: "/",
    // Every edition serves the same favicon.
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "dist",
      sourcemap: true,
      rolldownOptions: {
        output: {
          // Libraries change less often than the app, so they get chunks of their own that stay cached.
          codeSplitting: {
            groups: [
              { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: "tanstack", test: /[\\/]node_modules[\\/]@tanstack[\\/]/ },
              { name: "radix", test: /[\\/]node_modules[\\/](@radix-ui|radix-ui)[\\/]/ },
              {
                name: "markdown",
                test: /[\\/]node_modules[\\/](react-markdown|remark-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|unified|unist-[^\\/]+|hast-[^\\/]+|vfile[^\\/]*)[\\/]/,
              },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        "^/(api|avatars)/.*|^/health$": {
          target: "http://127.0.0.1:8080",
          ws: true,
        },
      },
    },
  };
}
