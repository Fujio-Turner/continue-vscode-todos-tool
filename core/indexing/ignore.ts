import ignore from "ignore";

import path from "path";
import { fileURLToPath } from "url";
import { IDE } from "..";
import { ContinueError, ContinueErrorReason } from "../util/errors";

// Security-focused ignore patterns - these should always be excluded for security reasons
export const DEFAULT_SECURITY_IGNORE_FILETYPES = [
  // Environment and configuration files with secrets
  "*.env",
  "*.env.*",
  ".env*",
  "config.json",
  "config.yaml",
  "config.yml",
  "settings.json",
  "appsettings.json",
  "appsettings.*.json",

  // Certificate and key files
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "*.jks",
  "*.keystore",
  "*.truststore",

  // Database files that may contain sensitive data
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  "*.mdb",
  "*.accdb",

  // Credential and secret files
  "*.secret",
  "*.secrets",
  "auth.json",
  "*.token",

  // Backup files that might contain sensitive data
  "*.bak",
  "*.backup",
  "*.old",
  "*.orig",

  // Docker secrets
  "docker-compose.override.yml",
  "docker-compose.override.yaml",

  // SSH and GPG
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.ppk",
  "*.gpg",
];

export const DEFAULT_SECURITY_IGNORE_DIRS = [
  // Environment and configuration directories
  ".env/",
  "env/",

  // Cloud provider credential directories
  ".aws/",
  ".gcp/",
  ".azure/",
  ".kube/",
  ".docker/",

  // Secret directories
  "secrets/",
  ".secrets/",
  "private/",
  ".private/",
  "certs/",
  "certificates/",
  "keys/",
  ".ssh/",
  ".gnupg/",
  ".gpg/",

  // Temporary directories that might contain sensitive data
  "tmp/secrets/",
  "temp/secrets/",
  ".tmp/",
];

// Additional non-security patterns for general indexing exclusion
export const ADDITIONAL_INDEXING_IGNORE_FILETYPES = [
  "*.DS_Store",
  "*-lock.json",
  "*.lock",
  "*.log",
  "*.ttf",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.mp4",
  "*.svg",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.tar",
  "*.dmg",
  "*.tgz",
  "*.rar",
  "*.7z",
  "*.exe",
  "*.dll",
  "*.obj",
  "*.o",
  "*.o.d",
  "*.a",
  "*.lib",
  "*.so",
  "*.dylib",
  "*.ncb",
  "*.sdf",
  "*.woff",
  "*.woff2",
  "*.eot",
  "*.cur",
  "*.avi",
  "*.mpg",
  "*.mpeg",
  "*.mov",
  "*.mp3",
  "*.mkv",
  "*.webm",
  "*.jar",
  "*.onnx",
  "*.parquet",
  "*.pqt",
  "*.wav",
  "*.webp",
  "*.wasm",
  "*.plist",
  "*.profraw",
  "*.gcda",
  "*.gcno",
  "go.sum",
  "*.gitignore",
  "*.gitkeep",
  "*.continueignore",
  "*.csv",
  "*.uasset",
  "*.pdb",
  "*.bin",
  "*.pag",
  "*.swp",
  "*.jsonl",
  // "*.prompt", // can be incredibly confusing for the LLM to have another set of instructions injected into the prompt
  // Application specific
  ".continue/",
];

export const ADDITIONAL_INDEXING_IGNORE_DIRS = [
  ".git/",
  ".svn/",
  "node_modules/",
  "dist/",
  "build/",
  "Build/",
  "target/",
  "out/",
  "bin/",
  ".pytest_cache/",
  ".vscode-test/",
  "__pycache__/",
  "site-packages/",
  ".gradle/",
  ".mvn/",
  ".cache/",
  "gems/",
  "vendor/",

  ".venv/",
  "venv/",

  ".vscode/",
  ".idea/",
  ".vs/",
];

// Combined patterns: security + additional
export const DEFAULT_IGNORE_FILETYPES = [
  ...DEFAULT_SECURITY_IGNORE_FILETYPES,
  ...ADDITIONAL_INDEXING_IGNORE_FILETYPES,
];

export const DEFAULT_IGNORE_DIRS = [
  ...DEFAULT_SECURITY_IGNORE_DIRS,
  ...ADDITIONAL_INDEXING_IGNORE_DIRS,
];

