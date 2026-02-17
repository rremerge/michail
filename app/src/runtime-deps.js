import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

async function streamBodyToString(body) {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export function createRuntimeDeps() {
  const secretsClient = new SecretsManagerClient({});
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sesClient = new SESv2Client({});
  const s3ClientsByRegion = new Map();

  function getS3Client(region) {
    const normalizedRegion = String(region || "").trim();
    const regionKey = normalizedRegion || "default";
    if (!s3ClientsByRegion.has(regionKey)) {
      s3ClientsByRegion.set(regionKey, new S3Client(normalizedRegion ? { region: normalizedRegion } : {}));
    }

    return s3ClientsByRegion.get(regionKey);
  }

  return {
    async getSecretString(secretArn) {
      const response = await secretsClient.send(
        new GetSecretValueCommand({
          SecretId: secretArn
        })
      );

      if (!response.SecretString) {
        throw new Error("Google OAuth secret has no SecretString value");
      }

      return response.SecretString;
    },

    async writeTrace(traceTableName, item) {
      await ddbClient.send(
        new PutCommand({
          TableName: traceTableName,
          Item: item
        })
      );
    },

    async getTrace(traceTableName, requestId) {
      const response = await ddbClient.send(
        new GetCommand({
          TableName: traceTableName,
          Key: {
            requestId
          }
        })
      );

      return response.Item ?? null;
    },

    async updateTraceFeedback(
      traceTableName,
      { requestId, responseId, feedbackSource, feedbackType, feedbackReason, updatedAt }
    ) {
      try {
        const response = await ddbClient.send(
          new UpdateCommand({
            TableName: traceTableName,
            Key: {
              requestId
            },
            ConditionExpression: "attribute_exists(requestId) AND #responseId = :responseId",
            UpdateExpression:
              "SET #feedbackStatus = :feedbackStatus, #feedbackSource = :feedbackSource, #feedbackType = :feedbackType, #feedbackReason = :feedbackReason, #feedbackUpdatedAt = :feedbackUpdatedAt, #updatedAt = :updatedAt, #feedbackCount = if_not_exists(#feedbackCount, :zero) + :one",
            ExpressionAttributeNames: {
              "#responseId": "responseId",
              "#feedbackStatus": "feedbackStatus",
              "#feedbackSource": "feedbackSource",
              "#feedbackType": "feedbackType",
              "#feedbackReason": "feedbackReason",
              "#feedbackUpdatedAt": "feedbackUpdatedAt",
              "#updatedAt": "updatedAt",
              "#feedbackCount": "feedbackCount"
            },
            ExpressionAttributeValues: {
              ":responseId": responseId,
              ":feedbackStatus": "reported",
              ":feedbackSource": feedbackSource,
              ":feedbackType": feedbackType,
              ":feedbackReason": feedbackReason,
              ":feedbackUpdatedAt": updatedAt,
              ":updatedAt": updatedAt,
              ":zero": 0,
              ":one": 1
            },
            ReturnValues: "ALL_NEW"
          })
        );

        return response.Attributes ?? null;
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") {
          return null;
        }

        throw error;
      }
    },

    async listConnections(connectionsTableName, advisorId) {
      const response = await ddbClient.send(
        new QueryCommand({
          TableName: connectionsTableName,
          KeyConditionExpression: "advisorId = :advisorId",
          ExpressionAttributeValues: {
            ":advisorId": advisorId
          }
        })
      );

      return response.Items ?? [];
    },

    async getConnection(connectionsTableName, advisorId, connectionId) {
      const response = await ddbClient.send(
        new GetCommand({
          TableName: connectionsTableName,
          Key: {
            advisorId,
            connectionId
          }
        })
      );

      return response.Item ?? null;
    },

    async putConnection(connectionsTableName, item) {
      await ddbClient.send(
        new PutCommand({
          TableName: connectionsTableName,
          Item: item
        })
      );
    },

    async deleteConnection(connectionsTableName, advisorId, connectionId) {
      await ddbClient.send(
        new DeleteCommand({
          TableName: connectionsTableName,
          Key: {
            advisorId,
            connectionId
          }
        })
      );
    },

    async getPrimaryConnection(connectionsTableName, advisorId) {
      const connections = await this.listConnections(connectionsTableName, advisorId);
      const connected = connections.filter((item) => item.status === "connected");
      if (connected.length === 0) {
        return null;
      }

      const primary = connected.filter((item) => item.isPrimary === true);
      const candidates = primary.length > 0 ? primary : connected;
      candidates.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

      return candidates[0] ?? null;
    },

    async putOauthState(oauthStateTableName, state, item) {
      await ddbClient.send(
        new PutCommand({
          TableName: oauthStateTableName,
          Item: {
            state,
            ...item
          }
        })
      );
    },

    async getOauthState(oauthStateTableName, state) {
      const response = await ddbClient.send(
        new GetCommand({
          TableName: oauthStateTableName,
          Key: { state }
        })
      );

      return response.Item ?? null;
    },

    async deleteOauthState(oauthStateTableName, state) {
      await ddbClient.send(
        new DeleteCommand({
          TableName: oauthStateTableName,
          Key: { state }
        })
      );
    },

    async putAvailabilityLink(availabilityLinkTableName, item) {
      await ddbClient.send(
        new PutCommand({
          TableName: availabilityLinkTableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(tokenId)"
        })
      );
    },

    async getAvailabilityLink(availabilityLinkTableName, tokenId) {
      const response = await ddbClient.send(
        new GetCommand({
          TableName: availabilityLinkTableName,
          Key: { tokenId }
        })
      );

      return response.Item ?? null;
    },

    async getClientProfile(clientProfilesTableName, advisorId, clientId) {
      const response = await ddbClient.send(
        new GetCommand({
          TableName: clientProfilesTableName,
          Key: {
            advisorId,
            clientId
          }
        })
      );

      return response.Item ?? null;
    },

    async listClientProfiles(clientProfilesTableName, advisorId) {
      const response = await ddbClient.send(
        new QueryCommand({
          TableName: clientProfilesTableName,
          KeyConditionExpression: "advisorId = :advisorId",
          ExpressionAttributeValues: {
            ":advisorId": advisorId
          }
        })
      );

      return response.Items ?? [];
    },

    async putClientProfile(clientProfilesTableName, item) {
      await ddbClient.send(
        new PutCommand({
          TableName: clientProfilesTableName,
          Item: item
        })
      );
    },

    async recordClientEmailInteraction(
      clientProfilesTableName,
      { advisorId, clientId, clientEmail, clientDisplayName, accessState, policyId, updatedAt }
    ) {
      await ddbClient.send(
        new UpdateCommand({
          TableName: clientProfilesTableName,
          Key: {
            advisorId,
            clientId
          },
          UpdateExpression:
            "SET #clientEmail = if_not_exists(#clientEmail, :clientEmail), #clientDisplayName = if_not_exists(#clientDisplayName, :clientDisplayName), #firstInteractionAt = if_not_exists(#firstInteractionAt, :updatedAt), #lastInteractionAt = :updatedAt, #updatedAt = :updatedAt, #accessState = if_not_exists(#accessState, :accessState), #policyId = if_not_exists(#policyId, :policyId) ADD #emailAgentCount :one, #totalInteractionCount :one",
          ExpressionAttributeNames: {
            "#clientEmail": "clientEmail",
            "#clientDisplayName": "clientDisplayName",
            "#firstInteractionAt": "firstInteractionAt",
            "#lastInteractionAt": "lastInteractionAt",
            "#updatedAt": "updatedAt",
            "#accessState": "accessState",
            "#policyId": "policyId",
            "#emailAgentCount": "emailAgentCount",
            "#totalInteractionCount": "totalInteractionCount"
          },
          ExpressionAttributeValues: {
            ":clientEmail": clientEmail ?? "",
            ":clientDisplayName": clientDisplayName ?? "Client",
            ":updatedAt": updatedAt,
            ":accessState": accessState ?? "active",
            ":policyId": policyId ?? "default",
            ":one": 1
          }
        })
      );
    },

    async recordClientAvailabilityViewInteraction(
      clientProfilesTableName,
      { advisorId, clientId, clientEmail, clientDisplayName, accessState, policyId, updatedAt }
    ) {
      await ddbClient.send(
        new UpdateCommand({
          TableName: clientProfilesTableName,
          Key: {
            advisorId,
            clientId
          },
          UpdateExpression:
            "SET #clientEmail = if_not_exists(#clientEmail, :clientEmail), #clientDisplayName = if_not_exists(#clientDisplayName, :clientDisplayName), #firstInteractionAt = if_not_exists(#firstInteractionAt, :updatedAt), #lastInteractionAt = :updatedAt, #updatedAt = :updatedAt, #accessState = if_not_exists(#accessState, :accessState), #policyId = if_not_exists(#policyId, :policyId) ADD #availabilityWebCount :one, #totalInteractionCount :one",
          ExpressionAttributeNames: {
            "#clientEmail": "clientEmail",
            "#clientDisplayName": "clientDisplayName",
            "#firstInteractionAt": "firstInteractionAt",
            "#lastInteractionAt": "lastInteractionAt",
            "#updatedAt": "updatedAt",
            "#accessState": "accessState",
            "#policyId": "policyId",
            "#availabilityWebCount": "availabilityWebCount",
            "#totalInteractionCount": "totalInteractionCount"
          },
          ExpressionAttributeValues: {
            ":clientEmail": clientEmail ?? "",
            ":clientDisplayName": clientDisplayName ?? "Client",
            ":updatedAt": updatedAt,
            ":accessState": accessState ?? "active",
            ":policyId": policyId ?? "default",
            ":one": 1
          }
        })
      );
    },

    async createSecret(secretName, secretString) {
      const response = await secretsClient.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString
        })
      );

      if (!response.ARN) {
        throw new Error("SecretsManager createSecret did not return ARN");
      }

      return response.ARN;
    },

    async deleteSecret(secretArn) {
      await secretsClient.send(
        new DeleteSecretCommand({
          SecretId: secretArn,
          ForceDeleteWithoutRecovery: true
        })
      );
    },

    async sendResponseEmail({ senderEmail, recipientEmail, subject, bodyText }) {
      await sesClient.send(
        new SendEmailCommand({
          FromEmailAddress: senderEmail,
          Destination: {
            ToAddresses: [recipientEmail]
          },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: {
                Text: { Data: bodyText }
              }
            }
          }
        })
      );
    },

    async getRawEmailObject({ bucket, key, region }) {
      const s3Client = getS3Client(region);
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key
        })
      );

      return streamBodyToString(response.Body);
    },

    async deleteRawEmailObject({ bucket, key, region }) {
      const s3Client = getS3Client(region);
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key
        })
      );
    },

    async lookupBusyIntervals() {
      throw new Error("lookupBusyIntervals dependency not configured");
    }
  };
}
