#!/usr/bin/env bash
# Installs (or updates) the SafeTravel intranet mirror on a Linux host with systemd (docs/MIRROR.md).
# Run as root from a checkout of the repository:   sudo bash scripts/mirror/install.sh
# Idempotent: re-run it after pulling a newer version of these files. nginx is NOT reconfigured automatically;
# the site file is copied to /etc/nginx/conf.d/ only when it does not exist yet, and you edit it before reloading.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=/srv/safetravel

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
for t in git curl rsync python3 flock systemctl; do
  command -v "$t" >/dev/null || { echo "missing: $t (install it first, see docs/MIRROR.md)" >&2; exit 1; }
done

if ! id safetravel >/dev/null 2>&1; then
  useradd --system --home-dir "$BASE" --no-create-home --shell /usr/sbin/nologin safetravel
  echo "created system user safetravel"
fi
install -d -o safetravel -g safetravel -m 755 "$BASE" "$BASE/repo" "$BASE/releases" "$BASE/www" "$BASE/state" "$BASE/tmp"
install -d -m 755 /opt/safetravel /etc/safetravel
install -m 755 "$HERE/safetravel-sync.sh" /opt/safetravel/safetravel-sync.sh
install -m 644 "$HERE/mirror.env.example" /etc/safetravel/mirror.env.example
[ -e /etc/safetravel/mirror.env ] || install -m 640 -o root -g safetravel "$HERE/mirror.env.example" /etc/safetravel/mirror.env
# the settings may hold a proxy address with credentials: readable by root and the sync user only (also tightens an
# older install). A monitoring account that runs "safetravel-sync.sh --check" with non-default settings needs to be
# in the safetravel group.
chown root:safetravel /etc/safetravel/mirror.env
chmod 640 /etc/safetravel/mirror.env
install -m 644 "$HERE/safetravel-sync.service" "$HERE/safetravel-sync.timer" /etc/systemd/system/

# SELinux (RHEL / Rocky / Alma): let nginx read the mirror; new files inherit the label of their directory
if command -v selinuxenabled >/dev/null && selinuxenabled; then
  if command -v semanage >/dev/null; then
    semanage fcontext -a -t httpd_sys_content_t "$BASE(/.*)?" 2>/dev/null || semanage fcontext -m -t httpd_sys_content_t "$BASE(/.*)?"
    restorecon -R "$BASE"
    echo "SELinux: $BASE labelled httpd_sys_content_t"
  else
    echo "WARNING: SELinux is on but semanage is missing (dnf install policycoreutils-python-utils), then re-run" >&2
  fi
fi

if [ -d /etc/nginx/conf.d ] && [ ! -e /etc/nginx/conf.d/safetravel.conf ]; then
  install -m 644 "$HERE/nginx-safetravel.conf" /etc/nginx/conf.d/safetravel.conf.disabled
  # nginx 1.25.1 and later (Ubuntu 26.04 has 1.28) want "http2 on;" instead of "listen … http2" (deprecated there)
  nv=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9][0-9.]*\).*|\1|p')
  if [ -n "$nv" ] && python3 -c 'import sys; sys.exit(0 if tuple(int(x) for x in sys.argv[1].split(".")[:3]) >= (1, 25, 1) else 1)' "$nv"; then
    sed -i -e 's/^\( *\)listen 443 ssl http2;.*/\1listen 443 ssl;\n\1http2 on;/' \
           -e 's/^\( *\)listen \[::\]:443 ssl http2;/\1listen [::]:443 ssl;/' /etc/nginx/conf.d/safetravel.conf.disabled
    echo "nginx $nv: template uses \"http2 on;\""
  fi
  echo "nginx: template at /etc/nginx/conf.d/safetravel.conf.disabled — edit host name + certificate, rename to .conf, nginx -t && systemctl reload nginx"
fi

systemctl daemon-reload
echo "first sync (downloads about 20 MB from GitHub)…"
systemctl start safetravel-sync.service
systemctl enable --now safetravel-sync.timer
/opt/safetravel/safetravel-sync.sh --check || true
echo "host check: sudo -u safetravel /opt/safetravel/safetravel-sync.sh --selftest"
echo "done. Status: systemctl list-timers safetravel-sync.timer; journalctl -u safetravel-sync.service"
