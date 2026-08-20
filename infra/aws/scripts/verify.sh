#!/usr/bin/env bash
# The proving signal for A1.
#
# Asserts the deployed reality, not the template: SSM resolves to a VPC that exists, with
# the CIDR config asked for, carrying the tags, and with no NAT gateway anywhere in the
# region. "cdk deploy said CREATE_COMPLETE" is not the same claim.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')
want_cidr=$(printf '%s' "$CONFIG" | sed -n 's/.*"cidr": "\([^"]*\)".*/\1/p')

fail() { printf 'verify: FAIL %s\n' "$1" >&2; exit 1; }
ok() { printf 'verify: ok   %s\n' "$1"; }

prefix="/intellidev/${env_name}/network"

vpc_id=$(aws ssm get-parameter --name "$prefix/vpc-id" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail "$prefix/vpc-id is not in SSM — did the stack deploy?"
ok "SSM $prefix/vpc-id → $vpc_id"

for tier in public isolated; do
  ids=$(aws ssm get-parameter --name "$prefix/${tier}-subnet-ids" \
    --query 'Parameter.Value' --output text 2>/dev/null) \
    || fail "$prefix/${tier}-subnet-ids is not in SSM"
  count=$(printf '%s' "$ids" | tr ',' '\n' | grep -c 'subnet-')
  [ "$count" -ge 2 ] || fail "expected at least 2 $tier subnets, found $count"
  ok "SSM $prefix/${tier}-subnet-ids → $count subnets"
done

# The id in SSM must point at something real — a stale parameter is worse than a missing
# one, because config resolution at boot would succeed and then fail at RunTask.
have_cidr=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" \
  --query 'Vpcs[0].CidrBlock' --output text 2>/dev/null) \
  || fail "$vpc_id does not exist, but SSM still advertises it"
[ "$have_cidr" = "$want_cidr" ] || fail "vpc CIDR is $have_cidr, config says $want_cidr"
ok "VPC $vpc_id exists with CIDR $have_cidr"

managed=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" \
  --query "Vpcs[0].Tags[?Key=='intellidev:managed-by'].Value | [0]" --output text)
[ "$managed" = "cdk" ] || fail "VPC is not tagged intellidev:managed-by=cdk (got '$managed')"
ok 'VPC carries the intellidev tags'

# Region-wide, not just this VPC: a NAT gateway anywhere is a scale-to-zero regression.
nats=$(aws ec2 describe-nat-gateways \
  --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)
[ -z "$nats" ] || fail "NAT gateway(s) present: $nats"
ok 'no NAT gateways in the region'

printf '\nverify: all checks passed for %s\n' "$env_name"
