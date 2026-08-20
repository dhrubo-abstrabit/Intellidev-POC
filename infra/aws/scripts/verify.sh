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

# --- A2: the S3 gateway endpoint must actually be in the route tables ---
endpoint=$(aws ssm get-parameter --name "$prefix/s3-endpoint-id" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail "$prefix/s3-endpoint-id is not in SSM"
routed=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc_id" \
  --query "length(RouteTables[?Routes[?GatewayId=='$endpoint']])" --output text)
# Four subnets, so four route tables. An endpoint that exists but is not routed is the
# quiet failure here: S3 still works, over the internet, billed per GB.
[ "$routed" = "4" ] || fail "S3 endpoint $endpoint is routed from $routed/4 route tables"
ok "S3 endpoint $endpoint routed from all 4 route tables"

# An interface endpoint bills ~\$7/month per AZ whether used or not.
iface=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$vpc_id" \
  --query "VpcEndpoints[?VpcEndpointType=='Interface'].ServiceName" --output text)
[ -z "$iface" ] || fail "interface endpoint(s) present, which bill hourly: $iface"
ok 'no interface endpoints'

# --- A2: the egress allowlist must be an allowlist ---
sg=$(aws ssm get-parameter --name "$prefix/run-task-security-group-id" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail "$prefix/run-task-security-group-id is not in SSM"
ingress=$(aws ec2 describe-security-groups --group-ids "$sg" \
  --query 'length(SecurityGroups[0].IpPermissions)' --output text)
[ "$ingress" = "0" ] || fail "run-task group has $ingress inbound rules; it should have none"
allow_all=$(aws ec2 describe-security-groups --group-ids "$sg" \
  --query "length(SecurityGroups[0].IpPermissionsEgress[?IpProtocol=='-1'])" --output text)
[ "$allow_all" = "0" ] || fail 'run-task group has an allow-all egress rule'
ports=$(aws ec2 describe-security-groups --group-ids "$sg" \
  --query 'SecurityGroups[0].IpPermissionsEgress[].FromPort' --output text | tr '\t' ' ')
ok "run-task group $sg: no inbound, egress ports [$ports]"

# --- A3: the recorded image reference must be a digest that exists ---
repo=$(aws ssm get-parameter --name "/intellidev/${env_name}/runner/repository-uri" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail 'runner/repository-uri is not in SSM'
digest=$(aws ssm get-parameter --name "/intellidev/${env_name}/runner/image-digest" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail 'runner/image-digest is not in SSM — run pnpm image:push'

# A tag is a mutable pointer: two dispatches of the same commit could run different code,
# which makes a failure impossible to attribute. Rollback must be a digest change.
case "$digest" in
  sha256:*) ;;
  *) fail "recorded image reference is '$digest', not a sha256 digest" ;;
esac
aws ecr describe-images --repository-name "${repo##*/}" \
  --image-ids "imageDigest=${digest}" >/dev/null 2>&1 \
  || fail "recorded digest ${digest} is not in ${repo##*/} — a stale pointer is worse than a missing one"
ok "image ${digest:0:19}... exists in ${repo##*/}"

arch=$(aws ssm get-parameter --name "/intellidev/${env_name}/runner/architecture" \
  --query 'Parameter.Value' --output text 2>/dev/null) || fail 'runner/architecture is not in SSM'
# Not verified against the image manifest here: a manifest records layers, and the
# architecture lives in the config blob behind another fetch. The check belongs at the two
# places it can actually fail — push-image.sh refuses a host/target mismatch, and
# measure-pull.sh runs the image on a real task, which is proof rather than inference.
ok "run tasks pinned to $arch"

# Region-wide, not just this VPC: a NAT gateway anywhere is a scale-to-zero regression.
nats=$(aws ec2 describe-nat-gateways \
  --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)
[ -z "$nats" ] || fail "NAT gateway(s) present: $nats"
ok 'no NAT gateways in the region'

printf '\nverify: all checks passed for %s\n' "$env_name"
