#!/usr/bin/env bash
set -euo pipefail

APP_STACK_NAME="${APP_STACK_NAME:?APP_STACK_NAME is required}"
APP_TEMPLATE_FILE="${APP_TEMPLATE_FILE:-template.yaml}"
SAM_BUILD_DIR="${SAM_BUILD_DIR:-.aws-sam/build}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SAM_PARAMETER_OVERRIDES="${SAM_PARAMETER_OVERRIDES:-}"
SAM_TAGS="${SAM_TAGS:-App=letsconnectAgent}"
DEPLOY_SAFE_MODE="${DEPLOY_SAFE_MODE:-true}"

if [[ ! -f "${APP_TEMPLATE_FILE}" ]]; then
  echo "Template file not found: ${APP_TEMPLATE_FILE}" >&2
  exit 1
fi

echo "Installing application dependencies"
npm --prefix app ci

echo "Running unit tests"
npm --prefix app test

echo "Building SAM application"
sam build --template-file "${APP_TEMPLATE_FILE}" --build-dir "${SAM_BUILD_DIR}"

deploy_cmd=(
  sam deploy
  --region "${AWS_REGION}"
  --stack-name "${APP_STACK_NAME}"
  --template-file "${SAM_BUILD_DIR}/template.yaml"
  --capabilities CAPABILITY_IAM
  --resolve-s3
  --no-confirm-changeset
  --no-fail-on-empty-changeset
)

if [[ "${DEPLOY_SAFE_MODE}" == "true" ]]; then
  deploy_cmd+=(--no-execute-changeset)
fi

if [[ -n "${SAM_PARAMETER_OVERRIDES}" ]]; then
  normalized_parameter_overrides="${SAM_PARAMETER_OVERRIDES//,/ }"
  read -r -a parameter_args <<< "${normalized_parameter_overrides}"
  deploy_cmd+=(--parameter-overrides "${parameter_args[@]}")
fi

if [[ -n "${SAM_TAGS}" ]]; then
  normalized_tags="${SAM_TAGS//,/ }"
  read -r -a tag_args <<< "${normalized_tags}"
  deploy_cmd+=(--tags "${tag_args[@]}")
fi

echo "Deploying stack ${APP_STACK_NAME} in ${AWS_REGION} (safe_mode=${DEPLOY_SAFE_MODE})"
"${deploy_cmd[@]}"

echo "Stack outputs"
aws --region "${AWS_REGION}" cloudformation describe-stacks \
  --stack-name "${APP_STACK_NAME}" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table
