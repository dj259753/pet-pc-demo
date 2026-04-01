#!/bin/bash
set -euo pipefail

# ============================================================
# QQ宠物 全平台一键打包脚本
# 兼容 macOS bash 3.2（不使用关联数组）
# 用法: bash scripts/full-package.sh [--version <ver>] [--platforms <p1,p2,...>] [--skip-clean] [--deep-clean]
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ---------- 参数解析 ----------
VERSION=""
PLATFORMS="darwin-arm64,darwin-x64"
SKIP_CLEAN=false
DEEP_CLEAN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2"; shift 2 ;;
    --platforms) PLATFORMS="$2"; shift 2 ;;
    --skip-clean) SKIP_CLEAN=true; shift ;;
    --deep-clean) DEEP_CLEAN=true; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ---------- 初始化 nvm ----------
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 22 || { echo "❌ nvm use 22 失败"; exit 1; }
else
  echo "⚠️  未找到 nvm，使用系统 node: $(node -v)"
fi

# ---------- 读取/设置版本号 ----------
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ -n "$VERSION" ] && [ "$VERSION" != "$CURRENT_VERSION" ]; then
  echo "📝 升级版本号: $CURRENT_VERSION → $VERSION"
  # 同步修改 package.json 和 release/version.json
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    const verFile = 'release/version.json';
    if (fs.existsSync(verFile)) {
      const ver = JSON.parse(fs.readFileSync(verFile, 'utf8'));
      ver.version = '$VERSION';
      fs.writeFileSync(verFile, JSON.stringify(ver, null, 2) + '\n');
    }
  "
  CURRENT_VERSION="$VERSION"
fi
echo "📦 版本号: $CURRENT_VERSION"

# ---------- 辅助函数 ----------
# 根据平台名获取 electron-builder 参数
get_builder_args() {
  case "$1" in
    darwin-arm64) echo "--mac --arm64" ;;
    darwin-x64)   echo "--mac --x64" ;;
    *) echo ""; return 1 ;;
  esac
}

# 根据平台名获取产物扩展名
get_ext() {
  case "$1" in
    darwin-arm64|darwin-x64) echo "dmg" ;;
    *) echo ""; return 1 ;;
  esac
}

# ---------- 解析平台列表 ----------
IFS=',' read -ra PLATFORM_LIST <<< "$PLATFORMS"
echo "🎯 目标平台: ${PLATFORM_LIST[*]}"

# ---------- 步骤 1: 清理缓存 ----------
if [ "$SKIP_CLEAN" = false ]; then
  echo ""
  echo "🧹 步骤 1/5: 清理缓存..."
  rm -rf dist
  if [ "$DEEP_CLEAN" = true ]; then
    echo "   深度清理: rm -rf node_modules"
    rm -rf node_modules
    npm install
  fi
  echo "   ✅ 缓存清理完成"
else
  echo ""
  echo "⏭️  步骤 1/5: 跳过缓存清理"
fi

# ---------- 步骤 2: 并行打包 ----------
echo ""
echo "📦 步骤 2/5: 并行打包 ${#PLATFORM_LIST[@]} 个平台..."

PIDS=""
PID_PLATFORMS=""

for platform in "${PLATFORM_LIST[@]}"; do
  builder_args=$(get_builder_args "$platform")
  log_file="/tmp/qq-pet-build-${platform}.log"

  echo "   🚀 启动 $platform → npx electron-builder $builder_args"
  npx electron-builder $builder_args --config.directories.output="dist/${platform}" --publish never > "$log_file" 2>&1 &
  pid=$!

  if [ -z "$PIDS" ]; then
    PIDS="$pid"
    PID_PLATFORMS="$platform"
  else
    PIDS="$PIDS $pid"
    PID_PLATFORMS="$PID_PLATFORMS $platform"
  fi
done

# 等待所有任务完成
read -ra PID_ARR <<< "$PIDS"
read -ra PLAT_ARR <<< "$PID_PLATFORMS"

FAILED_PLATFORMS=""
SUCCESS_INFO=""

