#!/usr/bin/env bash
# omp-headroom installer: venv + headroom-ai + GPU-matched torch + OMP extension.
#
# Recommended one-line install:
#   curl -fsSL https://raw.githubusercontent.com/DarkPhilosophy/omp-headroom/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/DarkPhilosophy/omp-headroom/main/install.sh | bash
#
# Local checkout / developer usage:
#   ./install.sh [--gpu auto|nvidia|amd|cpu] [--agent-dir DIR] [--port N] [--systemd] [--dry-run]
#
# What it does:
#   1. Detects the GPU vendor (NVIDIA -> CUDA wheels, AMD -> ROCm wheels, none -> CPU).
#   2. Creates/updates the Headroom venv under the OMP agent dir.
#   3. Installs headroom-ai[all] plus the matching torch build.
#   4. Installs the omp_stats proxy plugin (per-session savings in /stats).
#   5. Copies the OMP extension into <agent-dir>/extensions/.
#   6. Optionally installs a systemd --user unit for a persistent shared proxy.
set -euo pipefail

GPU="auto"
AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
PORT=8787
SYSTEMD=0
DRY_RUN=0
ROCM_INDEX="${OMP_HEADROOM_ROCM_INDEX:-https://download.pytorch.org/whl/rocm6.4}"
ROCM_TORCH="${OMP_HEADROOM_ROCM_TORCH:-torch==2.9.1+rocm6.4}"
CPU_INDEX="https://download.pytorch.org/whl/cpu"
REMOTE_ARCHIVE_URL="${OMP_HEADROOM_ARCHIVE_URL:-https://github.com/DarkPhilosophy/omp-headroom/archive/refs/heads/main.tar.gz}"
TEMP_REPO_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gpu)
            GPU="${2:?--gpu requires auto|nvidia|amd|cpu}"
            shift 2
            ;;
        --agent-dir)
            AGENT_DIR="${2:?--agent-dir requires a directory}"
            shift 2
            ;;
        --port)
            PORT="${2:?--port requires a port number}"
            shift 2
            ;;
        --systemd)
            SYSTEMD=1
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "unknown flag: $1" >&2
            exit 2
            ;;
    esac
done

case "$GPU" in
    auto|nvidia|amd|cpu) ;;
    *) echo "invalid --gpu value: $GPU" >&2; exit 2 ;;
esac

SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
if [[ -z "${BASH_SOURCE[0]:-}" || "$SCRIPT_SOURCE" == "bash" || "$SCRIPT_SOURCE" == "/bin/bash" || "$SCRIPT_SOURCE" == "/usr/bin/bash" ]]; then
    REPO_DIR=""
else
    REPO_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
fi

VENV_DIR="$AGENT_DIR/headroom-venv"
PYBIN="$VENV_DIR/bin/python"
HEADROOM_BIN="$VENV_DIR/bin/headroom"

log() { printf '\033[36m[omp-headroom]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[omp-headroom]\033[0m %s\n' "$*" >&2; }
run() { if [[ $DRY_RUN -eq 1 ]]; then echo "DRY: $*"; else "$@"; fi; }

cleanup() {
    if [[ -n "$TEMP_REPO_DIR" ]]; then
        rm -rf "$TEMP_REPO_DIR"
    fi
}
trap cleanup EXIT

# --- 1. GPU detection -------------------------------------------------------
detect_gpu() {
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
        echo nvidia
        return
    fi
    if command -v rocm-smi >/dev/null 2>&1 || [[ -d /opt/rocm ]]; then
        echo amd
        return
    fi
    if compgen -G '/sys/class/drm/card*/device/vendor' >/dev/null 2>&1 \
        && grep -q 0x1002 /sys/class/drm/card*/device/vendor 2>/dev/null; then
        echo amd
        return
    fi
    echo cpu
}
[[ "$GPU" == "auto" ]] && GPU="$(detect_gpu)"
log "GPU backend: $GPU"

# --- 2. source bundle -------------------------------------------------------
download_repo_bundle() {
    local archive="$1"
    local target="$2"

    mkdir -p "$target"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$REMOTE_ARCHIVE_URL" -o "$archive"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$archive" "$REMOTE_ARCHIVE_URL"
    else
        warn "curl or wget is required for pipe-mode install"
        exit 1
    fi
    tar -xzf "$archive" -C "$target" --strip-components=1
}

