#!/usr/bin/env bash
# SafeTravel intranet mirror — install or replace the TLS certificate nginx serves (docs/MIRROR_UBUNTU2604.md §5).
#
#   sudo safetravel-cert.sh <directory with fullchain.pem and privkey.pem> [host name]
#       checks the pair, installs it as /etc/nginx/tls/safetravel.{crt,key}, runs "nginx -t" and reloads nginx.
#       Any failed check leaves the installed certificate untouched; if "nginx -t" rejects the new pair, the
#       previous one is put back.
#   sudo safetravel-cert.sh --check [host name]
#       reports on the installed certificate: names, expiry, and whether nginx is serving it.
#
# The host name is taken from server_name in the nginx site file when it is not given.
# Nothing here prints or copies the private key anywhere except /etc/nginx/tls (root only).
set -euo pipefail

TLS_DIR=${TLS_DIR:-/etc/nginx/tls}
SITE=${NGINX_SITE:-/etc/nginx/conf.d/safetravel.conf}
WARN_DAYS=${WARN_DAYS:-30}
tmp=
CRT=$TLS_DIR/safetravel.crt
KEY=$TLS_DIR/safetravel.key

say()  { printf '%s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

site_host() {  # first server_name of the site file (enabled or still .disabled)
  local f
  for f in "$SITE" "$SITE.disabled"; do
    [ -r "$f" ] || continue
    sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;[:space:]]*\).*/\1/p' "$f" | head -n 1
    return
  done
}

fingerprint() { openssl x509 -noout -fingerprint -sha256 "$@" 2>/dev/null | sed 's/.*=//'; }

served_fingerprint() {  # what nginx on this machine hands out for $1
  # s_client exits non-zero for a certificate it cannot verify; only the certificate it printed matters here
  { openssl s_client -connect 127.0.0.1:443 -servername "$1" </dev/null 2>/dev/null || true; } | fingerprint
}

check_names_and_dates() {  # $1 certificate file, $2 host
  local crt=$1 host=$2
  say "      $(openssl x509 -in "$crt" -noout -subject)"
  say "      $(openssl x509 -in "$crt" -noout -issuer)"
  say "      $(openssl x509 -in "$crt" -noout -enddate)"
  openssl x509 -in "$crt" -noout -checkend 0 >/dev/null || die "the certificate has expired"
  if openssl x509 -in "$crt" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null; then
    ok "valid for more than $WARN_DAYS days"
  else
    warn "expires within $WARN_DAYS days — ask for the renewed files now"
  fi
  if [ -z "$host" ] || [ "$host" = safetravel.example.internal ]; then
    warn "no host name to check (give it as the last argument, or set server_name in $SITE)"
  elif openssl x509 -in "$crt" -noout -checkhost "$host" | grep -q 'does match'; then
    ok "covers $host"
  else
    die "the certificate does not cover $host: $(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | tail -n 1 | sed 's/^ *//')"
  fi
}

do_check() {
  local host=${1:-$(site_host)}
  [ -r "$CRT" ] || die "no certificate at $CRT (run as root?)"
  say "installed certificate: $CRT"
  check_names_and_dates "$CRT" "$host"
  [ -n "$host" ] || return 0
  local served
  served=$(served_fingerprint "$host")
  if [ -z "$served" ]; then
    warn "nothing answers on 127.0.0.1:443 — is the nginx site enabled?"
  elif [ "$served" = "$(fingerprint -in "$CRT")" ]; then
    ok "nginx is serving this certificate"
  else
    warn "nginx is serving a different certificate — sudo nginx -t && sudo systemctl reload nginx"
  fi
}

