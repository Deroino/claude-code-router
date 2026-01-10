#!/bin/bash
# 开发重建脚本 - 自动清理缓存、构建、全局安装并重启服务

set -e  # 遇到错误立即退出

echo "========================================="
echo "开始开发重建流程..."
echo "========================================="

# 1. 清理缓存和构建产物
echo "🧹 清理缓存和构建产物..."
rm -rf node_modules/.cache
rm -rf packages/*/dist
rm -rf packages/*/node_modules/.cache
rm -rf dist
echo "✅ 缓存清理完成"

# 2. 安装依赖（如果需要）
echo "📦 安装依赖..."
pnpm install
echo "✅ 依赖安装完成"

# 3. 构建项目
echo "🔨 构建项目..."
npm run build
echo "✅ 项目构建完成"

# 4. 全局安装 CLI
echo "📦 全局安装 CLI..."
npm install . -g
echo "✅ 全局安装完成"

# 5. 重启服务
echo "🔄 重启服务..."
ccr restart
echo "✅ 服务重启完成"

# 6. 清空调试日志（可选）
echo "📝 清空调试日志..."
> /tmp/ccr-debug-transformer.log
echo "✅ 调试日志已清空"

echo "========================================="
echo "✨ 开发重建流程完成！"
echo "========================================="
echo ""
echo "已完成的步骤："
echo "  1. ✅ 清理缓存和构建产物"
echo "  2. ✅ 安装依赖"
echo "  3. ✅ 构建项目"
echo "  4. ✅ 全局安装 CLI"
echo "  5. ✅ 重启服务"
echo "  6. ✅ 清空调试日志"