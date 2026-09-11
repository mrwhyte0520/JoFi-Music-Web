# ============================================================
#  JoFi Music · Oracle Cloud Free Tier — Guía completa
#  VM: Ubuntu 22.04+ (Ampere A1, 2 OCPUs / 12 GB · gratis siempre)
# ============================================================

## 1) Crea la cuenta y la VM
# 1. oracle.com/cloud/free → sign up (tarjeta de crédito SOLO para verificar,
#    no te cobran si te quedas en Always Free)
# 2. Consola OCI → Compute → Instances → Create Instance
# 3. Image: "Canonical Ubuntu 24.04" (o 22.04)
# 4. Shape: VM.Standard.A1.Flex → 2 OCPUs / 12 GB RAM (Always Free)
# 5. Networking: crea VCN + subnet publica automática
# 6. Añade tu SSH key pública (la generas con: ssh-keygen)
# 7. Create → espera a que esté RUNNING

## 2) Revelar tu IP pública
# Consola OCI → Compute → Instances → tu VM → Public IP Address

## 3) Subir tu proyecto (desde tu PC Windows)
#    scp -r JoFi-Music-Web ubuntu@<IP-DE-LA-VM>:/tmp/
#    o directamente al destino:
#    scp -r JoFi-Music-Web ubuntu@<IP>:/opt/jofi-music  (necesitas crear /opt/jofi-music antes)
#
# Más fácil SI CLI (Windows):
#    gh repo clone mrwhyte0520/JoFi-Music-Web
#    luego en la VM:  git clone https://github.com/mrwhyte0520/JoFi-Music-Web.git /opt/jofi-music

## 4) Ejecutar el deploy
#    ssh ubuntu@<IP>
#    sudo mv /tmp/JoFi-Music-Web /opt/jofi-music       (si copiaste con scp)
#    cd /opt/jofi-music
#    sudo bash deploy-oracle.sh

## 5) Abrir el puerto 8000 en el firewall de Oracle (CRÍTICO)
# Consola OCI → Networking → Virtual Cloud Networks → tu VCN → Security Lists
# → Default Security List → Add Ingress Rules:
#    Source CIDR:   0.0.0.0/0
#    IP Protocol:   TCP
#    Destination Port Range:  8000

## 6) Prueba
#    http://<IP>/api/charts?cc=do
#    Si responde JSON → todo listo, comparte:  http://<IP>   (la PWA)
#    Si YouTube bloquea → sigue el paso 7.

## 7) Si YouTube bloquea la IP (hay dos salvavidas)

# a) Instalar yt-dlp actualizado (el venv ya usa PyPI, se auto-actualiza con
#    cada fix de YouTube):
#    sudo /opt/jofi-music/venv/bin/pip install --upgrade yt-dlp
#    sudo systemctl restart jofi-music

# b) Probar rotación de clientes (tu server.py ya usa android_music/android_vr
#    primero, que es el que mejor esquiva el bloqueo en IPs de Oracle).

# c) Último recurso: Cloudflare WARP en la VM (enmascara la IP como residencial)
#    sudo apt install -y cloudflare-warp
#    warp-cli register && warp-cli connect
#    (esto exporta el tráfico saliente por la red de Cloudflare; a veces
#    desbloquea YouTube por completo). Si no funciona, bash: warp-cli disconnect.

## 8) Mantenimiento
#    Ver logs:    journalctl -u jofi-music -f
#    Reiniciar:   sudo systemctl restart jofi-music
#    Actualizar:  cd /opt/jofi-music && git pull && sudo bash deploy-oracle.sh
#    La caché SQLite sobrevive reinicios (RUNTIME_DIR = ROOT).

## 9) Límites (resumidos)
#    - 2 OCPUs ARM + 12 GB RAM  (ocurre 1 VM o 2)
#    - 200 GB disco, 10 TB de salida de datos/mes
#    - VM inactiva >7 días (CPU <20%) → Oracle puede reclamarla:
#      para evitarlo, deja avanzar el proxy / audio o toca la app seguido.
#    - Nunca subas de los límites Always Free o la VM se apaga.

## 10) Optimización anti-idle (opcional)
#    Un cron que haga ping al backend cada 5 min evita que Oracle reclame la VM:
#    crontab -e → añade:  */5 * * * * curl -s http://localhost:8000/api/charts?cc=do > /dev/null