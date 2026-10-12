#!/usr/bin/env python3
"""
wifi_proxy.py — HTTP-aware proxy that forwards 0.0.0.0:8768 → 127.0.0.1:8768
and rewrites the Host header to '127.0.0.1:8768' so Haven accepts the request.

Usage:
    python wifi_proxy.py

Then open  http://<your-mac-ip>:8768  in your phone browser.
Stop with Ctrl+C.
"""
import socket, threading, sys, re

LOCAL_HOST  = "127.0.0.1"
BIND_HOST   = "0.0.0.0"
PORT        = 8768
TARGET_HOST = f"{LOCAL_HOST}:{PORT}"
BUF         = 65536


def rewrite_host(data: bytes) -> bytes:
    """Replace the Host header value with 127.0.0.1:8768 in raw HTTP bytes."""
    # Only touch the header section (before the first blank line)
    try:
        header_end = data.find(b"\r\n\r\n")
        if header_end == -1:
            header_end = data.find(b"\n\n")
        if header_end == -1:
            # Headers not complete yet — rewrite anyway (safe for our use case)
            headers = data
            body = b""
        else:
            sep_len = 4 if data[header_end:header_end+4] == b"\r\n\r\n" else 2
            headers = data[:header_end]
            body = data[header_end:]

        # Replace Host: <anything> with Host: 127.0.0.1:8768
        headers = re.sub(
            rb"(?i)(Host\s*:\s*)[^\r\n]+",
            rb"\g<1>" + TARGET_HOST.encode(),
            headers,
        )
        return headers + body
    except Exception:
        return data


def pipe_raw(src: socket.socket, dst: socket.socket):
    """Forward raw bytes src → dst (for responses, no rewriting needed)."""
    try:
        while True:
            data = src.recv(BUF)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for s in (src, dst):
            try: s.shutdown(socket.SHUT_RDWR)
            except Exception: pass
            try: s.close()
            except Exception: pass


def pipe_request(src: socket.socket, dst: socket.socket):
    """Forward bytes from phone → Haven, rewriting the Host header."""
    try:
        # Read the first chunk which normally contains the full request headers
        first = src.recv(BUF)
        if not first:
            return
        first = rewrite_host(first)
        dst.sendall(first)
        # Stream the rest (request body / subsequent requests) without rewriting
        while True:
            data = src.recv(BUF)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for s in (src, dst):
            try: s.shutdown(socket.SHUT_RDWR)
            except Exception: pass
            try: s.close()
            except Exception: pass


def handle(client: socket.socket, addr):
    try:
        backend = socket.create_connection((LOCAL_HOST, PORT), timeout=5)
    except Exception as exc:
        print(f"  [proxy] Cannot reach Haven on {LOCAL_HOST}:{PORT} — {exc}")
        client.close()
        return
    # phone → Haven  (rewrite Host header)
    t1 = threading.Thread(target=pipe_request, args=(client, backend), daemon=True)
    # Haven → phone  (pass through as-is)
    t2 = threading.Thread(target=pipe_raw, args=(backend, client), daemon=True)
    t1.start()
    t2.start()


def get_wifi_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "<your-mac-ip>"


def main():
    ip = get_wifi_ip()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((BIND_HOST, PORT))
    except OSError as exc:
        print(f"[proxy] Cannot bind {BIND_HOST}:{PORT} — {exc}")
        print("        Make sure Haven is NOT already binding this port externally.")
        sys.exit(1)
    srv.listen(64)
    print(f"[proxy] HTTP-aware proxy  {BIND_HOST}:{PORT} → {LOCAL_HOST}:{PORT}")
    print(f"[proxy] Rewrites Host header to '{TARGET_HOST}'")
    print(f"[proxy] Open in your phone browser:  http://{ip}:{PORT}")
    print( "[proxy] Press Ctrl+C to stop.\n")
    try:
        while True:
            client, addr = srv.accept()
            threading.Thread(target=handle, args=(client, addr), daemon=True).start()
    except KeyboardInterrupt:
        print("\n[proxy] Stopped.")
    finally:
        srv.close()


if __name__ == "__main__":
    main()
