#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { createPortalHandler } from "../src/portal-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const DEFAULT_FIXTURE_PATH = path.join(APP_DIR, "fixtures", "availability-preview.json");
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, "tmp", "availability-preview.html");
const DEFAULT_TOKEN = "local-preview-token";

const WEEKDAY_MAP = new Map([
  ["sun", "sun"],
  ["sunday", "sun"],
  ["mon", "mon"],
  ["monday", "mon"],
  ["tue", "tue"],
  ["tuesday", "tue"],
  ["wed", "wed"],
  ["wednesday", "wed"],
  ["thu", "thu"],
  ["thursday", "thu"],
  ["fri", "fri"],
  ["friday", "fri"],
  ["sat", "sat"],
  ["saturday", "sat"]
]);

function parseArgs(argv) {
  const args = {
    fixturePath: DEFAULT_FIXTURE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    token: DEFAULT_TOKEN,
    weekOffset: "0",
    openInBrowser: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--fixture" && argv[index + 1]) {
      args.fixturePath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item === "--output" && argv[index + 1]) {
      args.outputPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item === "--token" && argv[index + 1]) {
      args.token = String(argv[index + 1]).trim() || DEFAULT_TOKEN;
      index += 1;
      continue;
    }
    if (item === "--week-offset" && argv[index + 1]) {
      args.weekOffset = String(argv[index + 1]).trim() || "0";
      index += 1;
      continue;
    }
    if (item === "--open") {
      args.openInBrowser = true;
    }
  }

  return args;
}

function normalizeWeekday(value) {
  const key = String(value ?? "").trim().toLowerCase();
  const normalized = WEEKDAY_MAP.get(key);
  if (!normalized) {
    throw new Error(`Unsupported weekday value: ${value}`);
  }
  return normalized;
}

