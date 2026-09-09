#!/usr/bin/env bash
# Measures how long Fargate takes to pull the golden image.
#
# A3 asks for this number rather than an estimate, because it is subtracted from the
# 60-120s dispatch budget before any useful work happens. ECS reports it directly:
# `pullStartedAt` and `pullStoppedAt` on the stopped task are the real figures, not a
# stopwatch around the API call.
#
# Registers a throwaway task definition via the CLI rather than in CDK, because CDK cannot
# reference a digest it does not know at synth time. The permanent run task definition is
# C1's work; this is a diagnostic. The deregistered revision stays listed as INACTIVE and
# costs nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')
region=$(printf '%s' "$CONFIG" | sed -n 's/.*"region": "\([^"]*\)".*/\1/p')

fail() { printf 'pull: FAIL %s\n' "$1" >&2; exit 1; }
param() {
  aws ssm get-parameter --name "$1" --query 'Parameter.Value' --output text 2>/dev/null \
    || fail "$1 is not in SSM"
}

repo=$(param "/intellidev/${env_name}/runner/repository-uri")
digest=$(param "/intellidev/${env_name}/runner/image-digest")
arch=$(param "/intellidev/${env_name}/runner/architecture")
cluster=$(param "/intellidev/${env_name}/runtime/cluster-name")
subnets=$(param "/intellidev/${env_name}/network/public-subnet-ids")
sg=$(param "/intellidev/${env_name}/network/run-task-security-group-id")
# From SSM, not by listing IAM roles: discovery-by-listing needs iam:ListRoles, which the
# deploy role has no business holding, and it would break the moment a role was renamed.
exec_role=$(param "/intellidev/${env_name}/runtime/task-execution-role-arn")

family="intellidev-${env_name}-pull-probe"
printf 'pull: registering %s against %s\n' "$family" "${digest:0:19}..."
taskdef=$(aws ecs register-task-definition \
  --family "$family" \
  --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 2048 --memory 4096 \
  --runtime-platform "cpuArchitecture=${arch},operatingSystemFamily=LINUX" \
  --execution-role-arn "$exec_role" \
  --container-definitions "[{
      \"name\":\"probe\",
      \"image\":\"${repo}@${digest}\",
      \"essential\":true,
      \"entryPoint\":[\"/bin/sh\",\"-c\"],
      \"command\":[\"echo pull-probe-ok\"]
    }]" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

arn=$(aws ecs run-task --cluster "$cluster" --task-definition "$taskdef" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
[ -n "$arn" ] && [ "$arn" != "None" ] || fail 'run-task returned no ARN'

printf 'pull: waiting for %s to stop\n' "${arn##*/}"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn" || fail 'timed out'

read -r created pull_start pull_stop started stopped exit_code reason < <(
  aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query \
  'tasks[0].[createdAt,pullStartedAt,pullStoppedAt,startedAt,stoppedAt,containers[0].exitCode,stoppedReason]' \
  --output text)

aws ecs deregister-task-definition --task-definition "$taskdef" >/dev/null

# ECS reports ISO-8601 with an offset, not epoch seconds.
secs() {
  python3 -c "import sys;from datetime import datetime as d;a,b=[d.fromisoformat(x) for x in sys.argv[1:3]];print(f'{(b-a).total_seconds():.1f}')" "$1" "$2"
}

printf '\n--- image pull, measured by ECS ---\n'
printf '  image size      %s MB compressed\n' "$(aws ecr describe-images \
  --repository-name "${repo##*/}" --image-ids "imageDigest=${digest}" \
  --query 'imageDetails[0].imageSizeInBytes' --output text | awk '{print int($1/1000000)}')"
printf '  provision       %ss   (ENI, placement — not ours)\n' "$(secs "$created" "$pull_start")"
printf '  image pull      %ss   <-- the A3 number\n' "$(secs "$pull_start" "$pull_stop")"
printf '  pull to running  %ss\n' "$(secs "$pull_stop" "$started")"
printf '  dispatch total  %ss   against a 60-120s budget\n' "$(secs "$created" "$started")"
printf -- '-----------------------------------\n'

[ "$exit_code" = "0" ] || fail "probe exited ${exit_code} (${reason})"
printf 'pull: ok — the image runs on %s\n' "$arch"
