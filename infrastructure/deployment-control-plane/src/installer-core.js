const STACK_NAME_PATTERN = /^[a-zA-Z][-a-zA-Z0-9]*$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]{1,200}$/;

function cleanString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

export function parseJsonBody(event) {
  if (!event?.body) {
    return {};
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;

  if (!raw || !raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function resolveBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

export function resolveStartConfig(payload, defaults) {
  const gitRef = cleanString(payload.gitRef, defaults.defaultGitRef);
  if (!GIT_REF_PATTERN.test(gitRef)) {
    throw new Error("Invalid gitRef. Use branch, tag, or commit-like value.");
  }

  const stackName = cleanString(payload.stackName, defaults.defaultStackName);
  if (!STACK_NAME_PATTERN.test(stackName)) {
    throw new Error("Invalid stackName. Use letters, numbers, and dashes.");
  }

  const templateFile = cleanString(payload.templateFile, defaults.defaultTemplateFile);
  const parameterOverrides = cleanString(
    payload.parameterOverrides,
    defaults.defaultParameterOverrides,
  );
  const samTags = cleanString(payload.samTags, defaults.defaultSamTags);
  const gitRepoUrl = cleanString(payload.gitRepoUrl, defaults.defaultGitRepoUrl);
  const safeMode = resolveBoolean(payload.safeMode, defaults.defaultSafeMode);

  if (!gitRepoUrl) {
    throw new Error("gitRepoUrl is required.");
  }

  return {
    gitRef,
    stackName,
    templateFile,
    parameterOverrides,
    samTags,
    gitRepoUrl,
    safeMode,
  };
}

export function mapBuildStatus(buildStatus) {
  const status = (buildStatus || "UNKNOWN").toUpperCase();
  if (["SUCCEEDED"].includes(status)) {
    return "succeeded";
  }
  if (["FAILED", "FAULT", "STOPPED", "TIMED_OUT"].includes(status)) {
    return "failed";
  }
  if (["IN_PROGRESS", "QUEUED"].includes(status)) {
    return "running";
  }
  return "unknown";
}

export function renderInstallerPage({
  projectName,
  defaultGitRef,
  defaultStackName,
  defaultParameterOverrides,
  defaultSamTags,
  defaultSafeMode,
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LetsConnect Agent Installer</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      }
      body {
        margin: 0;
        background: #f4f6fb;
        color: #142033;
      }
      .wrap {
        max-width: 920px;
        margin: 32px auto;
        padding: 0 16px 24px;
      }
      .card {
        background: #ffffff;
        border: 1px solid #d7deef;
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 6px 16px rgba(16, 24, 40, 0.06);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 26px;
      }
      p {
        margin: 0 0 10px;
        line-height: 1.45;
      }
      label {
        display: block;
        font-weight: 600;
        margin: 14px 0 6px;
      }
      input,
      textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #b9c4dd;
        border-radius: 8px;
        font: inherit;
        padding: 10px;
      }
      textarea {
        min-height: 78px;
      }
      button {
        margin-top: 14px;
        background: #0c61ff;
        color: #fff;
        border: 0;
        border-radius: 8px;
        padding: 10px 16px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      pre {
        white-space: pre-wrap;
        background: #0b1220;
        color: #f8fafc;
        border-radius: 8px;
        padding: 12px;
        min-height: 110px;
      }
      .muted {
        color: #5a6783;
        font-size: 14px;
      }
      .toggle-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 14px;
      }
      .toggle-row input[type="checkbox"] {
        width: auto;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 14px;
      }
      .secondary {
        background: #1f2937;
      }
      .hidden {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>LetsConnect Agent Installer</h1>
        <p>Starts a containerized deploy job in CodeBuild. No local CLI toolkits are required.</p>
        <p class="muted">CodeBuild project: ${projectName}</p>

        <label for="gitRef">Git ref</label>
        <input id="gitRef" value="${defaultGitRef}" />

        <label for="stackName">Target stack name</label>
        <input id="stackName" value="${defaultStackName}" />

        <label for="parameterOverrides">SAM parameter overrides</label>
        <textarea id="parameterOverrides">${defaultParameterOverrides}</textarea>

        <label for="samTags">SAM tags</label>
        <input id="samTags" value="${defaultSamTags}" />

        <div class="toggle-row">
          <input id="safeMode" type="checkbox" ${defaultSafeMode ? "checked" : ""} />
          <label for="safeMode">Safe mode (create change set, require explicit approve)</label>
        </div>

        <div class="actions">
          <button id="startBtn">Start deployment</button>
          <button id="executeBtn" class="secondary hidden" type="button">Approve & Execute</button>
        </div>
        <p id="statusLine" class="muted"></p>
        <pre id="statusBox"></pre>
      </div>
    </div>
    <script>
      const startBtn = document.getElementById("startBtn");
      const executeBtn = document.getElementById("executeBtn");
      const statusLine = document.getElementById("statusLine");
      const statusBox = document.getElementById("statusBox");
      let activeDeploymentId = null;

      function setStatus(text, details) {
        statusLine.textContent = text;
        statusBox.textContent = details ? JSON.stringify(details, null, 2) : "";
      }

      async function poll(deploymentId) {
        const response = await fetch("deployments/" + deploymentId);
        const data = await response.json();
        const deploymentLabel =
          "Deployment " + deploymentId + ": " + (data.status || data.buildStatus || "unknown");
        setStatus(deploymentLabel, data);

        if ((data.status || "").toLowerCase() === "awaiting_approval") {
          executeBtn.classList.remove("hidden");
          return;
        }
        executeBtn.classList.add("hidden");

        const terminal = ["succeeded", "failed"];
        if (!terminal.includes((data.status || "").toLowerCase())) {
          setTimeout(() => poll(deploymentId), 5000);
        }
      }

      executeBtn.addEventListener("click", async () => {
        if (!activeDeploymentId) {
          return;
        }
        executeBtn.disabled = true;
        setStatus("Executing approved change set...", null);
        try {
          const response = await fetch("deployments/" + activeDeploymentId + "/execute", {
            method: "POST",
            headers: { "content-type": "application/json" },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.message || "Failed to execute change set.");
          }
          setStatus("Change set execution started.", data);
          executeBtn.classList.add("hidden");
          poll(activeDeploymentId);
        } catch (error) {
          setStatus("Error: " + error.message, { error: error.message });
        } finally {
          executeBtn.disabled = false;
        }
      });

      startBtn.addEventListener("click", async () => {
        startBtn.disabled = true;
        executeBtn.classList.add("hidden");
        setStatus("Starting deployment...", null);
        try {
          const payload = {
            gitRef: document.getElementById("gitRef").value,
            stackName: document.getElementById("stackName").value,
            parameterOverrides: document.getElementById("parameterOverrides").value,
            samTags: document.getElementById("samTags").value,
            safeMode: document.getElementById("safeMode").checked,
          };

          const response = await fetch("deployments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.message || "Failed to start deployment.");
          }

          activeDeploymentId = data.deploymentId;
          setStatus("Deployment started.", data);
          poll(data.deploymentId);
        } catch (error) {
          setStatus("Error: " + error.message, { error: error.message });
        } finally {
          startBtn.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}
