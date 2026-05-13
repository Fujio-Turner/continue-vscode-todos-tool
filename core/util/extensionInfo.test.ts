import { getExtensionInfo } from "./extensionInfo";

describe("extensionInfo", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars before each test
    delete (process.env as any).EXTENSION_VERSION;
    delete (process.env as any).EXTENSION_BUILD_SHA;
  });

  afterEach(() => {
    // Restore original env after each test
    Object.assign(process.env, originalEnv);
  });

  test("returns env-var values when defined", () => {
    process.env.EXTENSION_VERSION = "1.3.39";
    process.env.EXTENSION_BUILD_SHA =
      "affc6394f09964950387c286ff8b28c610f88736";

    const info = getExtensionInfo();

    expect(info.extensionVersion).toBe("1.3.39");
    expect(info.extensionCommit).toBe(
      "affc6394f09964950387c286ff8b28c610f88736",
    );
  });

  test("returns 'N/A' when env vars are missing", () => {
    // Env vars should be deleted from beforeEach
    const info = getExtensionInfo();

    expect(info.extensionVersion).toBe("N/A");
    expect(info.extensionCommit).toBe("N/A");
  });

  test("returns 'N/A' for extensionVersion when undefined", () => {
    process.env.EXTENSION_BUILD_SHA = "abc123";
    delete (process.env as any).EXTENSION_VERSION;

    const info = getExtensionInfo();

    expect(info.extensionVersion).toBe("N/A");
    expect(info.extensionCommit).toBe("abc123");
  });

  test("returns 'N/A' for extensionCommit when undefined", () => {
    process.env.EXTENSION_VERSION = "1.2.3";
    delete (process.env as any).EXTENSION_BUILD_SHA;

    const info = getExtensionInfo();

    expect(info.extensionVersion).toBe("1.2.3");
    expect(info.extensionCommit).toBe("N/A");
  });
});
