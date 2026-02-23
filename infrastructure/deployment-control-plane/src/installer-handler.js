import crypto from "node:crypto";
import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } from "@aws-sdk/client-codebuild";
import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  ListChangeSetsCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  mapBuildStatus,
  parseJsonBody,
  resolveStartConfig,
  renderInstallerPage,
} from "./installer-core.js";

const REGION = process.env.AWS_REGION || "us-east-1";
const DEPLOYMENT_TABLE_NAME = process.env.DEPLOYMENT_TABLE_NAME;
const CODEBUILD_PROJECT_NAME = process.env.CODEBUILD_PROJECT_NAME;
const DEFAULT_GIT_REF = process.env.DEFAULT_GIT_REF || "main";
const DEFAULT_STACK_NAME = process.env.DEFAULT_STACK_NAME || "letsconnect-agent-prod";
const DEFAULT_TEMPLATE_FILE = process.env.DEFAULT_TEMPLATE_FILE || "template.yaml";
const DEFAULT_PARAMETER_OVERRIDES =
  process.env.DEFAULT_PARAMETER_OVERRIDES ||
  "Stage=prod,AppName=letsconnectAgent,StrictMultiTenantMode=true";
const DEFAULT_SAM_TAGS = process.env.DEFAULT_SAM_TAGS || "App=letsconnectAgent";
const DEFAULT_GIT_REPO_URL = process.env.DEFAULT_GIT_REPO_URL || "";
const DEFAULT_SAFE_MODE = String(process.env.DEFAULT_SAFE_MODE || "true").toLowerCase() === "true";

const codeBuildClient = new CodeBuildClient({ region: REGION });
const cloudFormationClient = new CloudFormationClient({ region: REGION });
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

function htmlResponse(body) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body,
  };
}

function getRequestPath(event) {
  const rawPath = event?.rawPath || event?.path || "/";
  if (!rawPath || rawPath === "/") {
    return "/";
  }
  const stage = event?.requestContext?.stage;
  if (stage && stage !== "$default") {
    const stagePrefix = `/${stage}`;
    if (rawPath === stagePrefix) {
      return "/";
    }
    if (rawPath.startsWith(`${stagePrefix}/`)) {
      return rawPath.slice(stagePrefix.length) || "/";
    }
  }
  return rawPath;
}

