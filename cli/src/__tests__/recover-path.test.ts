import { describe, expect, test } from "bun:test";

import {
  getRecoverArchiveStagingDir,
  getRecoverRestorePath,
} from "../commands/recover.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

function entry(instanceDir: string): AssistantEntry {
  return {
    assistantId: "test",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:7821",
    resources: {
      instanceDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 54545,
    },
  };
}

describe("recover archive paths", () => {
  test("restores named instances to the instance directory", () => {
    expect(getRecoverRestorePath(entry("/tmp/vellum/test"), "/home/user")).toBe(
      "/tmp/vellum/test",
    );
  });

  test("restores the default local instance to its .vellum directory", () => {
    expect(getRecoverRestorePath(entry("/home/user"), "/home/user")).toBe(
      "/home/user/.vellum",
    );
  });

  test("extracts the archive staging directory next to the retired archive", () => {
    expect(getRecoverArchiveStagingDir("assistant")).toEndWith(
      "assistant.tar.gz.staging",
    );
  });
});
