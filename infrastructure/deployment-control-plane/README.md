# Deployment Control Plane (Containerized Installer)

This stack creates an AWS-hosted deployment installer for LetsConnect Agent.

- No local SAM/AWS CLI required for application deployments
- Deploys directly from GitHub repo + git ref
- Uses containerized CodeBuild runtime (`public.ecr.aws/sam/build-nodejs22.x` by default)
- Applies stack tags including `App=letsconnectAgent`
- Supports **safe mode** (default): create change set first, execute only after explicit approval

## What It Creates

- `HttpApi` installer endpoints (`/installer`, `/deployments`, `/deployments/{id}`)
- Lambda installer API/UI handler
- CodeBuild deployer project (containerized runner)
- DynamoDB table for deployment status records

## Security + Shared Account Notes

- Resources in this installer stack are tagged with `App=letsconnectAgent`.
- The deployed application stack is tagged using `SAM_TAGS` (default includes `App=letsconnectAgent`).
- Current CodeBuild role is intentionally broad for first-pass operability in a shared account; tighten IAM scope before production hardening.
- Do not switch account-level SES active rule set from this installer flow.

## Bootstrap (one-time)

Deploy the installer stack:

```bash
sam build --template-file infrastructure/deployment-control-plane/template.yaml
sam deploy \
  --template-file infrastructure/deployment-control-plane/template.yaml \
  --stack-name letsconnect-agent-installer \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    GitRepositoryUrl=https://github.com/<org>/<repo>.git \
    DefaultAppStackName=letsconnect-agent-prod \
    GitRef=main \
    DefaultSamParameterOverrides=Stage=prod,AppName=letsconnectAgent,StrictMultiTenantMode=true \
    DefaultSamTags=App=letsconnectAgent,Environment=prod
```

For private repos, also set:
- `GitCloneTokenSecretArn=<secret-arn-containing-github-token>`

## Use

1. Open `InstallerPortalUrl` output in a browser.
2. Set `gitRef`, target stack, and overrides.
3. Start deployment.
4. Poll status from UI (or call `GET /deployments/{deploymentId}`).
5. If safe mode is enabled and status is `awaiting_approval`, run execution step:
   - UI: click `Approve & Execute`
   - API: `POST /deployments/{deploymentId}/execute`

API example:

```bash
curl -sS -X POST "<StartDeploymentApiUrl>" \
  -H "content-type: application/json" \
  --data '{
    "gitRef":"main",
    "stackName":"letsconnect-agent-prod",
    "parameterOverrides":"Stage=prod,AppName=letsconnectAgent,StrictMultiTenantMode=true",
    "samTags":"App=letsconnectAgent,Environment=prod",
    "safeMode":true
  }'
```

Execute pending change set:

```bash
curl -sS -X POST "<StartDeploymentApiUrl>/<deployment-id>/execute"
```

## Runtime Build Steps

The deployer job performs:

1. Clone repository at requested git ref.
2. `npm --prefix app ci`
3. `npm --prefix app test`
4. `sam build`
5. `sam deploy --tags App=letsconnectAgent ...`
