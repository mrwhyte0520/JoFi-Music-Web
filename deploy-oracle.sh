#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  JoFi Music · Deploy para Oracle Cloud Free Tier (Ubuntu)
#  Uso:  sudo bash deploy-oracle.sh
# ============================================================

APP_DIR="/opt/jofi-music"
PORT="${PORT:-8000}"
UBUNTU=$(lsb_release -sc 2>/dev/null || echo "noble")

echo "==> [1/6] Actualizando sistema..."
apt-get update -y
apt-get upgrade -y

echo "==> [2/6] Instalando dependencias del sistema..."
apt-get install -y \
    python3 python3-pip python3-venv \
    nodejs npm \
    git curl wget ffmpeg \
    ca-certificates

# ffmpeg nunca sobra (manejo/parsing de medios). Los nativos de Ubuntu
# ya traen yt-dlp pero NO usamos el del sistema; instalamos el de PyPI
# porque se actualiza con cada fix de YouTube (overwrite="--upgrade").

echo "==> [3/6] Instalando dependencias de Python..."
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip
"$APP_DIR/venv/bin/pip" install --upgrade \
    "yt-dlp>=2025.12.8" \
    "ytmusicapi>=1.10.3"

echo "==> [4/6] Preparando carpeta de la app..."
mkdir -p "$APP_DIR"
if [ ! -f "$APP_DIR/server.py" ]; then
    echo "!! No encontré server.py en $APP_DIR"
    echo "   Copia el proyecto completo ahí primero:"
    echo "     scp -r JoFi-Music-Web ubuntu@<IP>:/opt/jofi-music"
    echo "   ... o clona tu repo:"
    echo "     git clone https://github.com/mrwhyte0520/JoFi-Music-Web.git $APP_DIR"
    exit 1
fi

echo "==> [5/6] Compilando frontend (app/dist)..."
cd "$APP_DIR/app"
npm install
npm run build

echo "==> [6/6] Creando servicio systemd..."
cat > /etc/systemd/system/jofi-music.service <<SVCEOF
[Unit]
Description=JoFi Music — player PWA + API (ytmusicapi/yt-dlp)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/venv/bin/python server.py
Environment=PORT=$PORT
Restart=always
RestartSec=5
User=root
StandardOutput=append:/var/log/jofi-music.log
StandardError=append:/var/log/jofi-music.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable jofi-music
systemctl restart jofi-music

echo ""
echo "============================================================"
echo "  JoFi Music desplegado en Oracle Cloud ✅"
echo "  URL local:  http://localhost:$PORT"
echo "  IP pública: $(curl -s ifconfig.me || echo 'revisa tu consola OCI')"
echo "  Logs:       journalctl -u jofi-music -f"
echo "============================================================"
echo ""
echo "⚠️  IMPORTANTE: abre el puerto $PORT en Oracle Cloud"
echo "   Consola OCI → Networking → Security List → '# add Ingress Rules'"
echo "   Source CIDR: 0.0.0.0/0 · Protocolo: TCP · Puerto: $PORT"
echo ""
echo "🎯 Prueba final:  http://$(curl -s ifconfig.me):$PORT/api/charts?cc=do"