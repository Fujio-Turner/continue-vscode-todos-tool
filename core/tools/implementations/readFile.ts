import { resolveInputPath } from "../../util/pathResolver";
import { getUriPathBasename } from "../../util/uri";

import { ToolImpl } from ".";
import {
  loadWorkspaceSecurityAllowList,
  securityBlockContent,
  throwIfFileIsSecurityConcern,
} from "../../indexing/ignore";
import { getStringArg } from "../parseArgs";
import { throwIfFileExceedsHalfOfContext } from "./readFileLimit";
import { ContinueError, ContinueErrorReason } from "../../util/errors";

export const readFileImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");

  // Resolve the path first to get the actual path for security check
  const resolvedPath = await resolveInputPath(extras.ide, filepath);
  if (!resolvedPath) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File "${filepath}" does not exist or is not accessible. You might want to check the path and try again.`,
    );
  }

  // Security check on the resolved display path
  try {
    const allowPatterns = await loadWorkspaceSecurityAllowList(extras.ide);
    throwIfFileIsSecurityConcern(resolvedPath.displayPath, { allowPatterns });
  } catch (e) {
    if (
      e instanceof ContinueError &&
      e.reason === ContinueErrorReason.FileIsSecurityConcern
    ) {
      return [
        {
          name: getUriPathBasename(resolvedPath.uri),
          description: resolvedPath.displayPath,
          content: securityBlockContent(resolvedPath.displayPath),
          uri: {
            type: "file",
            value: resolvedPath.uri,
          },
        },
      ];
    }
    throw e;
  }

  const content = await extras.ide.readFile(resolvedPath.uri);

  await throwIfFileExceedsHalfOfContext(
    resolvedPath.displayPath,
    content,
    extras.config.selectedModelByRole.chat,
  );

  return [
    {
      name: getUriPathBasename(resolvedPath.uri),
      description: resolvedPath.displayPath,
      content,
      uri: {
        type: "file",
        value: resolvedPath.uri,
      },
    },
  ];
};
