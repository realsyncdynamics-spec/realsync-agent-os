#!/usr/bin/env bash
# =============================================================================
# RealSyncDynamics OpenClaw Gateway — Linux Installer
# Usage: curl -fsSL https://install.realsync.io/gateway | bash
#
# Supported distros: Ubuntu 20+, Debian 11+, RHEL/CentOS/Rocky 8+, Alpine 3.18+
# Requires: bash, curl, systemd (for service registration)
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
success() { echo -e "${GREEN}[OK]${RESET}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }

# ── Configuration ─────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/realsync-gateway"
SERVICE_NAME="realsync-gateway"
SERVICE_USER="realsync"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_MIN_VERSION=20
NVM_DIR="${HOME}/.nvm"

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This installer must be run as root. Try: sudo bash $0"
fi

# ── Detect OS ────────────────────────────────────────────────────────────────
detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_VER="${VERSION_ID:-0}"
  else
    OS_ID="unknown"
    OS_VER="0"
  fi
  info "Detected OS: ${OS_ID} ${OS_VER}"
}

# ── Node.js ──────────────────────────────────────────────────────────────────
check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
    if [[ "$ver" -ge "$NODE_MIN_VERSION" ]]; then
      success "Node.js $(node --version) is already installed"
      return 0
    fi
    warn "Node.js version is too old (found v${ver}, need v${NODE_MIN_VERSION}+)"
  fi
  return 1
}

install_node() {
  header "Installing Node.js ${NODE_MIN_VERSION}"

  case "${OS_ID}" in
    ubuntu|debian|linuxmint)
      apt-get update -qq
      apt-get install -y -qq curl ca-certificates gnupg
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash -
      apt-get install -y nodejs
      ;;
    rhel|centos|rocky|almalinux|fedora)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash -
      yum install -y nodejs
      ;;
    alpine)
      apk add --no-cache nodejs npm
      ;;
    *)
      warn "Unknown distro — trying nvm as fallback"
      install_node_nvm
      ;;
  esac

  command -v node &>/dev/null || error "Node.js installation failed"
  success "Installed Node.js $(node --version)"
}

install_node_nvm() {
  info "Installing nvm"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck source=/dev/null
  source "${NVM_DIR}/nvm.sh"
  nvm install "${NODE_MIN_VERSION}"
  nvm use "${NODE_MIN_VERSION}"
  nvm alias default "${NODE_MIN_VERSION}"
}

# ── System user ───────────────────────────────────────────────────────────────
create_service_user() {
  if id "${SERVICE_USER}" &>/dev/null; then
    info "User '${SERVICE_USER}' already exists"
    return
  fi
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  success "Created system user: ${SERVICE_USER}"
}

# ── Install gateway ───────────────────────────────────────────────────────────
install_gateway() {
  header "Installing Gateway to ${INSTALL_DIR}"

  mkdir -p "${INSTALL_DIR}"/{src,scripts,logs}

  # If running piped from curl, we need the source files — clone from registry
  # In a real scenario this would be: curl -fsSL https://registry.realsync.io/gateway.tar.gz | tar -xz -C ${INSTALL_DIR}
  # For self-contained installs, copy current directory if it looks like the source
  if [[ -f "$(dirname "$0")/../package.json" ]]; then
    info "Copying local source files"
    cp -r "$(dirname "$0")/../"* "${INSTALL_DIR}/"
  else
    warn "No local source found — skipping file copy (manual copy may be required)"
  fi

  # Install Node.js dependencies
  if [[ -f "${INSTALL_DIR}/package.json" ]]; then
    info "Running npm install"
    cd "${INSTALL_DIR}"
    npm ci --only=production --quiet
    success "npm install complete"
  fi

  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
  chmod 750 "${INSTALL_DIR}/scripts"
  chmod 750 "${INSTALL_DIR}/logs"
  success "Gateway files installed to ${INSTALL_DIR}"
}

# ── Generate API key ──────────────────────────────────────────────────────────
generate_api_key() {
  openssl rand -hex 32
}

# ── Write .env ────────────────────────────────────────────────────────────────
write_env() {
  local api_key="$1"
  local gateway_id
  gateway_id="gateway-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')-$(openssl rand -hex 4)"

  cat > "${INSTALL_DIR}/.env" <<EOF
GATEWAY_API_KEY=${api_key}
GATEWAY_ID=${gateway_id}
PORT=8443
SCRIPTS_DIR=${INSTALL_DIR}/scripts
LOG_LEVEL=info
LOG_FILE=${INSTALL_DIR}/logs/gateway.log
MAX_JOB_TIMEOUT_MS=300000
ALLOWED_SCRIPT_EXTENSIONS=.sh,.ps1,.py
NODE_ENV=production
EOF

  chmod 600 "${INSTALL_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
  success "Configuration written to ${INSTALL_DIR}/.env"
}

# ── Systemd service ───────────────────────────────────────────────────────────
install_systemd_service() {
  header "Registering systemd service: ${SERVICE_NAME}"

  local node_bin
  node_bin=$(command -v node)

  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=RealSyncDynamics OpenClaw Gateway
Documentation=https://docs.realsync.io/gateway
After=network.target
Wants=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${node_bin} src/server.js
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}/logs
ReadOnlyPaths=${INSTALL_DIR}/scripts

# Resource limits
LimitNOFILE=65536
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl start "${SERVICE_NAME}"

  sleep 2
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    success "Service ${SERVICE_NAME} is running"
  else
    warn "Service may not have started. Check: journalctl -u ${SERVICE_NAME} -n 50"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo -e "\n${BOLD}RealSyncDynamics OpenClaw Gateway — Linux Installer${RESET}"
  echo "────────────────────────────────────────────────────"

  detect_os
  check_node || install_node
  create_service_user
  install_gateway

  local API_KEY
  API_KEY=$(generate_api_key)
  write_env "${API_KEY}"

  if command -v systemctl &>/dev/null; then
    install_systemd_service
  else
    warn "systemd not found — skipping service registration. Start manually:"
    warn "  cd ${INSTALL_DIR} && sudo -u ${SERVICE_USER} node src/server.js"
  fi

  echo ""
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${GREEN}  OpenClaw Gateway installed successfully!${RESET}"
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  Install dir : ${INSTALL_DIR}"
  echo -e "  Port        : 8443"
  echo -e "  Service     : ${SERVICE_NAME}"
  echo ""
  echo -e "${BOLD}${YELLOW}  SAVE YOUR API KEY — it will not be shown again:${RESET}"
  echo ""
  echo -e "  ${BOLD}${RED}${API_KEY}${RESET}"
  echo ""
  echo -e "  Add it to your RealSyncDynamics backend as:"
  echo -e "  X-API-Key: ${API_KEY}"
  echo ""
  echo -e "  Health check: curl http://localhost:8443/health"
  echo -e "  Logs        : journalctl -u ${SERVICE_NAME} -f"
  echo ""
}

main "$@"
