import * as fs from "fs";

import { validateMultiEdit } from "core/edit/searchAndReplace/multiEditValidation.js";
import { executeMultiFindAndReplace } from "core/edit/searchAndReplace/performReplace.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { diffLines } from "diff";

import { telemetryService } from "../telemetry/telemetryService.js";
import {
  calculateLinesOfCodeDiff,
  getLanguageFromFilePath,
} from "../telemetry/utils.js";

import { editTool, validateAndResolveFilePath } from "./edit.js";
import { readFileTool } from "./readFile.js";
import { Tool } from "./types.js";
import { generateDiff } from "./writeFile.js";

export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditArgs {
  file_path: string;
  edits: EditOperation[];
}

const UPDATED_REGION_CONTEXT_LINES = 10;
const UPDATED_REGION_MAX_LINES = 200;

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

function formatUpdatedFileRegion(
  originalContent: string,
  newContent: string,
): string {
  const newLines = splitLines(newContent);
  const ranges: Array<{ start: number; end: number }> = [];
  let newLineNumber = 1;

  for (const change of diffLines(originalContent, newContent)) {
    const lineCount = splitLines(change.value).length;

    if (change.added) {
      ranges.push({
        start: Math.max(1, newLineNumber - UPDATED_REGION_CONTEXT_LINES),
        end: Math.min(
          newLines.length,
          newLineNumber + lineCount - 1 + UPDATED_REGION_CONTEXT_LINES,
        ),
      });
      newLineNumber += lineCount;
    } else if (!change.removed) {
      newLineNumber += lineCount;
    }
  }

  if (ranges.length === 0) {
    return "Updated file region (after edits):\n(no changed regions detected)";
  }

  ranges.sort((a, b) => a.start - b.start);
  const mergedRanges = ranges.reduce<Array<{ start: number; end: number }>>(
    (merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    },
    [],
  );

  let remainingLines = UPDATED_REGION_MAX_LINES;
  let truncated = false;
  const outputLines = ["Updated file region (after edits):"];

  for (const range of mergedRanges) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    if (outputLines.length > 1) {
      outputLines.push("...");
    }

    const linesInRange = range.end - range.start + 1;
    const linesToShow = Math.min(linesInRange, remainingLines);
    for (
      let lineNumber = range.start;
      lineNumber < range.start + linesToShow;
      lineNumber++
    ) {
      outputLines.push(`${lineNumber}: ${newLines[lineNumber - 1] ?? ""}`);
    }

    remainingLines -= linesToShow;
    if (linesToShow < linesInRange) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    outputLines.push(
      `... (updated region truncated to ${UPDATED_REGION_MAX_LINES} lines)`,
    );
  }

  return outputLines.join("\n");
}