do_install() {
  local src=$1 host=${2:-$(site_host)}
  local full=$src/fullchain.pem key=$src/privkey.pem
  [ "$(id -u)" = 0 ] || die "run as root (sudo)"
  [ -r "$full" ] || die "missing $full"
  [ -r "$key" ]  || die "missing $key"

  tmp=$(mktemp -d)     # not local: the EXIT trap runs after this function has returned
  trap 'rm -rf "$tmp"' EXIT

  # 1. the file starts with the server certificate, followed by the intermediate(s)
  local n
  n=$(grep -c 'BEGIN CERTIFICATE' "$full" || true)
  [ "$n" -ge 1 ] || die "$full holds no PEM certificate"
  awk -v d="$tmp" '/BEGIN CERTIFICATE/ { i++ } i { print > (d "/c" i ".pem") }' "$full"
  if [ "$n" -ge 2 ]; then
    cat "$tmp"/c[2-9]*.pem > "$tmp/rest.pem"
    openssl verify -partial_chain -CAfile "$tmp/rest.pem" "$tmp/c1.pem" >/dev/null 2>&1 \
      || die "the first certificate in $full is not signed by the ones after it (wrong order or wrong chain)"
    ok "chain: server certificate first, then $((n - 1)) intermediate certificate(s)"
  else
    warn "$full holds a single certificate; browsers usually need the intermediate certificate as well"
  fi

  # 2. the key is usable without a passphrase, and belongs to the certificate
  openssl pkey -in "$key" -passin pass: -noout 2>/dev/null \
    || die "the private key is passphrase-protected or unreadable; remove the passphrase first (openssl pkey -in privkey.pem -out privkey.pem)"
  [ "$(openssl x509 -in "$tmp/c1.pem" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$key" -passin pass: -pubout | openssl sha256)" ] \
    || die "the private key does not belong to this certificate"
  ok "private key matches the certificate"

  # 3. names and dates
  check_names_and_dates "$tmp/c1.pem" "$host"

  # 4. install, keeping the previous pair until nginx accepts the new one
  install -d -m 750 -o root -g root "$TLS_DIR"
  install -d -m 700 -o root -g root "$TLS_DIR/prev"
  local had=0
  if [ -e "$CRT" ] && [ -e "$KEY" ]; then
    cp -p "$CRT" "$TLS_DIR/prev/safetravel.crt"
    cp -p "$KEY" "$TLS_DIR/prev/safetravel.key"
    had=1
  fi
  install -m 644 -o root -g root "$full" "$CRT"
  install -m 600 -o root -g root "$key" "$KEY"
  if ! nginx -t >"$tmp/nginx-t.log" 2>&1; then
    cat "$tmp/nginx-t.log" >&2
    if [ "$had" = 1 ]; then
      cp -p "$TLS_DIR/prev/safetravel.crt" "$CRT"
      cp -p "$TLS_DIR/prev/safetravel.key" "$KEY"
      die "nginx -t rejected the configuration; the previous certificate is back in place"
    fi
    die "nginx -t rejected the configuration (see above); the new files are in $TLS_DIR"
  fi
  ok "installed in $TLS_DIR, nginx -t passed"

  # 5. reload and look at what nginx now serves
  if systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl reload nginx
  elif [ -s /run/nginx.pid ]; then
    nginx -s reload
  else
    warn "nginx is not running: sudo systemctl enable --now nginx"
    return 0
  fi
  [ -e "$SITE" ] || { warn "the site file $SITE is not enabled yet (section 6 of the guide)"; return 0; }
  local served="" i
  for i in 1 2 3 4 5; do
    served=$(served_fingerprint "${host:-localhost}")
    [ "$served" = "$(fingerprint -in "$tmp/c1.pem")" ] && break
    sleep 1
  done
  if [ "$served" = "$(fingerprint -in "$tmp/c1.pem")" ]; then
    ok "nginx reloaded and is serving the new certificate"
  else
    warn "nginx reloaded, but 127.0.0.1:443 does not hand out the new certificate — check ssl_certificate in $SITE"
  fi
  say "Now delete the uploaded copy of the key:  shred -u $key"
}

case "${1:-}" in
  ""|-h|--help) usage ;;
  --check)      do_check "${2:-}" ;;
  -*)           usage >&2; exit 2 ;;
  *)            do_install "$1" "${2:-}" ;;
esac
