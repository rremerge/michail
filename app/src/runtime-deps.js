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
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export function createRuntimeDeps() {
  const secretsClient = new SecretsManagerClient({});
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sesClient = new SESv2Client({});

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

    async lookupBusyIntervals() {
      throw new Error("lookupBusyIntervals dependency not configured");
    }
  };
}
