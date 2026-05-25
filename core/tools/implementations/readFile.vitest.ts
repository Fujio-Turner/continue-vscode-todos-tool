import { expect, test, vi } from "vitest";
import { ToolExtras } from "../..";
import { ContinueErrorReason } from "../../util/errors";
import { readFileImpl } from "./readFile";

vi.mock("./readFileLimit", () => ({
  throwIfFileExceedsHalfOfContext: vi.fn(),
}));

const config = {
  selectedModelByRole: { chat: { contextLength: 8192 } },
};

test("readFileImpl returns a blocked result for security concerns", async () => {
  const mockIde = {
    getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
    readFile: vi.fn().mockRejectedValue(new Error("missing .continueignore")),
    fileExists: vi.fn().mockResolvedValue(true),
  };

  const result = await readFileImpl({ filepath: "config.json" }, {
    ide: mockIde,
    config,
  } as unknown as ToolExtras);

  expect(result).toHaveLength(1);
  expect(result[0].content).toContain("blocked by local security policy");
  expect(result[0].content).toContain(".continueignore");
});

test("readFileImpl still throws for missing files", async () => {
  const mockIde = {
    getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
    fileExists: vi.fn().mockResolvedValue(false),
  };

  await expect(
    readFileImpl({ filepath: "missing.txt" }, {
      ide: mockIde,
      config,
    } as unknown as ToolExtras),
  ).rejects.toMatchObject({ reason: ContinueErrorReason.FileNotFound });
});

test("readFileImpl reads allowed config files from .continueignore", async () => {
  const mockIde = {
    getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
    fileExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn(async (uri: string) => {
      if (uri.endsWith("/.continueignore")) {
        return "!config.json\n";
      }
      return '{"hosts": ["a", "b"]}';
    }),
  };

  const result = await readFileImpl({ filepath: "config.json" }, {
    ide: mockIde,
    config,
  } as unknown as ToolExtras);

  expect(result[0].content).toBe('{"hosts": ["a", "b"]}');
});
