# Plan: Fix Issue #10 — `read_file` over-blocks `config.json` and degrades silently

Address [issue #10](https://github.com/Fujio-Turner/continue-vscode-todos-tool/issues/10): the security layer rejects any file literally named `config.json` (and similar common application-config names) by basename alone, with no allow-list path and no graceful degradation. The assistant then continues with partial context instead of telling the user _why_ it could not read the file.

The bug report's file paths (`core/src/tools/readFile.ts`, `core/src/security/fileAccessPolicy.ts`, `core/src/agents/context.ts`) **do not exist in this repo**. The real implementation lives in [core/indexing/ignore.ts](file:///home/mikail/continue-vscode-todos-tool/core/indexing/ignore.ts) and the tool wrappers under [core/tools/implementations/](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/). This plan targets those actual files.

This plan ships **both** a point fix (graceful degradation in the read/create tool wrappers) and a design fix (workspace-overridable allow-list + optional content heuristic) so the same over-block does not recur for `.env`, `settings.json`, `appsettings.json`, `auth.json`, etc.

## 1. Goals

- Stop the `read_file` tool call from returning `rawStatus: "errored"` for files blocked by the static security policy. Return a normal tool result whose `content` explains the block and the workaround.
- Let users opt specific files in via `.continueignore` negations (the `ignore` package already supports `!pattern`) so a project whose `config.json` is just hostnames/labels (e.g. the Couchbase dashboard in the bug report) can be analysed.
- Keep `.env`, `*.pem`, `id_rsa`, etc. blocked by default — do **not** weaken protection of files that genuinely tend to contain secrets.
- Touch only:
  - [core/indexing/ignore.ts](file:///home/mikail/continue-vscode-todos-tool/core/indexing/ignore.ts)
  - [core/indexing/ignore.vitest.ts](file:///home/mikail/continue-vscode-todos-tool/core/indexing/ignore.vitest.ts)
  - [core/tools/implementations/readFile.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readFile.ts)
  - [core/tools/implementations/readFileRange.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readFileRange.ts)
  - [core/tools/implementations/readCurrentlyOpenFile.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readCurrentlyOpenFile.ts)
  - corresponding `*.vitest.ts` files

## 2. Non-Goals

- **Not** editing the paths the auto-filed issue named (`core/src/tools/readFile.ts`, `core/src/security/fileAccessPolicy.ts`, `core/src/agents/context.ts`, `.continue/checks/security-audit.md`) — none of them exist in this repo.
- **Not** changing `createNewFile` / edit tool behaviour: writing to a blocked path should still throw, because a graceful "ok, skipped" response would mask a real bug. Only **read** tools degrade gracefully.
- **Not** removing `config.json`, `settings.json`, or `appsettings.json` from the default blacklist outright. They stay blocked **by default**; the design fix is to make them overridable, not unconditionally allowed.
- **Not** indexing-pipeline changes (`CompletionProvider`, `NextEditProvider`, `processSmallEdit`, `autocompleteContextFetching`). Those callers of `isSecurityConcern` are silent background features and must remain conservative.

## 3. Phase 1 — Point Fix: Graceful Degradation in Read Tools

Goal: a blocked `read_file` returns a tool result the model can reason about, not an `errored` rawStatus.

### 3.1 Wrap the security check in `readFileImpl`

**File:** [core/tools/implementations/readFile.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readFile.ts) (line 23 today).

Replace the bare `throwIfFileIsSecurityConcern(resolvedPath.displayPath)` with a try/catch that converts `ContinueErrorReason.FileIsSecurityConcern` into a normal tool result whose `content` says:

```
[File access blocked by local security policy: <displayPath>]
This filename matches a default-blocked pattern (likely to contain secrets).
If this file is safe to share, add a negation to .continueignore, e.g.:
    !config.json
Then re-run read_file. Otherwise, ask the user to paste the relevant excerpt.
```

The result still has `uri`, `name`, `description` populated so downstream consumers (UI, context items) render normally. The model sees a deterministic message and can prompt the user instead of guessing.

Any other thrown error (e.g. `FileNotFound`, `FileTooLarge`) is rethrown unchanged.

### 3.2 Mirror in `readFileRangeImpl`

**File:** [core/tools/implementations/readFileRange.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readFileRange.ts) line 49. Same pattern.

### 3.3 Mirror in `readCurrentlyOpenFileImpl`

**File:** [core/tools/implementations/readCurrentlyOpenFile.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/readCurrentlyOpenFile.ts) line 11. Return an empty-but-documented result (`content: "[Currently open file is blocked by local security policy]"`) rather than throwing.

### 3.4 Keep `createNewFileImpl` strict

**File:** [core/tools/implementations/createNewFile.ts](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/createNewFile.ts) line 18. **No change.** Writing to a blocked path should keep throwing; silent degradation here would hide real mistakes.

### 3.5 Phase 1 tests

In [core/tools/implementations/](file:///home/mikail/continue-vscode-todos-tool/core/tools/implementations/) add (or extend the closest existing) `*.vitest.ts`:

- `readFile` against a path basename `config.json` → returns a single tool result, `content` contains `"blocked by local security policy"` and `".continueignore"`, no throw.
- `readFile` against a nonexistent path → still throws `FileNotFound` (regression guard).
- `readFileRange` same coverage as `readFile`.
- `createNewFile` against `config.json` → still throws `FileIsSecurityConcern` (regression guard).

## 4. Phase 2 — Design Fix: Overridable Policy

Goal: stop punishing users whose `config.json` contains no secrets.

### 4.1 Allow-list parameter on the policy primitive

**File:** [core/indexing/ignore.ts](file:///home/mikail/continue-vscode-todos-tool/core/indexing/ignore.ts).

Extend `isSecurityConcern` and `throwIfFileIsSecurityConcern` with an optional `allowPatterns: string[]` argument. When provided, the function constructs an `ignore()` instance from `DEFAULT_SECURITY_IGNORE_FILETYPES + DEFAULT_SECURITY_IGNORE_DIRS` and **then** applies the user patterns as negations (`!pattern`) before testing. The `ignore` npm package already implements gitignore-style negation, so this is a one-line composition.

```ts
export function isSecurityConcern(
  filePathOrUri: string,
  opts?: { allowPatterns?: string[] },
): boolean { ... }
```

Default behaviour (no `opts`) is **byte-identical** to today, so unrelated callers (autocomplete, next-edit) are unaffected.

### 4.2 Source the allow-list from `.continueignore`

The workspace's `.continueignore` is already loaded elsewhere for indexing. Add a small helper `loadWorkspaceSecurityAllowList(ide): Promise<string[]>` that:

1. Reads `<workspaceRoot>/.continueignore` via `ide.readFile`.
2. Returns the lines that start with `!` (stripped of the leading `!`).
3. Returns `[]` if the file is absent or unreadable.

Cache per-workspace for the lifetime of the IDE session (simple `Map<workspaceUri, string[]>` invalidated on `.continueignore` change events if the IDE exposes them; otherwise per-request is fine — `.continueignore` is tiny).

### 4.3 Thread allow-list through the read tools

Update the three read tool wrappers from §3.1–§3.3 so the security check is:

```ts
const allow = await loadWorkspaceSecurityAllowList(extras.ide);
try {
  throwIfFileIsSecurityConcern(resolvedPath.displayPath, {
    allowPatterns: allow,
  });
} catch (e) {
  /* Phase-1 graceful-degradation branch */
}
```

Now a user can write `!config.json` in `.continueignore` and the file becomes readable, with no code change.

### 4.4 (Optional) Content-aware second pass

For files that pass the name check **but** the basename is in a "frequently-but-not-always-secret" set (`config.json`, `settings.json`, `appsettings.json`, `auth.json`), run a cheap regex on the loaded content:

```
/(password|secret|api[_-]?key|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|bearer\s+[A-Za-z0-9._-]{20,})/i
```

If the content matches, return the same graceful-degradation message instead of the file content, plus a hint: _"content looks like it contains secrets; not returned to the model"_. If it does not match, return the content normally.

This is **gated behind a config flag** (`security.scanConfigLikeFilesForSecrets`, default `false`) so it ships without changing default behaviour, and can be enabled by users who want belt-and-braces. Skip in Phase 2 if scope is tight; this is the lowest-priority change in the plan.

### 4.5 Phase 2 tests

Extend [core/indexing/ignore.vitest.ts](file:///home/mikail/continue-vscode-todos-tool/core/indexing/ignore.vitest.ts):

- `isSecurityConcern("config.json", { allowPatterns: ["!config.json"] })` → `false`.
- `isSecurityConcern("foo/config.json", { allowPatterns: ["!config.json"] })` → `false`.
- `isSecurityConcern(".env", { allowPatterns: ["!config.json"] })` → `true` (allow-list is scoped, does not affect other patterns).
- `isSecurityConcern("config.json")` (no opts) → `true` (default behaviour unchanged).
- `throwIfFileIsSecurityConcern("config.json", { allowPatterns: ["!config.json"] })` → no throw.

For the read tools, add an integration-style test that stubs `ide.readFile` for both `.continueignore` (returning `"!config.json\n"`) and `config.json` (returning `{"hosts": ["a", "b"]}`), then asserts the actual `config.json` content is returned.

## 5. Verification

From repo root:

```
cd core
npm run vitest -- indexing/ignore.vitest.ts \
                  tools/implementations/readFile \
                  tools/implementations/readFileRange \
                  tools/implementations/readCurrentlyOpenFile
```

Plus a manual smoke test in VS Code:

1. Open the Couchbase dashboard project from the bug report (or any repo containing a benign `config.json`).
2. Without `.continueignore`: ask the assistant to read `config.json`. Expect a polite "blocked by local security policy" tool result instead of `rawStatus: errored`. The assistant should now suggest the `.continueignore` workaround in its reply.
3. Add `!config.json` to `.continueignore`. Re-run. Expect the file contents to come through.
4. Try `read_file` on `.env` with the same allow-list. Expect it to remain blocked (regression guard).

## 6. Rollout Notes

- No protocol changes, no UI changes, no migration.
- The default policy stays strict; behaviour only changes for users who (a) opt files in via `.continueignore` or (b) trigger the graceful-degradation branch (in which case they previously got an `errored` tool call — strictly better).
- Backwards-compatible: every existing call site of `isSecurityConcern` / `throwIfFileIsSecurityConcern` passes no `opts` and gets the exact behaviour it has today.

## 7. Out-of-Scope Follow-ups

- Surface a one-click "Allow this file" action in the VS Code UI that writes the `!pattern` into `.continueignore` for the user.
- Move the static blacklist into shared config so it is consistent across `core`, `extensions/vscode`, `extensions/cli`, and `binary` (currently duplicated in compiled bundles).
- Extend the same graceful-degradation pattern to `grep`/`search` tools so blocked files are reported as such instead of silently filtered.

## 8. Implementation Notes

- Implemented `allowPatterns` support for `isSecurityConcern` / `throwIfFileIsSecurityConcern` in `core/indexing/ignore.ts`, preserving default behavior when no options are passed.
- Added `loadWorkspaceSecurityAllowList(ide)` to read negated `.continueignore` entries and thread them through `readFile`, `readFileRange`, and `readCurrentlyOpenFile`.
- Added `securityBlockContent()` and changed read-only tools to return a normal context item for `FileIsSecurityConcern` instead of throwing, while leaving other errors unchanged.
- Left `createNewFile` strict as planned; no write-tool behavior was relaxed.
- Added/extended tests for allow-list behavior, blocked `readFile`, missing-file regression, allowed `config.json` reads, and blocked `readFileRange` behavior.
- Skipped the optional content-aware second pass from §4.4 to keep the change bounded and avoid introducing a new config flag.
