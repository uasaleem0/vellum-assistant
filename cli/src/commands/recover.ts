import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { dirname, join } from "path";

import { getBaseDir, saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  generateLocalSigningKey,
  startLocalDaemon,
  startGateway,
} from "../lib/local";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive";
import { exec } from "../lib/step-runner";

export function getRecoverRestorePath(
  entry: AssistantEntry,
  baseDir = getBaseDir(),
): string {
  if (!entry.resources) {
    throw new Error(`Assistant '${entry.assistantId}' is missing resources.`);
  }
  return entry.resources.instanceDir === baseDir
    ? join(entry.resources.instanceDir, ".vellum")
    : entry.resources.instanceDir;
}

export function getRecoverArchiveStagingDir(name: string): string {
  return `${getArchivePath(name)}.staging`;
}

export async function recover(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum recover <name>");
    console.log("");
    console.log(
      "Restore a previously retired local assistant from its archive.",
    );
    console.log("");
    console.log("Arguments:");
    console.log("  <name>    Name of the retired assistant to recover");
    process.exit(0);
  }

  const name = process.argv[3];
  if (!name) {
    console.error("Usage: vellum recover <name>");
    process.exit(1);
  }

  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);

  // 1. Verify archive exists
  if (!existsSync(archivePath) || !existsSync(metadataPath)) {
    console.error(`No retired archive found for '${name}'.`);
    process.exit(1);
  }

  // 2. Read and validate metadata before any side effects
  const entry: AssistantEntry = JSON.parse(readFileSync(metadataPath, "utf-8"));
  if (!entry.resources) {
    throw new Error(
      `Retired assistant '${name}' is missing resource configuration. ` +
        `Fix the archive metadata at ${metadataPath} and retry, ` +
        `or run 'vellum hatch' to re-provision with proper resource allocation.`,
    );
  }

  // 3. Check that the recovering entry's own target directory is free.
  const target = getRecoverRestorePath(entry);
  if (existsSync(target)) {
    console.error(
      `Error: ${target} already exists (owned by ${entry.assistantId}). ` +
        `Retire the current assistant first.`,
    );
    process.exit(1);
  }

  // 4. Extract archive staging directory and move it back to the original path.
  const stagingDir = getRecoverArchiveStagingDir(name);
  if (existsSync(stagingDir)) {
    throw new Error(
      `Cannot recover '${name}': archive staging directory already exists at ${stagingDir}.`,
    );
  }
  await exec("tar", ["xzf", archivePath, "-C", dirname(stagingDir)]);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(stagingDir, target);

  // 5. Restore lockfile entry
  saveAssistantEntry(entry);

  // 6. Clean up archive
  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  // 7. Persist signing key so it survives daemon/gateway restarts (same as wake)
  const signingKey = generateLocalSigningKey();
  entry.resources = { ...entry.resources, signingKey };
  saveAssistantEntry(entry);

  // 8. Start daemon + gateway
  await startLocalDaemon(false, entry.resources, { signingKey });
  await startGateway(false, entry.resources, { signingKey });

  console.log(`✅ Recovered assistant '${name}'.`);
}
