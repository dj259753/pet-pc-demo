#!/bin/bash
set -euo pipefail

# ============================================================
# QQ宠物 macOS 签名 + 公证 + DMG 打包脚本
# 支持并行处理 arm64 / x64 两个架构
#
# 用法:
#   bash scripts/sign-and-notarize.sh --version <ver>
#   bash scripts/sign-and-notarize.sh --version <ver> --arch arm64
#   bash scripts/sign-and-notarize.sh --version <ver> --arch x64
#   bash scripts/sign-and-notarize.sh --version <ver> --arch arm64,x64
#
# 前置条件:
#   1. dist/{version}/darwin-arm64/ 和/或 dist/{version}/darwin-x64/ 下存在
#      electron-builder 的原始产物 .dmg
#   2. xcrun notarytool 已配置 keychain-profile "mydev"
#   3. Developer ID Application 证书已安装
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ---------- 常量 ----------
CERT_NAME="Developer ID Application: Yu Junqing (ZQN877VJHL)"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"
NOTARY_PROFILE="mydev"
APP_NAME="QQ宠物"

# ---------- 参数解析 ----------
VERSION=""
ARCHS="arm64,x64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2"; shift 2 ;;
    --arch)     ARCHS="$2"; shift 2 ;;
    *)          echo "❌ 未知参数: $1"; exit 1 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "❌ 必须指定版本号: --version <ver>"
  exit 1
fi

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "❌ 未找到 entitlements.plist: $ENTITLEMENTS"
  exit 1
fi

# ---------- 解析架构列表 ----------
IFS=',' read -ra ARCH_LIST <<< "$ARCHS"

# ---------- 目录 ----------
SOURCE_BASE="dist/$VERSION"
SIGNED_BASE="dist/${VERSION}-signed"

# 签名参数
SIGN_ARGS=(--force --sign "$CERT_NAME" --options runtime --timestamp --entitlements "$ENTITLEMENTS")

# 全局开始时间
GLOBAL_START=$(date +%s)

# ---------- 辅助函数 ----------
print_duration() {
  local START=$1
  local END
  END=$(date +%s)
  local DURATION=$((END - START))
  echo "   ⏱  耗时：${DURATION} 秒"
}

# 根据架构获取源目录名
get_platform_dir() {
  case "$1" in
    arm64) echo "darwin-arm64" ;;
    x64)   echo "darwin-x64" ;;
    *)     echo ""; return 1 ;;
  esac
}

# 根据架构获取源 DMG 文件名（electron-builder 产物命名）
get_source_dmg_pattern() {
  local arch="$1"
  echo "${APP_NAME}-*-${arch}.dmg"
}

