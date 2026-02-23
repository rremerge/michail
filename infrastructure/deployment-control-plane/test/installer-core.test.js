import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonBody,
  resolveStartConfig,
  mapBuildStatus,
} from "../src/installer-core.js";

test("parseJsonBody parses json payload", () => {
  const parsed = parseJsonBody({ body: '{"gitRef":"main"}' });
  assert.equal(parsed.gitRef, "main");
});

test("resolveStartConfig applies defaults", () => {
  const config = resolveStartConfig(
    {},
    {
      defaultGitRef: "main",
      defaultStackName: "letsconnect-agent-prod",
      defaultTemplateFile: "template.yaml",
      defaultParameterOverrides: "Stage=prod",
      defaultSamTags: "App=letsconnectAgent",
      defaultGitRepoUrl: "https://github.com/example/repo.git",
      defaultSafeMode: true,
    },
  );

  assert.equal(config.gitRef, "main");
  assert.equal(config.stackName, "letsconnect-agent-prod");
  assert.equal(config.gitRepoUrl, "https://github.com/example/repo.git");
  assert.equal(config.safeMode, true);
});

test("resolveStartConfig rejects invalid stack name", () => {
  assert.throws(() => {
    resolveStartConfig(
      { stackName: "invalid stack" },
      {
        defaultGitRef: "main",
        defaultStackName: "letsconnect-agent-prod",
        defaultTemplateFile: "template.yaml",
        defaultParameterOverrides: "",
        defaultSamTags: "",
        defaultGitRepoUrl: "https://github.com/example/repo.git",
        defaultSafeMode: true,
      },
    );
  }, /Invalid stackName/);
});

test("resolveStartConfig supports safe mode override", () => {
  const config = resolveStartConfig(
    { safeMode: false },
    {
      defaultGitRef: "main",
      defaultStackName: "letsconnect-agent-prod",
      defaultTemplateFile: "template.yaml",
      defaultParameterOverrides: "",
      defaultSamTags: "App=letsconnectAgent",
      defaultGitRepoUrl: "https://github.com/example/repo.git",
      defaultSafeMode: true,
    },
  );

  assert.equal(config.safeMode, false);
});

test("mapBuildStatus maps terminal and running values", () => {
  assert.equal(mapBuildStatus("SUCCEEDED"), "succeeded");
  assert.equal(mapBuildStatus("FAILED"), "failed");
  assert.equal(mapBuildStatus("IN_PROGRESS"), "running");
  assert.equal(mapBuildStatus("QUEUED"), "running");
  assert.equal(mapBuildStatus("SOMETHING_ELSE"), "unknown");
});
