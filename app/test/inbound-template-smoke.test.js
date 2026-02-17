import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const inboundTemplatePath = path.resolve(process.cwd(), "..", "infrastructure", "us-east-1-inbound", "template.yaml");

test("inbound template defines transient raw mail storage for us-east-1", () => {
  const template = fs.readFileSync(inboundTemplatePath, "utf8");

  assert.match(template, /Type:\s*AWS::S3::Bucket/);
  assert.match(template, /Type:\s*AWS::S3::BucketPolicy/);
  assert.match(template, /AllowSesWriteRawInboundMail/);
  assert.match(template, /ExpirationInDays:\s*1/);
  assert.match(template, /RawMailBucketName/);
  assert.match(template, /RawMailPrefix/);
});