# ---------- 单架构签名公证流程 ----------
# 参数: $1=架构 (arm64/x64)
# 每个架构的日志写入独立文件
sign_and_notarize_arch() {
  local arch="$1"
  local platform_dir
  platform_dir=$(get_platform_dir "$arch")
  local source_dir="${SOURCE_BASE}/${platform_dir}"
  local signed_dir="${SIGNED_BASE}/${platform_dir}"
  local log_file="/tmp/qq-pet-sign-${VERSION}-${arch}.log"
  local notary_log="${signed_dir}/notarization.log"

  {
    echo "========================================"
    echo " 📦 开始签名公证 ${APP_NAME} ${VERSION} (${arch})"
    echo " 时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================"
    echo ""

    # ---------- 检查源 DMG ----------
    local source_dmg
    source_dmg=$(ls "${source_dir}/"*.dmg 2>/dev/null | head -1)
    if [ -z "$source_dmg" ]; then
      echo "❌ 未找到源 DMG: ${source_dir}/*.dmg"
      return 1
    fi
    echo "✅ 找到源 DMG: $source_dmg"

    # 创建输出目录
    mkdir -p "$signed_dir"

    # ---------- 阶段 1/7：挂载 DMG 提取 .app ----------
    echo ""
    echo "🔴 阶段 1/7：从 DMG 提取 .app..."
    local STAGE_START
    STAGE_START=$(date +%s)

    local mount_point="/tmp/qq-pet-mount-${arch}-$$"
    mkdir -p "$mount_point"

    echo "   挂载 DMG: $source_dmg -> $mount_point"
    if ! hdiutil attach "$source_dmg" -mountpoint "$mount_point" -nobrowse -quiet; then
      echo "   ❌ hdiutil attach 失败，等待 3 秒后重试..."
      sleep 3
      hdiutil attach "$source_dmg" -mountpoint "$mount_point" -nobrowse -quiet
    fi

    # 查找 .app（名称可能包含中文）
    local app_in_dmg
    app_in_dmg=$(ls -d "$mount_point/"*.app 2>/dev/null | head -1)
    if [ -z "$app_in_dmg" ]; then
      echo "   ❌ 挂载成功但未找到 .app，挂载点内容:"
      ls -la "$mount_point/" || true
      return 1
    fi

    local app_basename
    app_basename=$(basename "$app_in_dmg")
    local app_path="${signed_dir}/${app_basename}"
    # 清除旧的 .app（如果存在）
    rm -rf "$app_path"
    # 使用 ditto 代替 cp -R，正确处理符号链接和扩展属性
    echo "   复制 .app 到签名目录..."
    ditto "$app_in_dmg" "$app_path"
    echo "   复制完成，大小: $(du -sh "$app_path" | cut -f1)"

    # 卸载当前架构的 DMG
    echo "   卸载 DMG..."
    hdiutil detach "$mount_point" -force -quiet 2>/dev/null || true
    rmdir "$mount_point" 2>/dev/null || true

    echo "   ✅ 提取完成: $app_path"
    print_duration "$STAGE_START"

    # ---------- 阶段 2/7：清除旧签名 ----------
    echo ""
    echo "🔴 阶段 2/7：清除旧签名..."
    STAGE_START=$(date +%s)

    find "$app_path" -type d -name "*.app" -o -type d -name "*.framework" | while read -r bundle; do
      codesign --remove-signature "$bundle" 2>/dev/null || true
    done
    codesign --remove-signature "$app_path" 2>/dev/null || true

    echo "   ✅ 旧签名已清除"
    print_duration "$STAGE_START"

    # ---------- 阶段 3/7：签名所有二进制文件（由内到外）----------
    echo ""
    echo "🟢 阶段 3/7：签名所有二进制文件..."
    STAGE_START=$(date +%s)

    # 1) .dylib 和 .node
    find "$app_path" -type f \( -name "*.dylib" -o -name "*.node" \) | while read -r file; do
      codesign "${SIGN_ARGS[@]}" "$file"
    done

    # 2) Resources 下的 Mach-O 可执行文件
    find "$app_path/Contents/Resources" -type f -perm +111 ! -name "*.dylib" ! -name "*.node" 2>/dev/null | while read -r file; do
      local file_type
      file_type=$(file -b "$file")
      if echo "$file_type" | grep -q "Mach-O"; then
        codesign "${SIGN_ARGS[@]}" "$file"
      fi
    done

    # 3) Frameworks 下的 Mach-O 文件
    find "$app_path/Contents/Frameworks" -type f -perm +111 ! -name "*.dylib" ! -name "*.node" | while read -r file; do
      local file_type
      file_type=$(file -b "$file")
      if echo "$file_type" | grep -q "Mach-O"; then
        codesign "${SIGN_ARGS[@]}" "$file"
      fi
    done

    # 4) .framework bundle
    find "$app_path/Contents/Frameworks" -maxdepth 1 -type d -name "*.framework" | while read -r fw; do
      codesign "${SIGN_ARGS[@]}" "$fw"
    done

    # 5) Helper .app
    find "$app_path/Contents/Frameworks" -type d -name "*.app" | sort -r | while read -r helper; do
      codesign "${SIGN_ARGS[@]}" "$helper"
    done

    # 6) 顶层 .app
    codesign "${SIGN_ARGS[@]}" "$app_path"

    echo "   ✅ 签名完成"
    print_duration "$STAGE_START"

    # ---------- 阶段 4/7：验证签名 ----------
    echo ""
    echo "🟢 阶段 4/7：验证签名..."
    STAGE_START=$(date +%s)

    codesign --verify --deep --strict "$app_path"
    echo "   ✅ 签名验证通过"
    print_duration "$STAGE_START"

    # ---------- 阶段 5/7：提交苹果公证 ----------
    echo ""
    echo "🟢 阶段 5/7：提交苹果公证..."
    STAGE_START=$(date +%s)

    local zip_path="${signed_dir}/${APP_NAME}-${arch}.zip"
    ditto -c -k --keepParent "$app_path" "$zip_path"

    # 提交公证并捕获输出以提取 submission ID
    local notary_output
    notary_output=$(xcrun notarytool submit "$zip_path" \
      --keychain-profile "$NOTARY_PROFILE" \
      --wait 2>&1) || {
      echo "❌ 公证失败！"
      echo "$notary_output"
      echo "$notary_output" > "$notary_log"
      return 1
    }

    echo "$notary_output"

    # 提取 submission ID 并记录
    local submission_id
    submission_id=$(echo "$notary_output" | grep -i "id:" | head -1 | awk '{print $NF}')

    {
      echo "# 公证记录"
      echo "版本: ${VERSION}"
      echo "架构: ${arch}"
      echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
      echo "Submission ID: ${submission_id}"
      echo ""
      echo "## notarytool 完整输出"
      echo "$notary_output"
    } > "$notary_log"

    echo "   ✅ 公证通过 (Submission ID: ${submission_id})"
    echo "   📝 公证记录: $notary_log"
    print_duration "$STAGE_START"

    # ---------- 阶段 6/7：stapler 绑定公证结果 ----------
    echo ""
    echo "🟢 阶段 6/7：stapler 绑定公证结果..."
    STAGE_START=$(date +%s)

    xcrun stapler staple "$app_path"
    echo "   ✅ Staple 完成"
    print_duration "$STAGE_START"

    # ---------- 阶段 7/7：生成签名版 DMG ----------
    echo ""
    echo "🟢 阶段 7/7：生成签名版 DMG..."
    STAGE_START=$(date +%s)

    local signed_dmg="${signed_dir}/${APP_NAME}-${VERSION}-${arch}-signed.dmg"
    # 使用带架构后缀的唯一卷名，避免并行时两个架构创建同名卷冲突
    local vol_name="${APP_NAME}-${arch}"

    # 预清理：仅卸载当前架构对应的卷名
    echo "   🧹 清理可能的残留挂载 (${vol_name})..."
    if [ -d "/Volumes/${vol_name}" ]; then
      echo "   ⚠️  发现残留挂载卷: /Volumes/${vol_name}"
      hdiutil detach "/Volumes/${vol_name}" -force -quiet 2>/dev/null || true
      sleep 1
    fi

    local tmp_dir
    tmp_dir=$(mktemp -d)
    ditto "$app_path" "$tmp_dir/${app_basename}"
    ln -s /Applications "$tmp_dir/Applications"

    # 带重试的 DMG 生成（最多 3 次）
    local retry=0
    local max_retries=3
    local dmg_ok=false
    while [ "$retry" -lt "$max_retries" ]; do
      if hdiutil create -volname "$vol_name" -srcfolder "$tmp_dir" -ov -format UDZO "$signed_dmg" 2>&1; then
        dmg_ok=true
        break
      else
        retry=$((retry + 1))
        echo "   ⚠️  hdiutil create 失败（第 ${retry}/${max_retries} 次），等待 3 秒后重试..."
        if [ -d "/Volumes/${vol_name}" ]; then
          hdiutil detach "/Volumes/${vol_name}" -force -quiet 2>/dev/null || true
        fi
        sleep 3
      fi
    done

    rm -rf "$tmp_dir"

    if [ "$dmg_ok" = true ]; then
      echo "   ✅ DMG 生成: $signed_dmg"
    else
      echo "   ❌ DMG 生成失败（已重试 ${max_retries} 次）"
      print_duration "$STAGE_START"
      return 1
    fi
    print_duration "$STAGE_START"

    # ---------- 清理临时文件（只保留 DMG 和公证日志） ----------
    rm -f "$zip_path"
    rm -rf "$app_path"

    echo ""
    echo "========================================"
    echo " 🎉 ${arch} 签名公证完成！"
    echo " 📄 DMG: $signed_dmg"
    echo " 📝 公证记录: $notary_log"
    echo "========================================"

  } > "$log_file" 2>&1

  return 0
}

