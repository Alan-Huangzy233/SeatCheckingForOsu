#!/bin/bash

# 强制将工作目录切换到脚本所在的文件夹
cd "$(dirname "$0")"

echo -e "\033[36m=== OSU 选课监控启动器 / OSU Course Monitor Launcher ===\033[0m"

# ================= 1. 检测 Node.js =================
if ! command -v node &> /dev/null; then
    echo -e "\033[31m[警告] 未检测到 Node.js 环境！(Node.js not found!)\033[0m"
    echo "Linux 用户请使用包管理器手动安装 Node.js。"
    echo "例如在 Ubuntu/Debian 系统下，您可以运行以下命令："
    echo -e "\033[33msudo apt update && sudo apt install nodejs npm\033[0m"
    echo "安装完成后，请再次运行此脚本。"
    exit 1
fi

# ================= 2. 检测依赖包 =================
if [ ! -d "node_modules" ]; then
    echo -e "\n\033[33m[提示] 未检测到运行依赖，正在自动为您安装... (Installing required packages...)\033[0m"
    npm install node-fetch chalk nodemailer dotenv
    echo -e "\033[32m依赖安装完成！\033[0m\n"
fi

# ================= 3. 语言选择菜单 =================
echo "=================================================="
echo "请选择界面语言 (Please select your language):"
echo ""
echo " [1] 中文 (Chinese)"
echo " [2] English"
echo "=================================================="
read -p "请输入 1 或 2 然后按回车 (Enter 1 or 2): " choice

if [ "$choice" == "1" ]; then
    echo -e "\n\033[32m正在启动中文版监控程序...\033[0m"
    node checkCourseatAvailable.js
elif [ "$choice" == "2" ]; then
    echo -e "\n\033[32mStarting English version monitor...\033[0m"
    node ENcheckCourseSeatAvailable.js
else
    echo -e "\n\033[31m[错误] 输入无效，请重新运行脚本。(Invalid input.)\033[0m"
    exit 1
fi