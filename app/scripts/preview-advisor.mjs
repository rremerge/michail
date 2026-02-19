#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPortalHandler } from "../src/portal-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, "tmp", "advisor-preview.html");

function parseArgs(argv) {
  const args = {
    outputPath: DEFAULT_OUTPUT_PATH,
    openInBrowser: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--output" && argv[index + 1]) {
      args.outputPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item === "--open") {
      args.openInBrowser = true;
    }
  }

  return args;
}

function openFileInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  let command;
  let commandArgs;
  let useShell = false;

  if (process.platform === "darwin") {
    command = "open";
    commandArgs = [absolutePath];
  } else if (process.platform === "win32") {
    command = "start";
    commandArgs = [absolutePath];
    useShell = true;
  } else {
    command = "xdg-open";
    commandArgs = [absolutePath];
  }

  const child = spawn(command, commandArgs, {
    stdio: "ignore",
    detached: true,
    shell: useShell
  });
  child.unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envKeys = [
    "ADVISOR_PORTAL_AUTH_MODE",
    "ADVISOR_GOOGLE_OAUTH_ALLOWLIST",
    "ADVISOR_BASE_URL",
    "STAGE"
  ];
  const savedEnv = {};
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
  }

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_GOOGLE_OAUTH_ALLOWLIST = "";
  process.env.ADVISOR_BASE_URL = "http://localhost:3000";
  delete process.env.STAGE;

  try {
    const handler = createPortalHandler();
    const event = {
      rawPath: "/advisor",
      requestContext: {
        http: { method: "GET" },
        domainName: "localhost"
      }
    };

    const response = await handler(event, {});
    if (response.statusCode !== 200) {
      throw new Error(`Expected status 200 but received ${response.statusCode}`);
    }

    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, String(response.body ?? ""), "utf8");

    console.log(`Advisor preview HTML generated: ${args.outputPath}`);

    if (args.openInBrowser) {
      openFileInBrowser(args.outputPath);
      console.log("Opened preview in your default browser.");
    }
  } finally {
    for (const key of envKeys) {
      const originalValue = savedEnv[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
