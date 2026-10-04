#!/usr/bin/env bash
# Starts two throwaway OpenSSH servers for Brainbox integration tests (Linux, root).
#   127.0.0.1:2222  main test server   (password + key auth, forwarding on)
#   127.0.0.1:2223  "private" server reachable as jump target
# Exports nothing; the Rust tests read BBX_TEST_SSH=1 and the fixed values below.
set -euo pipefail
DIR=/tmp/bbx-sshd
mkdir -p "$DIR"
id bbx >/dev/null 2>&1 || useradd -m -s /bin/bash bbx
echo 'bbx:bbxpass' | chpasswd
echo 'bbx ALL=(ALL) ALL' > /etc/sudoers.d/bbx && chmod 440 /etc/sudoers.d/bbx
mkdir -p /home/bbx/.ssh
[ -f "$DIR/client_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/client_ed25519"
[ -f "$DIR/client_rsa_enc" ] || ssh-keygen -q -t rsa -b 2048 -N 'keypass' -f "$DIR/client_rsa_enc"
cat "$DIR/client_ed25519.pub" "$DIR/client_rsa_enc.pub" > /home/bbx/.ssh/authorized_keys
# The integration tests run as the GitHub runner user, not root, so the
# throwaway client private keys must be readable by that test process.
chmod 644 "$DIR/client_ed25519" "$DIR/client_rsa_enc"
chown -R bbx:bbx /home/bbx/.ssh; chmod 700 /home/bbx/.ssh; chmod 600 /home/bbx/.ssh/authorized_keys
mkdir -p /run/sshd
for port in 2222 2223; do
  [ -f "$DIR/host_$port" ] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/host_$port"
  cat > "$DIR/sshd_$port.conf" <<CONF
Port $port
ListenAddress 127.0.0.1
HostKey $DIR/host_$port
PidFile $DIR/sshd_$port.pid
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PubkeyAuthentication yes
UsePAM yes
AllowTcpForwarding yes
GatewayPorts no
PermitRootLogin no
Subsystem sftp internal-sftp
MaxStartups 50
MaxSessions 50
LogLevel ERROR
CONF
  if [ -f "$DIR/sshd_$port.pid" ] && kill -0 "$(cat "$DIR/sshd_$port.pid")" 2>/dev/null; then continue; fi
  /usr/sbin/sshd -f "$DIR/sshd_$port.conf"
done
# Optional Docker fixtures for the Docker manager tests (skipped when Docker is absent).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  getent group docker >/dev/null && usermod -aG docker bbx
  if ! docker image inspect bbx/busybox:test >/dev/null 2>&1; then
    docker pull -q busybox:stable >/dev/null && docker tag busybox:stable bbx/busybox:test
  fi
  if ! docker container inspect bbx-web >/dev/null 2>&1; then
    docker run -d --name bbx-web bbx/busybox:test /bin/sh -c 'while true; do echo "tick $(date +%s)"; sleep 1; done' >/dev/null
  fi
  docker start bbx-web >/dev/null 2>&1 || true
  echo "docker fixtures ready (bbx-web)"
fi
echo "test sshd ready on 2222/2223"
