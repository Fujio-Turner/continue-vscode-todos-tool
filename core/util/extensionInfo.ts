/**
 * Extension metadata (version and commit SHA) injected at build time via esbuild define.
 * This file is importable from both extension host and GUI webview without vscode imports.
 */

export interface ExtensionInfo {
  extensionVersion: string; // "1.3.39" | "N/A"
  extensionCommit: string; // 40-char SHA | "N/A"
}

/**
 * Retrieves extension version and commit SHA baked in at build time.
 * Falls back to "N/A" when values are not defined (e.g., in dev builds without git).
 */
export function getExtensionInfo(): ExtensionInfo {
  return {
    extensionVersion:
      (process.env.EXTENSION_VERSION as string | undefined) || "N/A",
    extensionCommit:
      (process.env.EXTENSION_BUILD_SHA as string | undefined) || "N/A",
  };
}
