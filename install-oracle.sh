#!/usr/bin/env bash
set -e

echo "=== [1/5] 시스템 패키지 업데이트 및 Node.js, Python 설치 ==="
sudo apt-get update -y
sudo apt-get install -y curl git python3 python3-pip

# Node.js 20 설치 (LTS)
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "=== [2/5] PM2 (24시간 무중단 프로세스 매니저) 설치 ==="
sudo npm install -g pm2

echo "=== [3/5] 방화벽 포트 (8000) 개방 ==="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8000 -j ACCEPT || true
if command -v ufw &> /dev/null; then
    sudo ufw allow 8000/tcp || true
fi

echo "=== [4/5] Antigravity SDK 설치 ==="
pip3 install google-antigravity || pip install google-antigravity || true

echo "=== [5/5] agy 웹 콘솔 서버 PM2 백그라운드 등록 및 실행 ==="
pm2 delete agy-web 2>/dev/null || true
PORT=8000 pm2 start server.js --name agy-web
pm2 save

echo ""
echo "=========================================================="
echo "🎉 배포가 완료되었습니다!"
echo "서버 상태 확인: pm2 status"
echo "실시간 로그 확인: pm2 logs agy-web"
echo "서버 공용 IP 주소로 접속하세요: http://<오라클_공용_IP>:8000"
echo "=========================================================="
