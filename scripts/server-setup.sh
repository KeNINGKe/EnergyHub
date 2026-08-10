#!/usr/bin/env bash
#
# EnergyHub 香港轻量服务器一键初始化（Ubuntu 22.04）
#
# 用途：把站点部署到香港服务器，让大陆同事不挂梯子也能直接访问。
#   - 仓库是公开的，服务器直接 git clone + 定时 pull，免 SSH 密钥/凭证
#   - nginx 只放行 index.html / assets / data / feeds，其余路径一律 404
#   - 每 15 分钟自动从 GitHub main 拉取最新日报（GitHub Actions 提交后生效）
#
# 用法（在服务器上以 root 运行）：
#   bash server-setup.sh
#
set -euo pipefail

REPO_URL="https://github.com/KeNINGKe/EnergyHub.git"
SITE_DIR="/opt/energyhub"

echo "==> 1/4 安装 nginx / git"
apt-get update -y
apt-get install -y nginx git

echo "==> 2/4 克隆或同步站点仓库（公开仓库，免凭证）"
if [ -d "$SITE_DIR/.git" ]; then
  git -C "$SITE_DIR" fetch origin main --quiet
  git -C "$SITE_DIR" reset --hard origin/main --quiet
  echo "    已存在，已同步到最新 main"
else
  git clone "$REPO_URL" "$SITE_DIR"
fi

echo "==> 3/4 写入 nginx 站点配置"
cat > /etc/nginx/sites-available/energyhub <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /opt/energyhub;

    index index.html;

    # 只放行静态站点所需路径，其余一律 404（避免暴露仓库内脚本/配置/依赖）
    location = /            { try_files /index.html =404; }
    location = /index.html  { }
    location /assets/       { }
    location /data/         { }
    location /feeds/        { }
    location /              { return 404; }

    # 动态 JSON 不强缓存，日报更新后立即生效
    location ~* \.json$     { add_header Cache-Control "no-cache"; }
    # 静态资源短缓存
    location ~* \.(css|js|png|jpe?g|svg|woff2?)$ { add_header Cache-Control "public, max-age=86400"; }
}
NGINX
ln -sf /etc/nginx/sites-available/energyhub /etc/nginx/sites-enabled/energyhub
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> 4/4 配置定时同步（每 15 分钟 git pull）"
CRON_LINE="*/15 * * * * cd $SITE_DIR && git fetch origin main --quiet && git reset --hard origin/main --quiet"
( crontab -l 2>/dev/null | grep -v "$SITE_DIR" ; echo "$CRON_LINE" ) | crontab -

# 放行 80 端口（腾讯云/阿里云轻量自带防火墙，ubantu ufw 若启用则放行）
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "======================================================"
echo "  ✅ 初始化完成"
echo "  站点地址: http://$IP/"
echo "  自动同步: 每 15 分钟从 GitHub main 拉取最新日报"
echo "  检查:     curl -s http://$IP/ | head"
echo "  说明:     IP 直访为 HTTP；如需 HTTPS/域名再买域名配 Let's Encrypt"
echo "======================================================"
