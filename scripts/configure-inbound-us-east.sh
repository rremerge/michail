#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGION="${REGION:-us-east-1}"
APP_NAME="${APP_NAME:-calendar-agent-spike}"
STAGE="${STAGE:-dev}"
SAM_STACK_NAME="${SAM_STACK_NAME:-${APP_NAME}-${STAGE}}"
INBOUND_STACK_NAME="${INBOUND_STACK_NAME:-${APP_NAME}-${STAGE}-inbound}"
RULE_SET_NAME="${RULE_SET_NAME:-${SAM_STACK_NAME}-inbound}"
RULE_NAME="${RULE_NAME:-agent-inbound}"
RECIPIENT_EMAIL="${RECIPIENT_EMAIL:-agent@agent.letsconnect.ai}"
SENDER_EMAIL="${SENDER_EMAIL:-agent@agent.letsconnect.ai}"
RAW_MAIL_PREFIX="${RAW_MAIL_PREFIX:-raw/}"
RAW_MAIL_BUCKET_NAME="${RAW_MAIL_BUCKET_NAME:-}"
SES_PERMISSION_STATEMENT_ID="${SES_PERMISSION_STATEMENT_ID:-calendar-agent-spike-ses-inbound}"

if [[ "${REGION}" != "us-east-1" ]]; then
  echo "This script is intended for us-east-1 only. Set REGION=us-east-1." >&2
  exit 1
fi

echo "Deploying inbound raw-mail infrastructure stack: ${INBOUND_STACK_NAME}"
aws --region "${REGION}" cloudformation deploy \
  --stack-name "${INBOUND_STACK_NAME}" \
  --template-file "${ROOT_DIR}/infrastructure/us-east-1-inbound/template.yaml" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    AppName="${APP_NAME}" \
    Stage="${STAGE}" \
    RawMailPrefix="${RAW_MAIL_PREFIX}" \
    RawMailBucketName="${RAW_MAIL_BUCKET_NAME}"

RAW_BUCKET="$(aws --region "${REGION}" cloudformation describe-stacks \
  --stack-name "${INBOUND_STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='RawMailBucketName'].OutputValue | [0]" \
  --output text)"

if [[ -z "${RAW_BUCKET}" || "${RAW_BUCKET}" == "None" ]]; then
  echo "Failed to resolve RawMailBucketName output from ${INBOUND_STACK_NAME}" >&2
  exit 1
fi

EMAIL_FUNCTION_NAME="$(aws --region "${REGION}" cloudformation describe-stack-resource \
  --stack-name "${SAM_STACK_NAME}" \
  --logical-resource-id EmailSpikeFunction \
  --query "StackResourceDetail.PhysicalResourceId" \
  --output text)"

if [[ -z "${EMAIL_FUNCTION_NAME}" || "${EMAIL_FUNCTION_NAME}" == "None" ]]; then
  echo "Failed to resolve EmailSpikeFunction name from stack ${SAM_STACK_NAME}" >&2
  exit 1
fi

EMAIL_FUNCTION_ARN="$(aws --region "${REGION}" lambda get-function \
  --function-name "${EMAIL_FUNCTION_NAME}" \
  --query "Configuration.FunctionArn" \
  --output text)"

if [[ -z "${EMAIL_FUNCTION_ARN}" || "${EMAIL_FUNCTION_ARN}" == "None" ]]; then
  echo "Failed to resolve EmailSpikeFunction ARN from Lambda API" >&2
  exit 1
fi

ACCOUNT_ID="$(aws --region "${REGION}" sts get-caller-identity --query "Account" --output text)"
SOURCE_ARN="arn:aws:ses:${REGION}:${ACCOUNT_ID}:receipt-rule-set/${RULE_SET_NAME}:receipt-rule/${RULE_NAME}"

