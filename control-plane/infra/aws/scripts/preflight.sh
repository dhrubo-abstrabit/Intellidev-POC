#!/usr/bin/env bash
# Refuses to deploy as the wrong principal, into the wrong account, or into the wrong
# region.
#
# The failure this exists to stop is quiet: AWS_PROFILE is easy to forget, and a deploy
# under a different principal in the *same* account succeeds — it just bypasses the scoped
# deploy role entirely, so nothing looks wrong until you audit who changed what.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
want_region=$(printf '%s' "$CONFIG" | sed -n 's/.*"region": "\([^"]*\)".*/\1/p')
want_env=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')

fail() { printf 'preflight: %s\n' "$1" >&2; exit 1; }

# Identity. `sts get-caller-identity` needs no permissions, so a failure here is always
# credentials rather than policy.
ident=$(aws sts get-caller-identity --output json) || fail 'no valid AWS credentials (try: aws login)'
account=$(printf '%s' "$ident" | sed -n 's/.*"Account": "\([^"]*\)".*/\1/p')
arn=$(printf '%s' "$ident" | sed -n 's/.*"Arn": "\([^"]*\)".*/\1/p')

expect_role=${INTELLIDEV_DEPLOY_ROLE:-IntellidevDeploy}
if [ "${INTELLIDEV_SKIP_ROLE_CHECK:-0}" != "1" ]; then
  case "$arn" in
    *"$expect_role"*) ;;
    *) fail "deploying as $arn, expected the $expect_role role.
  Set AWS_PROFILE=intellidev, or INTELLIDEV_SKIP_ROLE_CHECK=1 in CI where the role differs." ;;
  esac
fi

# The region the CLI will actually use, not merely what is configured.
have_region=$(aws ec2 describe-availability-zones \
  --query 'AvailabilityZones[0].RegionName' --output text 2>/dev/null) \
  || fail 'cannot reach EC2; check credentials and region'
[ "$have_region" = "$want_region" ] \
  || fail "session region is $have_region, but $want_env expects $want_region"

# A1 depends on bootstrap having happened; without it cdk deploy fails late and obscurely.
aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version >/dev/null 2>&1 \
  || fail "account $account is not bootstrapped in $want_region (run: pnpm infra:bootstrap)"

printf 'preflight ok: %s → account %s, region %s, as %s\n' \
  "$want_env" "$account" "$want_region" "${arn##*/}"