if [[ -z "$REPO_DIR" || ! -f "$REPO_DIR/extension/headroom.ts" || ! -d "$REPO_DIR/plugins/headroom-omp-stats" ]]; then
    TEMP_REPO_DIR="$(mktemp -d)"
    log "Downloading omp-headroom bundle"
    download_repo_bundle "$TEMP_REPO_DIR/omp-headroom.tar.gz" "$TEMP_REPO_DIR/repo"
    REPO_DIR="$TEMP_REPO_DIR/repo"
fi

# --- 3. uv + venv -----------------------------------------------------------
UV="${OMP_HEADROOM_UV:-uv}"
install_uv() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "DRY: install uv from https://astral.sh/uv/install.sh"
        return
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- https://astral.sh/uv/install.sh | sh
    else
        warn "uv not found and neither curl nor wget is available to install it"
        exit 1
    fi
}

if ! command -v "$UV" >/dev/null 2>&1; then
    if [[ -x "$HOME/.local/bin/uv" ]]; then
        UV="$HOME/.local/bin/uv"
    else
        install_uv
        if [[ -x "$HOME/.local/bin/uv" ]]; then
            UV="$HOME/.local/bin/uv"
        elif ! command -v "$UV" >/dev/null 2>&1; then
            warn "uv install did not expose a uv binary; add ~/.local/bin to PATH and retry"
            exit 1
        fi
    fi
fi
[[ -x "$PYBIN" ]] || run "$UV" venv "$VENV_DIR"

# --- 4. headroom-ai + torch -------------------------------------------------
run "$UV" pip install -p "$PYBIN" --upgrade --no-progress "headroom-ai[all]"
case "$GPU" in
    amd)
        log "Re-pinning ROCm torch ($ROCM_TORCH)"
        run "$UV" pip install -p "$PYBIN" --no-progress "$ROCM_TORCH" --index-url "$ROCM_INDEX"
        ;;
    cpu)
        log "Installing CPU torch wheels"
        run "$UV" pip install -p "$PYBIN" --no-progress torch --index-url "$CPU_INDEX"
        ;;
    nvidia)
        : # default PyPI wheels are CUDA builds
        ;;
esac

# --- 5. stats plugin --------------------------------------------------------
run "$UV" pip install -p "$PYBIN" --no-progress --reinstall "$REPO_DIR/plugins/headroom-omp-stats"
# The extension auto-reinstalls this plugin after each headroom-ai autoupdate;
# it looks for the sources next to the venv.
run mkdir -p "$AGENT_DIR/headroom-omp-stats"
run cp -r "$REPO_DIR/plugins/headroom-omp-stats/." "$AGENT_DIR/headroom-omp-stats/"

# --- 6. OMP extension -------------------------------------------------------
run mkdir -p "$AGENT_DIR/extensions"
run cp "$REPO_DIR/extension/headroom.ts" "$AGENT_DIR/extensions/headroom.ts"
log "Extension installed to $AGENT_DIR/extensions/headroom.ts"

# --- 7. systemd (optional) --------------------------------------------------
if [[ $SYSTEMD -eq 1 ]]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    run mkdir -p "$UNIT_DIR"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "DRY: render systemd/headroom-proxy.service.in -> $UNIT_DIR/headroom-proxy.service"
    else
        sed -e "s|@HEADROOM_BIN@|$HEADROOM_BIN|g" -e "s|@PORT@|$PORT|g" \
            "$REPO_DIR/systemd/headroom-proxy.service.in" > "$UNIT_DIR/headroom-proxy.service"
        systemctl --user daemon-reload
        systemctl --user enable --now headroom-proxy.service
    fi
    log "systemd unit installed (headroom-proxy.service)"
fi

# --- 8. verify --------------------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
    "$HEADROOM_BIN" --version || { warn "headroom binary failed"; exit 1; }
    if [[ $SYSTEMD -eq 1 ]]; then
        for _ in $(seq 1 20); do
            if curl -fsS "http://127.0.0.1:$PORT/livez" >/dev/null 2>&1; then
                log "Proxy healthy: http://127.0.0.1:$PORT/livez"
                break
            fi
            sleep 1
        done
    fi
fi
log "Done. Start OMP and the Headroom widget will appear."
log "Stock OMP renders the widget at the bottom; the right-side panel needs the right-panel OMP fork (see README)."