if ! aws --region "${REGION}" ses describe-receipt-rule-set --rule-set-name "${RULE_SET_NAME}" >/dev/null 2>&1; then
  echo "Creating SES receipt rule set: ${RULE_SET_NAME}"
  aws --region "${REGION}" ses create-receipt-rule-set --rule-set-name "${RULE_SET_NAME}"
fi

echo "Activating SES receipt rule set: ${RULE_SET_NAME}"
aws --region "${REGION}" ses set-active-receipt-rule-set --rule-set-name "${RULE_SET_NAME}"

if aws --region "${REGION}" lambda get-policy --function-name "${EMAIL_FUNCTION_NAME}" >/dev/null 2>&1; then
  if aws --region "${REGION}" lambda get-policy --function-name "${EMAIL_FUNCTION_NAME}" \
    --query "Policy" --output text | grep -q "\"Sid\":\"${SES_PERMISSION_STATEMENT_ID}\""; then
    aws --region "${REGION}" lambda remove-permission \
      --function-name "${EMAIL_FUNCTION_NAME}" \
      --statement-id "${SES_PERMISSION_STATEMENT_ID}" >/dev/null
  fi
fi

echo "Granting SES invoke permission on EmailSpikeFunction"
aws --region "${REGION}" lambda add-permission \
  --function-name "${EMAIL_FUNCTION_NAME}" \
  --statement-id "${SES_PERMISSION_STATEMENT_ID}" \
  --action lambda:InvokeFunction \
  --principal ses.amazonaws.com \
  --source-arn "${SOURCE_ARN}" >/dev/null

RULE_JSON_FILE="$(mktemp)"
cleanup() {
  rm -f "${RULE_JSON_FILE}"
}
trap cleanup EXIT

cat > "${RULE_JSON_FILE}" <<JSON
{
  "Name": "${RULE_NAME}",
  "Enabled": true,
  "TlsPolicy": "Optional",
  "Recipients": ["${RECIPIENT_EMAIL}"],
  "Actions": [
    {
      "S3Action": {
        "BucketName": "${RAW_BUCKET}",
        "ObjectKeyPrefix": "${RAW_MAIL_PREFIX}"
      }
    },
    {
      "LambdaAction": {
        "FunctionArn": "${EMAIL_FUNCTION_ARN}",
        "InvocationType": "Event"
      }
    },
    {
      "StopAction": {
        "Scope": "RuleSet"
      }
    }
  ],
  "ScanEnabled": true
}
JSON

if aws --region "${REGION}" ses describe-receipt-rule \
  --rule-set-name "${RULE_SET_NAME}" \
  --rule-name "${RULE_NAME}" >/dev/null 2>&1; then
  echo "Updating existing SES receipt rule: ${RULE_NAME}"
  aws --region "${REGION}" ses update-receipt-rule \
    --rule-set-name "${RULE_SET_NAME}" \
    --rule "file://${RULE_JSON_FILE}"
else
  echo "Creating SES receipt rule: ${RULE_NAME}"
  aws --region "${REGION}" ses create-receipt-rule \
    --rule-set-name "${RULE_SET_NAME}" \
    --rule "file://${RULE_JSON_FILE}"
fi

echo "Redeploying SAM stack with raw mail bucket parameters"
sam deploy \
  --region "${REGION}" \
  --stack-name "${SAM_STACK_NAME}" \
  --template-file "${ROOT_DIR}/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    SenderEmail="${SENDER_EMAIL}" \
    InboundRawEmailBucket="${RAW_BUCKET}" \
    InboundRawEmailBucketRegion="${REGION}" \
    InboundRawEmailObjectPrefix="${RAW_MAIL_PREFIX}"

cat <<EOF
Inbound configuration complete.
- Recipient: ${RECIPIENT_EMAIL}
- Rule set: ${RULE_SET_NAME}
- Rule name: ${RULE_NAME}
- Sender email: ${SENDER_EMAIL}
- Raw MIME bucket: ${RAW_BUCKET}
- Raw MIME prefix: ${RAW_MAIL_PREFIX}
EOF
