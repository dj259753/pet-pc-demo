#!/bin/bash
set -euo pipefail

# ============================================================
# QQ宠物 一键构建 + 签名公证脚本
# 串联 full-package.sh → sign-and-notarize.sh 的完整流程
#
# 用法: bash scripts/build-and-sign.sh [--version <ver>] [--platforms <p1,p2,...>] [--skip-clean] [--deep-clean]
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ---------- 参数透传（提取本脚本参数，其余透传给 full-package.sh） ----------
VERSION=""
SKIP_CLEAN=false
DEEP_CLEAN=false
PLATFORMS=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     VERSION="$2"; shift 2 ;;
    --skip-clean)  SKIP_CLEAN=true; shift ;;
    --deep-clean)  DEEP_CLEAN=true; shift ;;
    --platforms)   PLATFORMS="$2"; EXTRA_ARGS+=("--platforms" "$2"); shift 2 ;;
    *)             echo "❌ 未知参数: $1"; exit 1 ;;
  esac
done

# ---------- 构建 full-package.sh 参数 ----------
PACKAGE_ARGS=()
if [ -n "$VERSION" ]; then
  PACKAGE_ARGS+=("--version" "$VERSION")
fi
if [ -n "$PLATFORMS" ]; then
  PACKAGE_ARGS+=("--platforms" "$PLATFORMS")
fi
if [ "$SKIP_CLEAN" = true ]; then
  PACKAGE_ARGS+=("--skip-clean")
fi
if [ "$DEEP_CLEAN" = true ]; then
  PACKAGE_ARGS+=("--deep-clean")
fi

# ========== 阶段 1: 打包 ==========
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  📦 阶段 1/2: 全平台打包                               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if ! bash "$SCRIPT_DIR/full-package.sh" "${PACKAGE_ARGS[@]}"; then
  echo ""
  echo "❌ 打包失败，终止签名流程。请检查打包日志。"
  exit 1
fi

# 获取实际版本号（如果脚本自动升级了）
ACTUAL_VERSION=$(node -p "require('./package.json').version")

# ========== 阶段 2: 签名公证 ==========
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✍️  阶段 2/2: 签名公证                                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if ! bash "$SCRIPT_DIR/sign-and-notarize.sh" --version "$ACTUAL_VERSION"; then
  echo ""
  echo "❌ 签名公证失败。请检查签名日志。"
  exit 1
fi

# ========== 最终报告 ==========
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  🎉 QQ宠物 v${ACTUAL_VERSION} 构建 + 签名公证全部完成！    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  📁 未签名产物:  dist/${ACTUAL_VERSION}/"
echo "  📁 签名产物:    dist/${ACTUAL_VERSION}-signed/"
echo ""

ls -lhR "dist/${ACTUAL_VERSION}-signed/" 2>/dev/null || true