# ============================================================
# 主流程
# ============================================================

echo "========================================"
echo " 📦 QQ宠物 v${VERSION} 签名公证"
echo " 架构: ${ARCH_LIST[*]}"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo ""

# ---------- 预检查 ----------
echo "🔍 预检查..."
HAS_ERROR=false

for arch in "${ARCH_LIST[@]}"; do
  platform_dir=$(get_platform_dir "$arch")
  source_dir="${SOURCE_BASE}/${platform_dir}"

  if ! ls "${source_dir}/"*.dmg 1>/dev/null 2>&1; then
    echo "   ❌ 未找到 ${arch} 源 DMG: ${source_dir}/*.dmg"
    HAS_ERROR=true
  else
    echo "   ✅ ${arch}: $(ls "${source_dir}/"*.dmg)"
  fi
done

if [ "$HAS_ERROR" = true ]; then
  echo ""
  echo "❌ 预检查失败，请先完成打包"
  exit 1
fi

echo "   ✅ 预检查通过"
echo ""

# ---------- 并行签名公证 ----------
if [ "${#ARCH_LIST[@]}" -gt 1 ]; then
  echo "🚀 并行启动 ${#ARCH_LIST[@]} 个架构的签名公证..."
  echo "   日志文件:"
  for arch in "${ARCH_LIST[@]}"; do
    echo "   - ${arch}: /tmp/qq-pet-sign-${VERSION}-${arch}.log"
  done
  echo ""

  PIDS=""
  PID_ARCHS=""

  for arch in "${ARCH_LIST[@]}"; do
    sign_and_notarize_arch "$arch" &
    pid=$!
    if [ -z "$PIDS" ]; then
      PIDS="$pid"
      PID_ARCHS="$arch"
    else
      PIDS="$PIDS $pid"
      PID_ARCHS="$PID_ARCHS $arch"
    fi
    echo "   🚀 ${arch} 已启动 (PID: $pid)"
  done

  echo ""
  echo "⏳ 等待所有架构完成..."
  echo ""

  read -ra PID_ARR <<< "$PIDS"
  read -ra ARCH_ARR <<< "$PID_ARCHS"

  FAILED_ARCHS=""
  SUCCESS_ARCHS=""

  for i in "${!PID_ARR[@]}"; do
    pid="${PID_ARR[$i]}"
    arch="${ARCH_ARR[$i]}"
    if wait "$pid"; then
      echo "   ✅ ${arch} 签名公证成功"
      SUCCESS_ARCHS="$SUCCESS_ARCHS $arch"
    else
      echo "   ❌ ${arch} 签名公证失败（日志: /tmp/qq-pet-sign-${VERSION}-${arch}.log）"
      FAILED_ARCHS="$FAILED_ARCHS $arch"
    fi
  done