function getMethod(event) {
  return (event?.requestContext?.http?.method || event?.httpMethod || "GET").toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function buildEnvironmentOverrides(config, deploymentId) {
  return [
    { name: "DEPLOYMENT_ID", value: deploymentId, type: "PLAINTEXT" },
    { name: "GIT_REF", value: config.gitRef, type: "PLAINTEXT" },
    { name: "GIT_REPO_URL", value: config.gitRepoUrl, type: "PLAINTEXT" },
    { name: "APP_STACK_NAME", value: config.stackName, type: "PLAINTEXT" },
    { name: "APP_TEMPLATE_FILE", value: config.templateFile, type: "PLAINTEXT" },
    { name: "SAM_PARAMETER_OVERRIDES", value: config.parameterOverrides, type: "PLAINTEXT" },
    { name: "SAM_TAGS", value: config.samTags, type: "PLAINTEXT" },
    { name: "DEPLOY_SAFE_MODE", value: config.safeMode ? "true" : "false", type: "PLAINTEXT" },
  ];
}

async function findPendingChangeSet(stackName) {
  const listResult = await cloudFormationClient.send(
    new ListChangeSetsCommand({ StackName: stackName }),
  );
  const summaries = listResult?.Summaries || [];
  const pending = summaries
    .filter((summary) => summary?.Status === "CREATE_COMPLETE" && summary?.ExecutionStatus === "AVAILABLE")
    .sort((left, right) => {
      const l = left?.CreationTime ? Date.parse(left.CreationTime) : 0;
      const r = right?.CreationTime ? Date.parse(right.CreationTime) : 0;
      return r - l;
    })[0];

  if (!pending) {
    return null;
  }

  const details = await cloudFormationClient.send(
    new DescribeChangeSetCommand({
      StackName: stackName,
      ChangeSetName: pending.ChangeSetName,
    }),
  );

  return {
    changeSetName: pending.ChangeSetName,
    changeSetArn: pending.ChangeSetId || details?.ChangeSetId || null,
    executionStatus: details?.ExecutionStatus || pending.ExecutionStatus || null,
    status: details?.Status || pending.Status || null,
  };
}

async function startDeployment(event) {
  const payload = parseJsonBody(event);
  const config = resolveStartConfig(payload, {
    defaultGitRef: DEFAULT_GIT_REF,
    defaultStackName: DEFAULT_STACK_NAME,
    defaultTemplateFile: DEFAULT_TEMPLATE_FILE,
    defaultParameterOverrides: DEFAULT_PARAMETER_OVERRIDES,
    defaultSamTags: DEFAULT_SAM_TAGS,
    defaultGitRepoUrl: DEFAULT_GIT_REPO_URL,
    defaultSafeMode: DEFAULT_SAFE_MODE,
  });

  const deploymentId = `dep-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const buildResult = await codeBuildClient.send(
    new StartBuildCommand({
      projectName: CODEBUILD_PROJECT_NAME,
      environmentVariablesOverride: buildEnvironmentOverrides(config, deploymentId),
    }),
  );

  const buildId = buildResult?.build?.id;
  if (!buildId) {
    throw new Error("CodeBuild did not return a build ID.");
  }

  const createdAt = nowIso();
  await ddbClient.send(
    new PutCommand({
      TableName: DEPLOYMENT_TABLE_NAME,
      Item: {
        deploymentId,
        buildId,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        stackName: config.stackName,
        gitRef: config.gitRef,
        safeMode: config.safeMode,
      },
    }),
  );

  return jsonResponse(202, {
    deploymentId,
    buildId,
    status: "running",
    stackName: config.stackName,
    gitRef: config.gitRef,
    safeMode: config.safeMode,
  });
}

async function getDeploymentStatus(deploymentId) {
  const recordResult = await ddbClient.send(
    new GetCommand({
      TableName: DEPLOYMENT_TABLE_NAME,
      Key: { deploymentId },
    }),
  );

  const record = recordResult?.Item;
  if (!record) {
    return jsonResponse(404, { message: "Deployment not found.", deploymentId });
  }

  let buildStatus = record.buildStatus || "UNKNOWN";
  let status = record.status || "unknown";
  let logsDeepLink = record.logsDeepLink || null;
  let currentPhase = record.currentPhase || null;
  let changeSetName = record.changeSetName || null;
  let changeSetArn = record.changeSetArn || null;
  const safeMode = Boolean(record.safeMode);

  if (record.buildId) {
    const buildLookup = await codeBuildClient.send(
      new BatchGetBuildsCommand({ ids: [record.buildId] }),
    );
    const build = buildLookup?.builds?.[0];

    if (build) {
      buildStatus = build.buildStatus || buildStatus;
      status = mapBuildStatus(buildStatus);
      logsDeepLink = build.logs?.deepLink || logsDeepLink;
      currentPhase = build.currentPhase || currentPhase;

      if (safeMode && status === "succeeded") {
        const pending = await findPendingChangeSet(record.stackName);
        if (pending) {
          status = "awaiting_approval";
          changeSetName = pending.changeSetName;
          changeSetArn = pending.changeSetArn;
        }
      }

      await ddbClient.send(
        new UpdateCommand({
          TableName: DEPLOYMENT_TABLE_NAME,
          Key: { deploymentId },
          UpdateExpression:
            "SET #status = :status, buildStatus = :buildStatus, logsDeepLink = :logsDeepLink, currentPhase = :currentPhase, changeSetName = :changeSetName, changeSetArn = :changeSetArn, updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": status,
            ":buildStatus": buildStatus,
            ":logsDeepLink": logsDeepLink,
            ":currentPhase": currentPhase,
            ":changeSetName": changeSetName,
            ":changeSetArn": changeSetArn,
            ":updatedAt": nowIso(),
          },
        }),
      );
    }
  }

  return jsonResponse(200, {
    deploymentId,
    buildId: record.buildId,
    status,
    buildStatus,
    currentPhase,
    logsDeepLink,
    stackName: record.stackName,
    gitRef: record.gitRef,
    safeMode,
    changeSetName,
    changeSetArn,
    createdAt: record.createdAt,
    updatedAt: nowIso(),
  });
}

async function executeDeployment(deploymentId) {
  const recordResult = await ddbClient.send(
    new GetCommand({
      TableName: DEPLOYMENT_TABLE_NAME,
      Key: { deploymentId },
    }),
  );
  const record = recordResult?.Item;
  if (!record) {
    return jsonResponse(404, { message: "Deployment not found.", deploymentId });
  }

  if (!record.safeMode) {
    return jsonResponse(400, {
      message: "Deployment is not in safe mode.",
      deploymentId,
    });
  }

  const pending =
    (await findPendingChangeSet(record.stackName)) || {
      changeSetName: record.changeSetName,
      changeSetArn: record.changeSetArn,
    };

  if (!pending?.changeSetName) {
    return jsonResponse(409, {
      message: "No pending change set is available for execution.",
      deploymentId,
      stackName: record.stackName,
    });
  }

  await cloudFormationClient.send(
    new ExecuteChangeSetCommand({
      StackName: record.stackName,
      ChangeSetName: pending.changeSetName,
    }),
  );

  await ddbClient.send(
    new UpdateCommand({
      TableName: DEPLOYMENT_TABLE_NAME,
      Key: { deploymentId },
      UpdateExpression:
        "SET #status = :status, changeSetName = :changeSetName, changeSetArn = :changeSetArn, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": "running",
        ":changeSetName": pending.changeSetName,
        ":changeSetArn": pending.changeSetArn || null,
        ":updatedAt": nowIso(),
      },
    }),
  );

  return jsonResponse(202, {
    deploymentId,
    status: "running",
    stackName: record.stackName,
    changeSetName: pending.changeSetName,
  });
}

export async function handler(event) {
  try {
    const method = getMethod(event);
    const path = getRequestPath(event);

    if (method === "GET" && (path === "/" || path === "/installer")) {
      return htmlResponse(
        renderInstallerPage({
          projectName: CODEBUILD_PROJECT_NAME,
          defaultGitRef: DEFAULT_GIT_REF,
          defaultStackName: DEFAULT_STACK_NAME,
          defaultParameterOverrides: DEFAULT_PARAMETER_OVERRIDES,
          defaultSamTags: DEFAULT_SAM_TAGS,
          defaultSafeMode: DEFAULT_SAFE_MODE,
        }),
      );
    }

    if (method === "POST" && path === "/deployments") {
      return await startDeployment(event);
    }

    const deploymentMatch = path.match(/^\/deployments\/([^/]+)$/);
    if (method === "GET" && deploymentMatch) {
      return await getDeploymentStatus(deploymentMatch[1]);
    }

    const deploymentExecuteMatch = path.match(/^\/deployments\/([^/]+)\/execute$/);
    if (method === "POST" && deploymentExecuteMatch) {
      return await executeDeployment(deploymentExecuteMatch[1]);
    }

    return jsonResponse(404, { message: "Not found." });
  } catch (error) {
    console.error("installer_error", {
      message: error?.message,
      stack: error?.stack,
    });
    return jsonResponse(500, {
      message: error?.message || "Unexpected installer error.",
    });
  }
}