export const multiEditTool: Tool = {
  name: "MultiEdit",
  displayName: "MultiEdit",
  readonly: false,
  isBuiltIn: true,
  description: `Use this tool to make multiple edits to a single file in one operation. It allows you to perform multiple find-and-replace operations efficiently. 
Prefer this tool over the ${editTool.name} tool when you need to make multiple edits to the same file.

To make multiple edits to a file, provide the following:
1. file_path: The absolute path to the file to modify. Relative paths can also be used (resolved against cwd) but absolute is preferred
2. edits: An array of edit operations to perform, where each edit contains:
   - old_string: The text to replace (must match the file contents exactly, including all whitespace/indentation)
   - new_string: The edited text to replace the old_string
   - replace_all: Replace all occurrences of old_string. This parameter is optional and defaults to false.

IMPORTANT:
- Files may be modified between tool calls by users, linters, etc, so always make all edits in one tool call where possible. For example, do not only edit imports if there are other changes in the file, as unused imports may be removed by a linter between tool calls.
- All edits are applied in sequence, in the order they are provided
- Each edit operates on the result of the previous edit, so plan your edits carefully to avoid conflicts between sequential operations
- Edits are atomic - all edits must be valid for the operation to succeed - if any edit fails, none will be applied
- This tool is ideal when you need to make several changes to different parts of the same file

CRITICAL REQUIREMENTS:
1. ALWAYS use the ${readFileTool.name} tool just before making edits, to understand the file's up-to-date contents and context. ALWAYS call ${readFileTool.name} just before any edit that follows another tool call which may have changed the file (including any prior multi_edit, edit, write, or shell command). Do not reuse old_string values from a previous turn without re-reading.
2. When making edits:
- Ensure all edits result in idiomatic, correct code
- Do not leave the code in a broken state
- Always use absolute file paths (starting with /)
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Empty old_string can be used to insert content at the beginning of a file

WARNINGS:
- If earlier edits affect the text that later edits are trying to find, files can become mangled
- The tool will fail if edits.old_string doesn't match the file contents exactly (including whitespace)
- The tool will fail if edits.old_string and edits.new_string are the same - they MUST be different
- The tool will fail if you have not used the ${readFileTool.name} tool to read the file in this session
- The tool will fail if the file does not exist - it cannot create new files
- This tool cannot create new files - the file must already exist
- After every successful multi_edit, the returned message contains the updated region. Treat that updated region as your new ground truth before proposing further edits.`,
  parameters: {
    type: "object",
    required: ["file_path", "edits"],
    properties: {
      file_path: {
        type: "string",
        description:
          "Absolute or relative path to the file to modify. Absolute preferred",
      },
      edits: {
        type: "array",
        description:
          "Array of edit operations to perform sequentially on the file",
        items: {
          type: "object",
          required: ["old_string", "new_string"],
          properties: {
            old_string: {
              type: "string",
              description:
                "The text to replace (exact match including whitespace/indentation)",
            },
            new_string: {
              type: "string",
              description:
                "The text to replace it with. MUST be different than old_string.",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace all occurrences of old_string (default false) in the file",
            },
          },
        },
      },
    },
  },
  preprocess: async (args) => {
    const { resolvedPath } = validateAndResolveFilePath(args);

    const { edits } = validateMultiEdit(args);

    const currentContent = fs.readFileSync(resolvedPath, "utf-8");
    const newContent = executeMultiFindAndReplace(currentContent, edits);

    // Generate diff for preview
    const diff = generateDiff(currentContent, newContent, resolvedPath);

    return {
      args: {
        file_path: resolvedPath,
        newContent,
        originalContent: currentContent,
        editCount: edits.length,
      },
      preview: [
        {
          type: "text",
          content: `Will apply ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${resolvedPath}:`,
        },
        {
          type: "diff",
          content: diff,
        },
      ],
    };
  },
  run: async (args: {
    file_path: string;
    newContent: string;
    originalContent: string;
    editCount: number;
  }) => {
    try {
      fs.writeFileSync(args.file_path, args.newContent, "utf-8");

      // Get lines for telemetry
      const { added, removed } = calculateLinesOfCodeDiff(
        args.originalContent,
        args.newContent,
      );
      const language = getLanguageFromFilePath(args.file_path);

      if (added > 0) {
        telemetryService.recordLinesOfCodeModified("added", added, language);
      }
      if (removed > 0) {
        telemetryService.recordLinesOfCodeModified(
          "removed",
          removed,
          language,
        );
      }

      // Generate diff for result display
      const diff = generateDiff(
        args.originalContent,
        args.newContent,
        args.file_path,
      );
      const updatedRegion = formatUpdatedFileRegion(
        args.originalContent,
        args.newContent,
      );

      return `Successfully edited ${args.file_path} with ${args.editCount} edit${args.editCount === 1 ? "" : "s"}\nDiff:\n${diff}\n\n${updatedRegion}`;
    } catch (error) {
      if (error instanceof ContinueError) {
        throw error;
      }
      throw new ContinueError(
        ContinueErrorReason.FileWriteError,
        `Error: failed to edit ${args.file_path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};
