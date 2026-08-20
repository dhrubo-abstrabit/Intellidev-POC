#!/usr/bin/env bash
# A2's proving signal: launch a real Fargate task and make it prove the network works.
#
# A template assertion cannot show that DNS resolves, TLS completes, or that S3 is
# reachable without a NAT gateway. This runs the container and reports its exit code and
# its logs, so "egress works" is an observation rather than an inference.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')

fail() { printf 'smoke: FAIL %s\n' "$1" >&2; exit 1; }
param() {
  aws ssm get-parameter --name "$1" --query 'Parameter.Value' --output text 2>/dev/null \
    || fail "$1 is not in SSM — deploy first (pnpm infra:deploy)"
}

cluster=$(param "/intellidev/${env_name}/runtime/cluster-name")
taskdef=$(param "/intellidev/${env_name}/smoke/task-definition-arn")
subnets=$(param "/intellidev/${env_name}/network/public-subnet-ids")
sg=$(param "/intellidev/${env_name}/network/run-task-security-group-id")
# Shared with real runs, so a probe failure and a run failure are read the same way.
log_group=$(param "/intellidev/${env_name}/runtime/log-group-name")

# assignPublicIp=ENABLED is what replaces the NAT gateway. Without it the task has no route
# to the internet at all, which is the failure this whole phase exists to avoid.
printf 'smoke: launching in %s\n' "$cluster"
arn=$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$taskdef" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
[ "$arn" != "None" ] && [ -n "$arn" ] || fail 'run-task returned no task ARN'
printf 'smoke: task %s\n' "${arn##*/}"

printf 'smoke: waiting for it to stop'
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn" &
wait $! || fail 'timed out waiting for the task to stop'
printf '\n'

read -r exit_code stopped_reason < <(aws ecs describe-tasks \
  --cluster "$cluster" --tasks "$arn" \
  --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text)

printf '\n--- container log ---\n'
stream="probe/probe/${arn##*/}"
aws logs get-log-events \
  --log-group-name "$log_group" \
  --log-stream-name "$stream" \
  --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || \
  printf '(no log stream yet: %s)\n' "$stream"
printf -- '--- end log ---\n\n'

[ "$exit_code" = "0" ] || fail "container exited $exit_code (${stopped_reason})"

# A zero exit code alone is too weak: a shell that never ran the checks also exits zero.
aws logs get-log-events \
  --log-group-name "$log_group" \
  --log-stream-name "$stream" --query 'events[].message' --output text 2>/dev/null \
  | grep -q EGRESS_SMOKE_OK \
  || fail 'container exited 0 but never printed EGRESS_SMOKE_OK'

printf 'smoke: ok — DNS, HTTPS, git clone and S3 round-trip all succeeded with no NAT gateway\n'
