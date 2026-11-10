#!/usr/bin/env bash
# SafeTravel TW kiosk: lock Google Chrome / Chromium to this site with a managed policy (same JSON for both).
#
#   sudo ./install-policy.sh                       # allow https://ancientsky.github.io/safetravel only
#   sudo ./install-policy.sh safetravel.cdc.local  # also allow an intranet mirror host (repeatable)
#   sudo ./install-policy.sh --remove              # take the policy away again
#
# What it does: writes one JSON file into the managed-policy directory of every Chromium flavour found on this
# machine (Debian/Raspberry Pi OS chromium, Ubuntu chromium-browser / snap, Google Chrome). The browser reads it at
# start-up; restart the kiosk session afterwards. Check with chrome://policy (left reachable on purpose).
#
# The page's own kiosk mode (?osk=1 / ?reset=N) already refuses external links, downloads and printing; this policy is
# the second layer: it holds even if a page script fails or someone finds another way to type an address.
set -euo pipefail

NAME="safetravel-kiosk.json"
DIRS=(
  /etc/chromium/policies/managed            # Debian, Raspberry Pi OS (chromium)
  /etc/chromium-browser/policies/managed    # Ubuntu (chromium-browser deb and the snap)
  /etc/opt/chrome/policies/managed          # Google Chrome
)

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo $0 …)" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  for d in "${DIRS[@]}"; do rm -fv "$d/$NAME"; done
  exit 0
fi

# allowed sites: the public site, plus any host given on the command line (letters, digits, dots, dashes, :port)
ALLOW=('"ancientsky.github.io/safetravel"' '"chrome://policy"')
for host in "$@"; do
  [[ "$host" =~ ^[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]] || { echo "not a host name: $host" >&2; exit 1; }
  ALLOW+=("\"$host\"")
done
ALLOW_JSON=$(IFS=,; echo "${ALLOW[*]}")

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<JSON
{
  "URLBlocklist": ["*"],
  "URLAllowlist": [${ALLOW_JSON}],

  "DownloadRestrictions": 3,
  "PrintingEnabled": false,
  "DeveloperToolsAvailability": 2,
  "DefaultPopupsSetting": 2,
  "DefaultGeolocationSetting": 2,
  "DefaultNotificationsSetting": 2,

  "TranslateEnabled": false,
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "BookmarkBarEnabled": false,
  "EditBookmarksEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false
}
JSON

# refuse to install something the browser would silently ignore
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$TMP" || { echo "generated policy is not valid JSON" >&2; exit 1; }
fi

for d in "${DIRS[@]}"; do
  install -d -m 755 "$d"
  install -m 644 -o root -g root "$TMP" "$d/$NAME"
  echo "installed $d/$NAME"
done
echo "allowed: ${ALLOW[*]}"
echo "restart the browser (or reboot the kiosk), then open chrome://policy to confirm."