for i in "${!PID_ARR[@]}"; do
  pid="${PID_ARR[$i]}"
  platform="${PLAT_ARR[$i]}"
  if wait "$pid"; then
    echo "   ✅ $platform 打包成功"
    SUCCESS_INFO="$SUCCESS_INFO $platform:success"
  else
    echo "   ❌ $platform 打包失败（日志: /tmp/qq-pet-build-${platform}.log）"
    if [ -z "$FAILED_PLATFORMS" ]; then
      FAILED_PLATFORMS="$platform"
    else
      FAILED_PLATFORMS="$FAILED_PLATFORMS $platform"
    fi
    SUCCESS_INFO="$SUCCESS_INFO $platform:failed"
  fi
done

# ---------- 步骤 3: 失败重试 ----------
if [ -n "$FAILED_PLATFORMS" ]; then
  echo ""
  echo "🔄 步骤 3/5: 重试失败平台..."

  read -ra FAIL_ARR <<< "$FAILED_PLATFORMS"

  RETRY_PIDS=""
  RETRY_PLATS=""

  for platform in "${FAIL_ARR[@]}"; do
    builder_args=$(get_builder_args "$platform")
    log_file="/tmp/qq-pet-build-${platform}.log"
    echo "   🔄 重试 $platform (第 1 次)..."
    npx electron-builder $builder_args --config.directories.output="dist/${platform}" --publish never > "$log_file" 2>&1 &
    pid=$!
    if [ -z "$RETRY_PIDS" ]; then
      RETRY_PIDS="$pid"
      RETRY_PLATS="$platform"
    else
      RETRY_PIDS="$RETRY_PIDS $pid"
      RETRY_PLATS="$RETRY_PLATS $platform"
    fi
  done

  read -ra RPID_ARR <<< "$RETRY_PIDS"
  read -ra RPLAT_ARR <<< "$RETRY_PLATS"

  FAILED_PLATFORMS=""
  for i in "${!RPID_ARR[@]}"; do
    pid="${RPID_ARR[$i]}"
    platform="${RPLAT_ARR[$i]}"
    if wait "$pid"; then
      echo "   ✅ $platform 重试成功"
      SUCCESS_INFO="$SUCCESS_INFO $platform:retry1"
    else
      echo "   ❌ $platform 重试仍失败"
      if [ -z "$FAILED_PLATFORMS" ]; then
        FAILED_PLATFORMS="$platform"
      else
        FAILED_PLATFORMS="$FAILED_PLATFORMS $platform"
      fi
    fi
  done

  # 第二次重试
  if [ -n "$FAILED_PLATFORMS" ]; then
    read -ra FAIL2_ARR <<< "$FAILED_PLATFORMS"

    RETRY2_PIDS=""
    RETRY2_PLATS=""

    for platform in "${FAIL2_ARR[@]}"; do
      builder_args=$(get_builder_args "$platform")
      log_file="/tmp/qq-pet-build-${platform}.log"
      echo "   🔄 重试 $platform (第 2 次)..."
      npx electron-builder $builder_args --config.directories.output="dist/${platform}" --publish never > "$log_file" 2>&1 &
      pid=$!
      if [ -z "$RETRY2_PIDS" ]; then
        RETRY2_PIDS="$pid"
        RETRY2_PLATS="$platform"
      else
        RETRY2_PIDS="$RETRY2_PIDS $pid"
        RETRY2_PLATS="$RETRY2_PLATS $platform"
      fi
    done

    read -ra R2PID_ARR <<< "$RETRY2_PIDS"
    read -ra R2PLAT_ARR <<< "$RETRY2_PLATS"

    FAILED_PLATFORMS=""
    for i in "${!R2PID_ARR[@]}"; do
      pid="${R2PID_ARR[$i]}"
      platform="${R2PLAT_ARR[$i]}"
      if wait "$pid"; then
        echo "   ✅ $platform 第二次重试成功"
        SUCCESS_INFO="$SUCCESS_INFO $platform:retry2"
      else
        echo "   ❌ $platform 最终失败（已重试 2 次）"
        if [ -z "$FAILED_PLATFORMS" ]; then
          FAILED_PLATFORMS="$platform"
        else
          FAILED_PLATFORMS="$FAILED_PLATFORMS $platform"
        fi
      fi
    done
  fi
