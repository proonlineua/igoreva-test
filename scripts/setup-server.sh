#!/bin/bash
# Runs once on server start to ensure postfix is installed and running
if ! command -v postfix &>/dev/null; then
  echo "[SETUP] Installing postfix..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y postfix mailutils -q
  postconf -e "myhostname=beauty.proonline.com.ua"
  postconf -e "myorigin=beauty.proonline.com.ua"
  postconf -e "inet_interfaces=loopback-only"
  postconf -e "mydestination="
fi
if ! systemctl is-active --quiet postfix; then
  systemctl start postfix
fi
echo "[SETUP] Postfix ready"
