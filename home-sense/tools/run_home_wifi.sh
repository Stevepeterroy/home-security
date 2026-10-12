#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export HAVEN_DEVICE_BIND=0.0.0.0
export HAVEN_DEVICE_TLS_CERT=data/device-tls/server.crt
export HAVEN_DEVICE_TLS_KEY=data/device-tls/server.key
export HAVEN_ALLOWED_HOSTS=192.168.1.15:8769
exec .venv/bin/python server.py