else
  echo ""
  echo "⏭️  步骤 3/5: 无需重试"
fi

# ---------- 步骤 4: 整理产物 ----------
echo ""
echo "📁 步骤 4/5: 整理产物到 dist/$CURRENT_VERSION/..."

for platform in "${PLATFORM_LIST[@]}"; do
  ext=$(get_ext "$platform")
  target_dir="dist/$CURRENT_VERSION/$platform"
  mkdir -p "$target_dir"

  if ls "dist/$platform/"*."$ext" 1>/dev/null 2>&1; then
    mv "dist/$platform/"*."$ext" "$target_dir/"
    # 同时移动 zip 产物（如果有）
    mv "dist/$platform/"*.zip "$target_dir/" 2>/dev/null || true
    rm -rf "dist/$platform"
    echo "   ✅ $platform → $target_dir/"
  else
    echo "   ⚠️  $platform 无产物可整理"
  fi
done

# ---------- 步骤 5: 生成 Changelog ----------
echo ""
echo "📝 步骤 5/5: 生成 Changelog..."

CHANGELOG_FILE="dist/$CURRENT_VERSION/${CURRENT_VERSION}-changelog.md"

PREV_VERSION_COMMIT=$(git log --oneline --all --grep="bump version" --format="%H %s" | while read hash msg; do
  if echo "$msg" | grep -q "$CURRENT_VERSION"; then
    continue
  fi
  echo "$hash"
  break
done)

{
  echo "# QQ宠物 v${CURRENT_VERSION} 更新日志"
  echo ""
  echo "**发布日期**: $(date '+%Y-%m-%d %H:%M')"
  echo ""
  echo "## 更新内容"
  echo ""

  if [ -n "$PREV_VERSION_COMMIT" ]; then
    git log "${PREV_VERSION_COMMIT}..HEAD" --format="%s" --no-merges | grep -v "^chore: bump version" | while read line; do
      echo "- ${line}"
    done
  else
    git log -20 --format="%s" --no-merges | grep -v "^chore: bump version" | while read line; do
      echo "- ${line}"
    done
  fi

  echo ""
} > "$CHANGELOG_FILE"

echo "   ✅ Changelog 已生成: $CHANGELOG_FILE"

# ---------- 最终报告 ----------
echo ""
echo "============================================================"
echo "  QQ宠物 v$CURRENT_VERSION 打包报告"
echo "============================================================"
echo ""

HAS_FAILURE=false
for platform in "${PLATFORM_LIST[@]}"; do
  ext=$(get_ext "$platform")
  target_dir="dist/$CURRENT_VERSION/$platform"

  is_failed=false
  if [ -n "$FAILED_PLATFORMS" ]; then
    for fp in $FAILED_PLATFORMS; do
      if [ "$fp" = "$platform" ]; then
        is_failed=true
        break
      fi
    done
  fi

  if [ "$is_failed" = true ]; then
    printf "  ❌ %-16s  失败（日志: /tmp/qq-pet-build-%s.log）\n" "$platform" "$platform"
    HAS_FAILURE=true
  else
    file=$(ls "$target_dir/"*."$ext" 2>/dev/null | head -1)
    if [ -n "$file" ]; then
      printf "  ✅ %-16s  →  %s\n" "$platform" "$file"
    else
      printf "  ⚠️  %-16s  产物未找到\n" "$platform"
      HAS_FAILURE=true
    fi
  fi
done

echo ""
echo "产物目录: dist/$CURRENT_VERSION/"
ls -lhR "dist/$CURRENT_VERSION/" 2>/dev/null || true
echo ""

if [ "$HAS_FAILURE" = true ]; then
  echo "⚠️  部分平台打包失败，请检查日志"
  exit 1
else
  echo "🎉 全平台打包完成！"
  exit 0
fi