else
  # 单架构，直接前台运行
  arch="${ARCH_LIST[0]}"
  echo "🚀 开始 ${arch} 签名公证..."
  echo "   日志: /tmp/qq-pet-sign-${VERSION}-${arch}.log"
  echo ""

  FAILED_ARCHS=""
  SUCCESS_ARCHS=""

  if sign_and_notarize_arch "$arch"; then
    echo "   ✅ ${arch} 签名公证成功"
    SUCCESS_ARCHS="$arch"
  else
    echo "   ❌ ${arch} 签名公证失败"
    FAILED_ARCHS="$arch"
  fi

  # 单架构也输出日志到终端
  cat "/tmp/qq-pet-sign-${VERSION}-${arch}.log"
fi

# ---------- 最终报告 ----------
GLOBAL_END=$(date +%s)
GLOBAL_DURATION=$((GLOBAL_END - GLOBAL_START))

echo ""
echo "============================================================"
echo "  QQ宠物 v${VERSION} 签名公证报告"
echo "============================================================"
echo ""

for arch in "${ARCH_LIST[@]}"; do
  platform_dir=$(get_platform_dir "$arch")
  signed_dmg="${SIGNED_BASE}/${platform_dir}/${APP_NAME}-${VERSION}-${arch}-signed.dmg"
  notary_log="${SIGNED_BASE}/${platform_dir}/notarization.log"

  is_failed=false
  for fa in $FAILED_ARCHS; do
    if [ "$fa" = "$arch" ]; then
      is_failed=true
      break
    fi
  done

  if [ "$is_failed" = true ]; then
    printf "  ❌ %-8s  失败（日志: /tmp/qq-pet-sign-%s-%s.log）\n" "$arch" "$VERSION" "$arch"
  elif [ -f "$signed_dmg" ]; then
    local_sub_id=""
    if [ -f "$notary_log" ]; then
      local_sub_id=$(grep "Submission ID:" "$notary_log" | head -1 | awk '{print $NF}')
    fi
    printf "  ✅ %-8s  → %s\n" "$arch" "$signed_dmg"
    if [ -n "$local_sub_id" ]; then
      printf "  %-11s  公证 ID: %s\n" "" "$local_sub_id"
    fi
  else
    printf "  ⚠️  %-8s  DMG 未找到\n" "$arch"
  fi
done

echo ""
echo "  📁 产物目录: ${SIGNED_BASE}/"
echo "  ⏱  总耗时: ${GLOBAL_DURATION} 秒"
echo ""

if [ -n "$FAILED_ARCHS" ]; then
  echo "⚠️  部分架构失败，请检查日志"
  echo ""
  for fa in $FAILED_ARCHS; do
    echo "  查看日志: cat /tmp/qq-pet-sign-${VERSION}-${fa}.log"
  done
  exit 1
else
  echo "🎉 全部签名公证完成！"
  echo ""
  echo "产物列表:"
  ls -lh "${SIGNED_BASE}"/darwin-*/*.dmg 2>/dev/null || true
  exit 0
fi
