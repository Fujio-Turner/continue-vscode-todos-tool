import { getUriDescription } from "../../util/uri";

import { ToolImpl } from ".";
import {
  loadWorkspaceSecurityAllowList,
  securityBlockContent,
  throwIfFileIsSecurityConcern,
} from "../../indexing/ignore";
import { throwIfFileExceedsHalfOfContext } from "./readFileLimit";
import { ContinueError, ContinueErrorReason } from "../../util/errors";

export const readCurrentlyOpenFileImpl: ToolImpl = async (_, extras) => {
  const result = await extras.ide.getCurrentFile();

  if (result) {
    try {
      const allowPatterns = await loadWorkspaceSecurityAllowList(extras.ide);
      throwIfFileIsSecurityConcern(result.path, { allowPatterns });
    } catch (e) {
      if (
        e instanceof ContinueError &&
        e.reason === ContinueErrorReason.FileIsSecurityConcern
      ) {
        const { last2Parts, baseName } = getUriDescription(
          result.path,
          await extras.ide.getWorkspaceDirs(),
        );

        return [
          {
            name: `Current file: ${baseName}`,
            description: last2Parts,
            content: securityBlockContent(result.path),
            uri: {
              type: "file",
              value: result.path,
            },
          },
        ];
      }
      throw e;
    }
    await throwIfFileExceedsHalfOfContext(
      result.path,
      result.contents,
      extras.config.selectedModelByRole.chat,
    );

    const { relativePathOrBasename, last2Parts, baseName } = getUriDescription(
      result.path,
      await extras.ide.getWorkspaceDirs(),
    );

    return [
      {
        name: `Current file: ${baseName}`,
        description: last2Parts,
        content: `\`\`\`${relativePathOrBasename}\n${result.contents}\n\`\`\``,
        uri: {
          type: "file",
          value: result.path,
        },
      },
    ];
  } else {
    return [
      {
        name: `No Current File`,
        description: "",
        content: "There are no files currently open.",
      },
    ];
  }
};
