import { describe, expect, test } from "bun:test";

import { formatToolInputPreview } from "./guardian-approval-prompt.js";

describe("formatToolInputPreview", () => {
  test("keeps shell command previews visible and redacted", () => {
    const preview = formatToolInputPreview("bash", {
      command: "curl https://example.com?token=sk-test1234567890",
    });

    expect(preview).toContain("running");
    expect(preview).toContain("curl");
    expect(preview).not.toContain("sk-test1234567890");
  });

  test("sanitizes path and url previews before appending to approval prompts", () => {
    const pathPreview = formatToolInputPreview("file_read", {
      path: "notes/`break`.md",
    });
    const urlPreview = formatToolInputPreview("web_fetch", {
      url: "https://example.com/`x`",
    });

    expect(pathPreview).toBe("reading `notes/'break'.md`");
    expect(urlPreview).toBe("fetching `https://example.com/'x'`");
  });
});
