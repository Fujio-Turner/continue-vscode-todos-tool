import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react-swc";
import { execSync } from "child_process";
import { resolve } from "path";
import tailwindcss from "tailwindcss";
import { defineConfig } from "vitest/config";

// Capture git commit SHA and extension version for build-time injection
const buildSha =
  process.env.GITHUB_SHA ||
  (() => {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    } catch {
      return "N/A";
    }
  })();

// Read version from VSCode extension package.json
const pkgPath = resolve(__dirname, "../extensions/vscode/package.json");
let extensionVersion = "N/A";
try {
  const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
  extensionVersion = pkg.version;
} catch {
  // ignore
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    "process.env.EXTENSION_BUILD_SHA": JSON.stringify(buildSha),
    "process.env.EXTENSION_VERSION": JSON.stringify(extensionVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: "continue-xd",
      project: "continue",
    }),
  ],
  build: {
    sourcemap: true,

    // Change the output .js filename to not include a hash
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        indexConsole: resolve(__dirname, "indexConsole.html"),
      },
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
  server: {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["*", "Content-Type", "Authorization"],
      credentials: true,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/util/test/setupTests.ts",
    onConsoleLog(log, type) {
      if (type === "stderr") {
        if (
          [
            "contentEditable",
            "An update to Chat inside a test was not wrapped in act",
            "An update to TipTapEditor inside a test was not wrapped in act",
            "An update to ThinkingIndicator inside a test was not wrapped in act",
            "The current testing environment is not configured to support act",
            "target.getClientRects is not a function",
            "prosemirror",
          ].some((text) => log.includes(text))
        ) {
          return false;
        }
      }
      return true;
    },
    onUnhandledRejection(err) {
      // Suppress ProseMirror DOM errors in test environment
      if (
        err.message?.includes("getClientRects") ||
        err.message?.includes("prosemirror")
      ) {
        return false;
      }
      return true;
    },
  },
});