function parseTimeString(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error(`Invalid time format: ${value}. Expected HH:mm`);
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time value: ${value}`);
  }

  return { hour, minute };
}

function findLocalDayInWindow({ day, searchStartIso, hostTimezone }) {
  const targetWeekday = normalizeWeekday(day);
  let cursor = DateTime.fromISO(searchStartIso, { zone: "utc" }).setZone(hostTimezone).startOf("day");

  for (let index = 0; index < 7; index += 1) {
    if (cursor.toFormat("ccc").toLowerCase() === targetWeekday) {
      return cursor;
    }
    cursor = cursor.plus({ days: 1 });
  }

  throw new Error(`Could not find weekday ${day} in preview window`);
}

function intervalFromFixtureEntry({ entry, searchStartIso, hostTimezone }) {
  const dayBase = findLocalDayInWindow({
    day: entry.day,
    searchStartIso,
    hostTimezone
  });
  const startTime = parseTimeString(entry.start);
  const endTime = parseTimeString(entry.end);
  const startLocal = dayBase.set({
    hour: startTime.hour,
    minute: startTime.minute,
    second: 0,
    millisecond: 0
  });
  const endLocal = dayBase.set({
    hour: endTime.hour,
    minute: endTime.minute,
    second: 0,
    millisecond: 0
  });

  if (endLocal <= startLocal) {
    throw new Error(`Fixture interval end must be after start (${entry.day} ${entry.start}-${entry.end})`);
  }

  return {
    startIso: startLocal.toUTC().toISO(),
    endIso: endLocal.toUTC().toISO()
  };
}

function sortIntervals(items) {
  return items.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso));
}

function dedupeIntervals(items) {
  const deduped = new Map();
  for (const item of items) {
    const key = `${item.startIso}|${item.endIso}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

function buildPreviewCalendarData({ fixture, searchStartIso }) {
  const hostTimezone = fixture.advisor?.timezone ?? "America/Los_Angeles";

  const clientMeetings = (fixture.clientMeetings ?? []).map((entry, index) => {
    const interval = intervalFromFixtureEntry({
      entry,
      searchStartIso,
      hostTimezone
    });
    return {
      eventId: `preview-client-${index + 1}`,
      ...interval,
      title: String(entry.title ?? "").trim() || "Client meeting",
      advisorResponseStatus: String(entry.advisorResponseStatus ?? "").trim() || "needsAction"
    };
  });

  const nonClientBusyIntervals = (fixture.nonClientConflictIntervals ?? []).map((entry) =>
    intervalFromFixtureEntry({
      entry,
      searchStartIso,
      hostTimezone
    })
  );

  const baseBusyIntervals = (fixture.busyIntervals ?? []).map((entry) =>
    intervalFromFixtureEntry({
      entry,
      searchStartIso,
      hostTimezone
    })
  );

  const busyIntervals = dedupeIntervals(
    sortIntervals([...baseBusyIntervals, ...clientMeetings, ...nonClientBusyIntervals])
  );

  return {
    busyIntervals,
    clientMeetings: sortIntervals(clientMeetings),
    nonClientBusyIntervals: sortIntervals(nonClientBusyIntervals)
  };
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
  const fixtureText = await fs.readFile(args.fixturePath, "utf8");
  const fixture = JSON.parse(fixtureText);

  const advisorTimezone = fixture.advisor?.timezone ?? "America/Los_Angeles";
  const advisorId = fixture.advisor?.id ?? "manoj";
  const advisingDays = Array.isArray(fixture.advisor?.advisingDays) ? fixture.advisor.advisingDays : ["Tue", "Wed"];
  const workdayStartHour = Number.parseInt(String(fixture.advisor?.workdayStartHour ?? "9"), 10);
  const workdayEndHour = Number.parseInt(String(fixture.advisor?.workdayEndHour ?? "17"), 10);
  const durationMinutes = Number.parseInt(String(fixture.durationMinutes ?? "30"), 10);

  const clientId = String(fixture.client?.id ?? "preview.client@example.com").trim().toLowerCase();
  const clientEmail = String(fixture.client?.email ?? clientId).trim().toLowerCase();
  const clientDisplayName = String(fixture.client?.displayName ?? "Preview Client").trim();
  const clientReference = String(fixture.client?.reference ?? "preview-client").trim();

  const savedEnv = {};
  const envKeys = [
    "ADVISOR_PORTAL_AUTH_MODE",
    "ADVISOR_ID",
    "HOST_TIMEZONE",
    "ADVISING_DAYS",
    "WORKDAY_START_HOUR",
    "WORKDAY_END_HOUR",
    "DEFAULT_DURATION_MINUTES",
    "MAX_DURATION_MINUTES",
    "AVAILABILITY_VIEW_MAX_SLOTS",
    "CALENDAR_MODE",
    "AVAILABILITY_LINK_TABLE_NAME",
    "CONNECTIONS_TABLE_NAME",
    "STAGE"
  ];
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
  }

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = advisorId;
  process.env.HOST_TIMEZONE = advisorTimezone;
  process.env.ADVISING_DAYS = advisingDays.join(",");
  process.env.WORKDAY_START_HOUR = String(workdayStartHour);
  process.env.WORKDAY_END_HOUR = String(workdayEndHour);
  process.env.DEFAULT_DURATION_MINUTES = String(durationMinutes);
  process.env.MAX_DURATION_MINUTES = "180";
  process.env.AVAILABILITY_VIEW_MAX_SLOTS = "400";
  process.env.CALENDAR_MODE = "connection";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "PreviewAvailabilityLinkTable";
  process.env.CONNECTIONS_TABLE_NAME = "PreviewConnectionsTable";
  process.env.STAGE = "local";

  try {
    const handler = createPortalHandler({
      async getAvailabilityLink(_tableName, tokenId) {
        return {
          tokenId,
          advisorId,
          clientId,
          clientEmail,
          clientDisplayName,
          clientReference,
          durationMinutes,
          expiresAtMs: Date.now() + 48 * 60 * 60 * 1000
        };
      },
      async getPrimaryConnection() {
        return {
          advisorId,
          connectionId: "preview-google-connection",
          provider: "google",
          status: "connected",
          isPrimary: true,
          accountEmail: fixture.advisor?.calendarAccountEmail ?? "advisor@example.com",
          secretArn: "arn:preview:secret"
        };
      },
      async getSecretString() {
        return JSON.stringify({
          client_id: "preview-client-id",
          client_secret: "preview-client-secret",
          refresh_token: "preview-refresh-token",
          calendar_ids: ["primary"]
        });
      },
      async lookupBusyIntervals({ windowStartIso }) {
        return buildPreviewCalendarData({
          fixture,
          searchStartIso: windowStartIso
        }).busyIntervals;
      },
      async lookupClientMeetings({ windowStartIso }) {
        const data = buildPreviewCalendarData({
          fixture,
          searchStartIso: windowStartIso
        });
        return {
          clientMeetings: data.clientMeetings,
          nonClientBusyIntervals: data.nonClientBusyIntervals
        };
      },
      async recordClientAvailabilityViewInteraction() {}
    });

    const response = await handler({
      queryStringParameters: {
        t: args.token,
        for: clientReference,
        weekOffset: args.weekOffset
      },
      requestContext: {
        stage: "local",
        http: { method: "GET" }
      },
      rawPath: "/availability"
    });

    if (response.statusCode !== 200) {
      throw new Error(`Preview render failed (${response.statusCode}): ${response.body}`);
    }

    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, response.body, "utf8");

    const absoluteOutputPath = path.resolve(args.outputPath);
    console.log(`Preview HTML generated: ${absoluteOutputPath}`);
    console.log(`Fixture used: ${path.resolve(args.fixturePath)}`);
    if (args.openInBrowser) {
      openFileInBrowser(absoluteOutputPath);
      console.log("Opened preview in browser.");
    } else {
      console.log("Tip: run with --open to launch it automatically.");
    }
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
