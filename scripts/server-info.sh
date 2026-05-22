#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

cat /etc/os-release 2>&1 || true
echo
uname -a 2>&1 || true
echo
curl -s --max-time 8 https://speed.cloudflare.com/meta 2>&1 || true
