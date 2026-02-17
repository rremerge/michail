import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const templatePath = path.resolve(process.cwd(), "..", "template.yaml");

test("template defines isolated serverless resources", () => {
  const template = fs.readFileSync(templatePath, "utf8");

  assert.match(template, /Transform:\s*AWS::Serverless-2016-10-31/);
  assert.match(template, /Type:\s*AWS::Serverless::Function/);
  assert.match(template, /Type:\s*AWS::DynamoDB::Table/);
  assert.match(template, /Type:\s*AWS::SecretsManager::Secret/);
  assert.match(template, /CALENDAR_MODE/);
  assert.match(template, /AdvisorPortalFunction/);
  assert.match(template, /ConnectionsTable/);
  assert.match(template, /OAuthStateTable/);
  assert.match(template, /LlmProviderSecret/);
  assert.match(template, /AdvisorPortalAuthSecret/);
  assert.match(template, /AdvisorPortalSessionSecret/);
  assert.match(template, /Path:\s*\/spike\/feedback/);
  assert.match(template, /Path:\s*\/availability/);
  assert.match(template, /Path:\s*\/advisor\/api\/traces\/\{requestId\}/);
  assert.match(template, /Path:\s*\/advisor\/api\/traces\/\{requestId\}\/feedback/);
  assert.match(template, /TRACE_TABLE_NAME/);
  assert.match(template, /AvailabilityLinkTable/);
  assert.match(template, /AVAILABILITY_LINK_TABLE_NAME/);
  assert.match(template, /INTENT_EXTRACTION_MODE/);
  assert.match(template, /InboundRawEmailBucket/);
  assert.match(template, /RAW_EMAIL_BUCKET/);
  assert.match(template, /AVAILABILITY_LINK_BASE_URL/);
  assert.match(template, /AVAILABILITY_LINK_SECRET_ARN/);

  // Guardrail: this spike must not install account-level SES receipt rules.
  assert.equal(template.includes("AWS::SES::ReceiptRule"), false);
  assert.equal(template.includes("AWS::SES::ReceiptRuleSet"), false);
});