export const DEFAULT_IGNORES = [
  ...DEFAULT_IGNORE_FILETYPES,
  ...DEFAULT_IGNORE_DIRS,
];

export const defaultIgnoresGlob = `!{${DEFAULT_IGNORES.join(",")}}`;

// Create ignore instances
export const defaultSecurityIgnoreFile = ignore().add(
  DEFAULT_SECURITY_IGNORE_FILETYPES,
);
export const defaultSecurityIgnoreDir = ignore().add(
  DEFAULT_SECURITY_IGNORE_DIRS,
);
export const defaultIgnoreFile = ignore().add(DEFAULT_IGNORE_FILETYPES);
export const defaultIgnoreDir = ignore().add(DEFAULT_IGNORE_DIRS);

// String representations
export const DEFAULT_SECURITY_IGNORE =
  DEFAULT_SECURITY_IGNORE_FILETYPES.join("\n") +
  "\n" +
  DEFAULT_SECURITY_IGNORE_DIRS.join("\n");

export const DEFAULT_IGNORE =
  DEFAULT_IGNORE_FILETYPES.join("\n") + "\n" + DEFAULT_IGNORE_DIRS.join("\n");

// Combined ignore instances
export const defaultFileAndFolderSecurityIgnores = ignore()
  .add(defaultSecurityIgnoreFile)
  .add(defaultSecurityIgnoreDir);

export const defaultIgnoreFileAndDir = ignore()
  .add(defaultIgnoreFile)
  .add(defaultIgnoreDir);

interface SecurityConcernOptions {
  allowPatterns?: string[];
}

function getSecurityIgnores(allowPatterns?: string[]) {
  if (!allowPatterns?.length) {
    return defaultFileAndFolderSecurityIgnores;
  }

  const normalizedAllowPatterns = allowPatterns.map((pattern) =>
    pattern.startsWith("!") ? pattern : `!${pattern}`,
  );

  return ignore()
    .add(DEFAULT_SECURITY_IGNORE_FILETYPES)
    .add(DEFAULT_SECURITY_IGNORE_DIRS)
    .add(normalizedAllowPatterns);
}

export function isSecurityConcern(
  filePathOrUri: string,
  opts?: SecurityConcernOptions,
) {
  if (!filePathOrUri) {
    return false;
  }
  let filepath = filePathOrUri;
  try {
    filepath = fileURLToPath(filePathOrUri);
  } catch {}
  if (path.isAbsolute(filepath)) {
    const dir = path.dirname(filepath).split(/\/|\\/).at(-1) ?? "";
    const basename = path.basename(filepath);
    filepath = `${dir ? dir + "/" : ""}${basename}`;
  }
  if (!filepath) {
    return false;
  }
  return getSecurityIgnores(opts?.allowPatterns).ignores(filepath);
}

export function throwIfFileIsSecurityConcern(
  filepath: string,
  opts?: SecurityConcernOptions,
) {
  if (isSecurityConcern(filepath, opts)) {
    throw new ContinueError(
      ContinueErrorReason.FileIsSecurityConcern,
      `Reading or Editing ${filepath} is not allowed because it is a security concern. Do not attempt to read or edit this file in any way.`,
    );
  }
}

export async function loadWorkspaceSecurityAllowList(
  ide: IDE,
): Promise<string[]> {
  const workspaceDirs = await ide.getWorkspaceDirs();
  const workspaceDir = workspaceDirs[0];
  if (!workspaceDir) {
    return [];
  }

  try {
    const continueIgnore = await ide.readFile(
      `${workspaceDir}/.continueignore`,
    );
    return gitIgArrayFromFile(continueIgnore)
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

export function securityBlockContent(displayPath: string) {
  return `[File access blocked by local security policy: ${displayPath}]
This filename matches a default-blocked pattern (likely to contain secrets).
If this file is safe to share, add a negation to .continueignore, e.g.:
    !config.json
Then re-run read_file. Otherwise, ask the user to paste the relevant excerpt.`;
}

export function gitIgArrayFromFile(file: string) {
  return file
    .split(/\r?\n/) // Split on new line
    .map((l) => l.trim()) // Remove whitespace
    .filter((l) => !/^#|^$/.test(l)); // Remove empty lines
}
