#!/bin/bash

echo "🚀 启动 md-to-notion API 服务"
echo "================================"

# 检查是否存在.env文件
if [ ! -f .env ]; then
    echo "⚠️  未找到.env文件，正在创建..."
    cp env.example .env
    echo "✅ 已创建.env文件，请编辑配置后重新运行"
    echo "📝 需要配置的环境变量："
    echo "   - NOTION_API_KEY: Notion Integration Token"
    echo "   - NOTION_PAGE_ID: Notion页面ID"
    exit 1
fi

# 检查是否安装了依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
fi

# 构建项目
echo "🔨 构建项目..."
npm run build

# 启动服务
echo "启动服务..."
npm start 