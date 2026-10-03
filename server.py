import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import threading
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(ROOT, "keys.json")
USERS_FILE = os.path.join(ROOT, "users.json")
LOGS_FILE = os.path.join(ROOT, "logs.json")
DONATIONS_FILE = os.path.join(ROOT, "donations.json")
BACKUPS_DIR = os.path.join(ROOT, "backups")
SCRIPTS_DIR = os.path.join(ROOT, "scripts")
PORT = int(os.environ.get("CAPY_PORT", "8000"))
KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_LOGS = 500


def _load_env_file():
    """Minimal .env reader (key=value, one per line, # comments, no deps)."""
    try:
        env_path = os.path.join(ROOT, ".env")
        if not os.path.isfile(env_path):
            return
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip("\"'")
                if k:
                    os.environ.setdefault(k, v)
    except Exception:
        pass


_load_env_file()

# CORS allow-list â€” hangi Origin'lerin tarayici erisimine izin verildigi.
# Ayni-orijin (kendi siten) istekleri zaten CORS gerektirmez; sadece bu listeye
# giren yabanci Origin'ler icin Access-Control-Allow-Origin yazilir.
ALLOWED_ORIGINS = tuple(
    o.strip().rstrip("/")
    for o in os.environ.get(
        "CAPY_ALLOWED_ORIGINS",
        "https://capyscriptss.pythonanywhere.com,https://liability-awry-trouble.ngrok-free.dev,http://127.0.0.1:8000,http://localhost:8000"
    ).split(",")
)
# Buyuk harcama / robeks hareketi uyarisi esigi (RBX).
SPEND_ALERT_THRESHOLD = int(os.environ.get("CAPY_SPEND_ALERT", "25000"))
# Webhook imza dogrulamasinda kullanilan gizli anahtar (hicbir kodda saklanmaz).
WEBHOOK_SECRET = os.environ.get("CAPY_WEBHOOK_SECRET", "")
# Demo anahtarinin uzaktan kullanimina izin verilsin mi? (varsayilan: HAYIR)
ALLOW_DEMO_KEY_REMOTE = os.environ.get("CAPY_ALLOW_DEMO_KEY_REMOTE", "0") == "1"
# Ucretli/uzak rollout'da HTTPâ†’HTTPS zorlamasi devrede mi (X-Forwarded-Proto tabanli).
FORCE_HTTPS = os.environ.get("CAPY_FORCE_HTTPS", "") == "1" or os.environ.get("CAPY_FORCE_HTTPS", "") == "auto"

# Statik erisimden kapatilacak dosya/dizin adlari (ilk seviye).
SENSITIVE_PATHS = {
    "server.py", "capy_wsgi.py", "pythonanywhere_wsgi.txt",
    "users.json", "keys.json", "donations.json", "logs.json",
    ".env", ".git", "backups", "__pycache__", "deploy",
    "oracle_deploy.zip", "pythonanywhere_deploy.zip",
    "ngrok.exe", "cloudflared.exe",
    "start-capyscripts.bat", "start-public.bat", "stop-capyscripts.bat"
}
SENSITIVE_FILES = {
    os.path.realpath(os.path.join(ROOT, n))
    for n in ("server.py", "capy_wsgi.py", ".env", "users.json", "keys.json", "donations.json", "logs.json")
}


def is_sensitive_path(path):
    """Statik dosya erisiminde kod/veri/yedek dosyalarini kapat. '..' / realpath kacisini da onler."""
    try:
        raw = urllib.parse.unquote(path or "/")
        rel = raw.split("?")[0].lstrip("/")
        if ".." in rel or ".." in raw:
            return True
        first = rel.split("/")[0].lower()
        if first in SENSITIVE_PATHS:
            return True
        full = os.path.realpath(os.path.join(ROOT, rel))
        if full == os.path.realpath(BACKUPS_DIR) or full.startswith(os.path.realpath(BACKUPS_DIR) + os.sep):
            return True
        if full in SENSITIVE_FILES:
            return True
    except Exception:
        return True
    return False

os.makedirs(BACKUPS_DIR, exist_ok=True)

TOKENS = {}
BREACH = {"active": False, "by": None, "at": None}
MESSAGE = {"text": "", "by": None, "at": None}
MAINTENANCE = {"active": False, "by": None, "at": None}

START_TIME = time.time()
REQUEST_COUNT = 0
REQUEST_LOCK = threading.Lock()

RATE_LIMIT_STORE = {}
RATE_LIMIT_LOCK = threading.Lock()

def check_rate_limit(ip, endpoint, max_requests=10, window=30):
    with RATE_LIMIT_LOCK:
        now = time.time()
        key = (ip, endpoint)
        history = RATE_LIMIT_STORE.get(key, [])
        history = [t for t in history if now - t < window]
        if len(history) >= max_requests:
            RATE_LIMIT_STORE[key] = history
            return False
        history.append(now)
        RATE_LIMIT_STORE[key] = history
        return True

def _copy_backup():
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    for filepath, name in [(USERS_FILE, "users"), (KEYS_FILE, "keys"), (LOGS_FILE, "logs"), (DONATIONS_FILE, "donations")]:
        if os.path.exists(filepath):
            bak_path = os.path.join(BACKUPS_DIR, f"{name}_{ts}.json")
            shutil.copy2(filepath, bak_path)
            baks = sorted([os.path.join(BACKUPS_DIR, f) for f in os.listdir(BACKUPS_DIR) if f.startswith(name)])
            if len(baks) > 10:
                for old_bak in baks[:-10]:
                    try:
                        os.remove(old_bak)
                    except Exception:
                        pass


def periodic_backup():
    # Degismis dosyalar icin 5dk'da bir yedek alir (PC/WSGI fark etmeksizin calisir).
    while True:
        time.sleep(300)
        try:
            _copy_backup()
        except Exception:
            pass


try:
    _copy_backup()
except Exception:
    pass
backup_thread = threading.Thread(target=periodic_backup, daemon=True)
backup_thread.start()


def load_logs():
    if os.path.exists(LOGS_FILE):
        try:
            with open(LOGS_FILE, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception:
            pass
    return []


LOGS = load_logs()


def save_logs():
    try:
        with open(LOGS_FILE, "w", encoding="utf-8") as f:
            json.dump(LOGS, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def log_event(event, user="", detail="", ip=""):
    try:
        LOGS.append({
            "ts": datetime.now().isoformat(timespec="seconds"),
            "event": event,
            "user": user or "-",
            "detail": detail or "",
            "ip": ip or ""
        })
        del LOGS[:-MAX_LOGS]
        save_logs()
    except Exception:
        pass


def new_key():
    return "SH-" + "-".join(
        "".join(secrets.choice(KEY_CHARS) for _ in range(4)) for _ in range(3)
    )


def load_users():
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def save_users(users):
    try:
        with open(USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def hash_password(password, salt_hex=None):
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120000)
    return salt.hex(), dk.hex()


def verify_password(password, salt_hex, hash_hex):
    try:
        salt = bytes.fromhex(salt_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120000)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


_FALLBACK_SCRIPS_PRICE = {
    "infinity-hub": 149,
    "arachnid-aim": 99,
    "mystic-race": 79,
    "blaze-admin": 199,
    "neon-speed": 49,
    "crystal-hub": 89,
    "void-extractor": 119,
    "shadow-ninja": 139,
    "quantum-trade": 109,
    "matrix-pro": 59
}


def load_prices():
    """Charge the same RB$ prices shown in the storefront (js/data.js is the source of truth)."""
    prices = {}
    try:
        data_path = os.path.join(ROOT, "js", "data.js")
        with open(data_path, "r", encoding="utf-8") as f:
            cur_id = None
            for line in f:
                s = line.strip()
                m = re.match(r'id\s*:\s*"([^"]+)"\s*,?\s*$', s)
                if m:
                    cur_id = m.group(1)
                    continue
                if cur_id:
                    m = re.match(r"price\s*:\s*(\d+)\s*,?\s*$", s)
                    if m:
                        prices[cur_id] = int(m.group(1))
                        cur_id = None
        scripts = {name[:-4] for name in os.listdir(SCRIPTS_DIR) if name.endswith(".lua")}
        prices = {sid: p for sid, p in prices.items() if sid in scripts}
    except Exception:
        return {}
    return prices


SCRIPS_PRICE = load_prices() or dict(_FALLBACK_SCRIPS_PRICE)
SCRIPS_PRICE = {k: 0 for k in SCRIPS_PRICE}


def user_for_token(token):
    return TOKENS.get(token)


def verify_roblox_username(username):
    try:
        req = urllib.request.Request(
            "https://users.roblox.com/v1/usernames/users",
            data=json.dumps({"usernames": [username], "excludeBannedUsers": False}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode())
                users = data.get("data", [])
                if users:
                    return {"name": users[0].get("name", username), "id": users[0].get("id"), "verified": True}
        except Exception:
            pass
        try:
            with urllib.request.urlopen(
                "https://api.roblox.com/users/get-by-username?username=" + urllib.parse.quote(username),
                timeout=6
            ) as resp:
                data = json.loads(resp.read().decode())
                if data.get("Id"):
                    return {"name": data.get("Username", username), "id": data.get("Id"), "verified": True}
        except Exception:
            pass
    except Exception:
        pass
    if os.environ.get("CAPY_OFFLINE_VERIFY", "1") == "1":
        return {"name": username, "id": None, "verified": False}
    return None


def public_user(user):
    return {
        "username": user["username"],
        "role": user.get("role", "user"),
        "wallet": user.get("wallet", 0),
        "banned": bool(user.get("banned")),
        "roblox": user.get("roblox"),
        "purchases": user.get("purchases", [])
    }


def load_keys():
    if os.path.exists(KEYS_FILE):
        try:
            with open(KEYS_FILE, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def load_donations():
    if os.path.exists(DONATIONS_FILE):
        try:
            with open(DONATIONS_FILE, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception:
            pass
    return []


def save_donations(donations):
    try:
        with open(DONATIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(donations, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def save_keys(keys):
    try:
        with open(KEYS_FILE, "w", encoding="utf-8") as f:
            json.dump(keys, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def ensure_demo_key():
    keys = load_keys()
    if "SH-DEMO-AAAA-BBBB" in keys:
        return
    keys["SH-DEMO-AAAA-BBBB"] = {
        "script": "infinity-hub",
        "created": datetime.now().isoformat(),
        "expires": (datetime.now() + timedelta(days=365)).isoformat()
    }
    save_keys(keys)


def load_scripts():
    scripts = {}
    if not os.path.isdir(SCRIPTS_DIR):
        return scripts
    for name in os.listdir(SCRIPTS_DIR):
        if name.endswith(".lua"):
            scripts[name[:-4]] = name
    return scripts


# ---------------------------------------------------------------------------
# GUvenlik yardimcilari
# ---------------------------------------------------------------------------

def origin_allowed(origin):
    """Origin (orn. https://site.com) allow-list okurlugu."""
    if not origin:
        return False
    o = origin.rstrip("/")
    return o in ALLOWED_ORIGINS


def is_loopback_ip(ip):
    if not ip:
        return False
    if ip in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        if socket.inet_aton(ip):
            return ip.startswith("127.")
    except Exception:
        pass
    return False


def is_demo_key(key):
    return key == "SH-DEMO-AAAA-BBBB"


def demo_key_allowed(ip):
    # Demo anahtari yalnizca yonetimce gorunur sekilde dahili/kapali kullanim icin.
    return is_loopback_ip(ip) or ALLOW_DEMO_KEY_REMOTE or os.environ.get("CAPY_ENV", "") == "dev"


def valid_key_format(key):
    return bool(re.fullmatch(r"[A-Z0-9][A-Z0-9-]{3,39}", key or ""))


def valid_script_id(sid):
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", sid or ""))


def strip_to_ascii_safe(text, limit):
    try:
        return str(text or "").strip()[:limit]
    except Exception:
        return ""


def mask_key(key):
    """Log'lara tam anahtar yazma â€” ilk 8 karakter disinda sakla."""
    k = str(key)
    return k if len(k) <= 8 else k[:8] + "-â€¦"


def verify_webhook_signature(body_bytes, signature, secret=None):
    """
    Webhook imza dogrulama: HMAC-SHA256(secret, raw_body), hex base64.
    Guvenli karsilastirma kullanir; secret boÅŸsa imza dogrulamaz (403).
    """
    secret = secret if secret is not None else WEBHOOK_SECRET
    if not secret or not signature:
        return False
    try:
        expected = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, str(signature).strip().lower())
    except Exception:
        return False


def promote_legacy_admin():
    """Eski acil-durum 'capy' kullanici adi backdoor yerine rol tabanli yetki:
    hicbir admin yoksa mevcut 'capy' hesabi otomatik admin yapilir (bootstrap)."""
    try:
        users = load_users()
        admins = [u for u in users.values() if u.get("role") == "admin"]
        if admins:
            return
        capy = users.get("capy")
        if capy:
            capy["role"] = "admin"
            save_users(users)
    except Exception:
        pass


def admin_bootstrap():
    """CAPY_ADMIN_PASSWORD ortam degiskeniyle ilk admin hesabini olusturur.
    Ayni anda admin varsa veya 'admin' kullanmasi alinmissa dokunmaz."""
    pw = os.environ.get("CAPY_ADMIN_PASSWORD", "")
    if not pw or len(pw) < 8:
        return
    try:
        users = load_users()
        if any(u.get("role") == "admin" for u in users.values()):
            return
        if "admin" in users:
            return
        salt_hex, hash_hex = hash_password(pw)
        users["admin"] = {
            "username": "admin",
            "salt": salt_hex,
            "hash": hash_hex,
            "role": "admin",
            "created": datetime.now().isoformat(),
            "roblox": None,
            "purchases": []
        }
        save_users(users)
        print("[capy] Bootstrap: 'admin' hesabi olusturuldu (CAPY_ADMIN_PASSWORD).")
    except Exception:
        pass


def add_security_headers(handler):
    origin = handler.headers.get("Origin", "")
    if origin and origin_allowed(origin):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Access-Control-Max-Age", "600")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Frame-Options", "SAMEORIGIN")
    handler.send_header("X-XSS-Protection", "1; mode=block")
    handler.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
    handler.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    handler.send_header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    )
    scheme = handler.headers.get("X-Forwarded-Proto", "").strip().lower()
    if scheme == "https":
        handler.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")


def need_https_redirect(handler):
    """Proxy arkasindayken (PA, ngrok vb.) HTTPâ†’HTTPS zorlamasi."""
    scheme = handler.headers.get("X-Forwarded-Proto", "").strip().lower()
    return scheme == "http"


def send_https_redirect(handler):
    host = handler.headers.get("Host", "")
    location = "https://" + host + (handler.path or "/")
    handler.send_response(301)
    handler.send_header("Location", location)
    handler.send_header("Content-Length", "0")
    add_security_headers(handler)
    handler.end_headers()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        """Tek noktadan guvenlik/CORS basliklarini tum yanitlara ekle."""
        try:
            names = set()
            for line in self._headers_buffer:
                if b":" in line:
                    names.add(line.split(b":", 1)[0].decode("latin-1").strip().lower())
            origin = self.headers.get("Origin", "")
            if origin and origin_allowed(origin) and "access-control-allow-origin" not in names:
                self._headers_buffer.append(b"Access-Control-Allow-Origin: " + origin.encode("latin-1", "replace") + b"\r\n")
                self._headers_buffer.append(b"Vary: Origin\r\n")
            for name, value in [
                ("X-Content-Type-Options", "nosniff"),
                ("X-Frame-Options", "SAMEORIGIN"),
                ("X-XSS-Protection", "1; mode=block"),
                ("Referrer-Policy", "strict-origin-when-cross-origin"),
                ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"),
                ("Content-Security-Policy",
                 "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                 "img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; "
                 "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
            ]:
                if name.lower() not in names:
                    self._headers_buffer.append(name.encode("latin-1") + b": " + value.encode("latin-1") + b"\r\n")
            if self.headers.get("X-Forwarded-Proto", "").strip().lower() == "https":
                self._headers_buffer.append(b"Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n")
        except Exception:
            pass
        super().end_headers()

    def handle_chat(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
            token = (params.get("token") or [""])[0].strip()
            message = (params.get("message") or [""])[0].strip()
        except Exception:
            self.send_json({"valid": False, "reason": "bad_request"}, 400)
            return

        if not message:
            self.send_json({"valid": False, "reason": "empty_message"}, 400)
            return

        if len(message) > 2000:
            self.send_json({"valid": False, "reason": "message_too_long"}, 400)
            return

        if not check_rate_limit(self.client_ip(), "/api/chat", max_requests=5, window=60):
            self.send_json({"valid": False, "reason": "rate_limited"}, 429)
            return

        users = load_users()
        username = user_for_token(token)
        user = users.get(username) if username else None
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return

        ollama_host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
        model = os.environ.get("OLLAMA_MODEL", "llama3.2")
        try:
            payload = json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are the SukunaScripts assistant. Answer briefly and helpfully."},
                    {"role": "user", "content": message}
                ],
                "stream": False
            }).encode()
            req = urllib.request.Request(
                ollama_host.rstrip("/") + "/api/chat",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())
            response = (data.get("message") or {}).get("content") or "No response from model."
        except Exception:
            log_event("chat_error", username, "ollama_request_failed", self.client_ip())
            self.send_json({
                "valid": False,
                "reason": "ollama_unavailable",
                "hint": "Install Ollama, run 'ollama serve', then 'ollama pull " + model + "'"
            }, 503)
            return

        log_event("chat", username, message[:50], self.client_ip())
        self.send_json({"valid": True, "response": response, "model": model})

    def do_OPTIONS(self):
        self.send_response(204)
        add_security_headers(self)
        self.end_headers()

    def do_GET(self):
        t0 = time.time()
        ip = self.client_ip()
        status = 200
        try:
            if need_https_redirect(self):
                send_https_redirect(self)
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            # Hassas dosyalara statik erisimi engelle (kod, veri, gizli dosyalar, yedekler).
            if is_sensitive_path(path):
                self.send_json({"valid": False, "reason": "not_found"}, 404)
                return

            if path == "/verify":
                self.handle_verify(parsed)
                return

            if path == "/api/download":
                self.handle_download(parsed)
                return

            if path == "/api/me":
                self.handle_me(parsed)
                return

            if path == "/api/breach-state":
                self.handle_breach_state()
                return

            if path == "/api/test-data":
                self.handle_test_data(parsed)
                return

            if path == "/api/logs":
                self.handle_logs(parsed)
                return

            if path == "/api/creds":
                self.handle_creds(parsed)
                return

            if path == "/api/sessions":
                self.handle_sessions(parsed)
                return

            if path == "/api/message-state":
                self.handle_message_state()
                return

            if path == "/api/maintenance-state":
                self.handle_maintenance_state()
                return

            if path == "/api/donations":
                self.handle_donations(parsed)
                return

            if path == "/api/server-stats":
                self.handle_server_stats(parsed)
                return

            if path == "/api/audit":
                self.handle_audit(parsed)
                return

            if path == "/api/threat-scan":
                self.handle_threat_scan(parsed)
                return

            if path == "/api/stats":
                self.handle_stats()
                return

            if path == "/api/profile":
                self.handle_profile(parsed)
                return

            if path == "/health":
                self.send_json({
                    "status": "ok",
                    "time": datetime.now().isoformat(),
                    "users": len(load_users()),
                    "keys": len(load_keys()),
                    "breach": BREACH["active"]
                })
                return

            if path == "/api/chat":
                self.handle_chat(parsed)
                return

            if path == "/" or path == "/index.html":
                self.path = "/index.html"
            super().do_GET()
        except Exception as e:
            status = 500
            traceback.print_exc()
            try:
                self.send_json({"valid": False, "reason": "internal_error"}, 500)
            except Exception:
                pass
        finally:
            global REQUEST_COUNT
            with REQUEST_LOCK:
                REQUEST_COUNT += 1
            dt = (time.time() - t0) * 1000
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {ip} - GET {self.path} - {status} ({dt:.2f}ms)")

    def handle_verify(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        key = (params.get("key") or [""])[0].strip().upper()
        keys = load_keys()

        if is_demo_key(key) and not demo_key_allowed(self.client_ip()):
            self.send_json({"valid": False, "reason": "demo_key_disabled"}, 403)
            return

        if not valid_key_format(key):
            self.send_json({"valid": False, "reason": "invalid_key"}, 400)
            return

        entry = keys.get(key)
        if not entry:
            self.send_json({"valid": False, "reason": "key_not_found"})
            return

        expires = entry.get("expires")
        if expires and datetime.fromisoformat(expires) < datetime.now():
            self.send_json({"valid": False, "reason": "expired"})
            return

        self.send_json({
            "valid": True,
            "script": entry.get("script"),
            "expires": expires
        })

    def handle_me(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        self.send_json({"valid": True, "user": public_user(user)})

    def client_ip(self):
        """X-Forwarded-For varsa ilk (en uzak) girdi; yoksa soket icinden program gelen IP.
        Ngrok / PA gibi proxy arkasinda gercek uzak IP'yi verir."""
        try:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                for part in xff.split(","):
                    part = part.strip()
                    if part:
                        return part
        except Exception:
            pass
        return self.client_address[0] or "0.0.0.0"

    def do_POST(self):
        t0 = time.time()
        ip = self.client_ip()
        status = 200
        try:
            if need_https_redirect(self):
                send_https_redirect(self)
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            # Yukleme siniri: 1MB ustu istekleri daha hiz limitine girmeden reddet.
            try:
                clen = int(self.headers.get("Content-Length", 0))
            except Exception:
                clen = 0
            if clen > 1024 * 1024:
                status = 413
                self.send_json({"valid": False, "reason": "payload_too_large"}, 413)
                return

            if path in ("/api/login", "/api/signup"):
                if not check_rate_limit(ip, path, max_requests=10, window=30):
                    status = 429
                    self.send_json({"valid": False, "reason": "rate_limited"}, 429)
                    return
            elif path in ("/api/purchase", "/api/give-robux"):
                if not check_rate_limit(ip, path, max_requests=15, window=30):
                    status = 429
                    self.send_json({"valid": False, "reason": "rate_limited"}, 429)
                    return
            elif path in ("/api/change-password", "/api/link-roblox", "/api/quick-login", "/api/donate", "/api/delete-account", "/api/webhook"):
                if not check_rate_limit(ip, path, max_requests=8, window=30):
                    status = 429
                    self.send_json({"valid": False, "reason": "rate_limited"}, 429)
                    return

            if path == "/api/signup":
                self.handle_signup()
                return

            if path == "/api/login":
                self.handle_login()
                return

            if path == "/api/change-password":
                self.handle_change_password()
                return

            if path == "/api/logout":
                self.handle_logout()
                return

            if path == "/api/link-roblox":
                self.handle_link_roblox()
                return

            if path == "/api/robux-deposit":
                self.handle_robux_deposit()
                return

            if path == "/api/give-robux":
                self.handle_give_robux()
                return

            if path == "/api/ban":
                self.handle_ban()
                return

            if path == "/api/unban":
                self.handle_unban()
                return

            if path == "/api/wallet":
                self.handle_wallet()
                return

            if path == "/api/lookup":
                self.handle_lookup()
                return

            if path == "/api/announce":
                self.handle_announce()
                return

            if path == "/api/purchase":
                self.handle_purchase()
                return

            if path == "/api/breach":
                self.handle_breach()
                return

            if path == "/api/maintenance":
                self.handle_maintenance()
                return

            if path == "/api/quick-login":
                self.handle_quick_login()
                return

            if path == "/api/donate":
                self.handle_donate()
                return

            if path == "/api/delete-account":
                self.handle_delete_account()
                return

            if path == "/api/webhook":
                self.handle_webhook()
                return

            status = 404
            self.send_json({"valid": False, "reason": "not_found"}, 404)
        except Exception as e:
            status = 500
            traceback.print_exc()
            try:
                self.send_json({"valid": False, "reason": "internal_error"}, 500)
            except Exception:
                pass
        finally:
            global REQUEST_COUNT
            with REQUEST_LOCK:
                REQUEST_COUNT += 1
            dt = (time.time() - t0) * 1000
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {ip} - POST {self.path} - {status} ({dt:.2f}ms)")

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 1024 * 1024:
            raise ValueError("Payload too large")
        self._raw_body = b""
        if length <= 0:
            return {}
        try:
            self._raw_body = self.rfile.read(length)
        except Exception:
            self._raw_body = b""
            raise
        return json.loads(self._raw_body.decode("utf-8"))

    def validate_body(self, required_fields=None, field_types=None):
        try:
            body = self.read_body()
        except Exception:
            self.send_json({"valid": False, "reason": "bad_request"}, 400)
            return None

        if not isinstance(body, dict):
            self.send_json({"valid": False, "reason": "bad_request"}, 400)
            return None

        if required_fields:
            for field in required_fields:
                if field not in body:
                    self.send_json({"valid": False, "reason": f"missing_{field}"}, 400)
                    return None

        if field_types:
            for field, expected_type in field_types.items():
                if field in body and body[field] is not None:
                    if not isinstance(body[field], expected_type):
                        self.send_json({"valid": False, "reason": f"invalid_type_{field}"}, 400)
                        return None
        return body

    def handle_signup(self):
        body = self.validate_body(["username", "password"], {"username": str, "password": str})
        if not body:
            return

        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))

        if not re.match(r"^[a-zA-Z0-9_]{3,20}$", username):
            self.send_json({"valid": False, "reason": "invalid_username"})
            return
        if len(password) < 6:
            self.send_json({"valid": False, "reason": "weak_password"})
            return

        users = load_users()
        if username.lower() in users:
            self.send_json({"valid": False, "reason": "username_taken"})
            return

        salt_hex, hash_hex = hash_password(password)
        users[username.lower()] = {
            "username": username,
            "salt": salt_hex,
            "hash": hash_hex,
            "role": "user",
            "created": datetime.now().isoformat(),
            "roblox": None,
            "purchases": []
        }
        save_users(users)

        token = secrets.token_urlsafe(32)
        TOKENS[token] = username.lower()
        log_event("signup", username.lower(), "account created", self.client_address[0])
        self.send_json({"valid": True, "token": token, "user": public_user(users[username.lower()])})

    def handle_login(self):
        body = self.validate_body(["username", "password"], {"username": str, "password": str})
        if not body:
            return

        username = str(body.get("username", "")).strip().lower()
        password = str(body.get("password", ""))
        users = load_users()
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "bad_credentials"})
            return

        if not verify_password(password, user.get("salt", ""), user.get("hash", "")):
            log_event("login_failed", username, "wrong password", self.client_address[0])
            self.send_json({"valid": False, "reason": "bad_credentials"})
            return

        if user.get("banned"):
            log_event("login_failed", username, "banned account", self.client_address[0])
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return

        token = secrets.token_urlsafe(32)
        TOKENS[token] = username
        log_event("login", username, "", self.client_address[0])
        self.send_json({"valid": True, "token": token, "user": public_user(user)})

    def handle_change_password(self):
        body = self.validate_body(["token", "current", "new"], {"token": str, "current": str, "new": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        current = str(body.get("current", ""))
        new = str(body.get("new", ""))

        username = user_for_token(token)
        users = load_users()
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return

        if not verify_password(current, user.get("salt", ""), user.get("hash", "")):
            log_event("password_change_failed", username, "wrong current password", self.client_address[0])
            self.send_json({"valid": False, "reason": "bad_current"})
            return

        if len(new) < 6:
            self.send_json({"valid": False, "reason": "weak_password"})
            return

        salt_hex, hash_hex = hash_password(new)
        user["salt"] = salt_hex
        user["hash"] = hash_hex
        if "plain" in user:
            del user["plain"]
        user["password_changed"] = datetime.now().isoformat()
        save_users(users)
        log_event("password_change", username, "password updated", self.client_address[0])
        self.send_json({"valid": True, "user": public_user(user)})

    def handle_quick_login(self):
        body = self.validate_body(["token", "username"], {"token": str, "username": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        users = load_users()
        actor = user_for_token(token)
        actor_user = users.get(actor)
        if not actor_user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if actor_user.get("role", "user") not in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "not_tester"}, 403)
            return
        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        if target_user.get("banned"):
            self.send_json({"valid": False, "reason": "banned"})
            return

        new_token = secrets.token_urlsafe(32)
        TOKENS[new_token] = target_user["username"]
        log_event("impersonate", target_user["username"], "by " + actor, self.client_address[0])
        self.send_json({"valid": True, "token": new_token, "user": public_user(target_user)})

    def handle_logout(self):
        body = self.validate_body(["token"], {"token": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        username = user_for_token(token)
        if username:
            TOKENS.pop(token, None)
            log_event("logout", username, "", self.client_address[0])
        self.send_json({"valid": True})

    def handle_logs(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("role", "user") != "admin":
            self.send_json({"valid": False, "reason": "not_admin"}, 403)
            return

        entries = list(reversed(LOGS))
        self.send_json({"valid": True, "logs": entries, "count": len(entries)})

    def handle_link_roblox(self):
        body = self.validate_body(["token", "robloxUsername"], {"token": str, "robloxUsername": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        rusername = str(body.get("robloxUsername", "")).strip()

        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("banned"):
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return
        if not re.match(r"^[a-zA-Z0-9_ ]{3,20}$", rusername):
            self.send_json({"valid": False, "reason": "invalid_roblox_username"})
            return

        resolved = verify_roblox_username(rusername)
        if not resolved:
            self.send_json({"valid": False, "reason": "roblox_user_not_found"})
            return

        user["roblox"] = {"name": resolved["name"], "id": resolved["id"], "verified": resolved.get("verified", False), "robux": 0}
        save_users(users)
        log_event("link_roblox", username, resolved["name"], self.client_address[0])
        self.send_json({"valid": True, "user": public_user(user)})

    def handle_breach_state(self):
        self.send_json({"valid": True, "active": BREACH["active"], "by": BREACH["by"], "at": BREACH["at"]})

    def _load_admin(self, token):
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return None, None, None
        if user.get("role", "user") != "admin":
            self.send_json({"valid": False, "reason": "not_admin"}, 403)
            return None, None, None
        return users, username, user

    def handle_ban(self):
        body = self.validate_body(["token", "username"], {"token": str, "username": str})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        reason = str(body.get("reason", "")).strip()[:200]
        users, caller_name, _ = self._load_admin(token)
        if not users:
            return
        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        target_user["banned"] = {"reason": reason or "no reason", "at": datetime.now().isoformat()}
        save_users(users)
        log_event("ban", caller_name, "%s :: %s" % (target_user["username"], reason or "no reason"), self.client_address[0])
        self.send_json({"valid": True, "user": public_user(target_user)})

    def handle_unban(self):
        body = self.validate_body(["token", "username"], {"token": str, "username": str})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        users, caller_name, _ = self._load_admin(token)
        if not users:
            return
        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        target_user.pop("banned", None)
        save_users(users)
        log_event("unban", caller_name, target_user["username"], self.client_address[0])
        self.send_json({"valid": True, "user": public_user(target_user)})

    def handle_wallet(self):
        body = self.validate_body(["token", "username", "amount"], {"token": str, "username": str, "amount": int})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        amount = int(body.get("amount", 0))
        users, caller_name, _ = self._load_admin(token)
        if not users:
            return
        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        if amount == 0 or abs(amount) > 100000000:
            self.send_json({"valid": False, "reason": "bad_amount"})
            return
        target_user["wallet"] = target_user.get("wallet", 0) + amount
        save_users(users)
        log_event("wallet", caller_name, "%s %+d RB$" % (target_user["username"], amount), self.client_address[0])
        self.send_json({"valid": True, "user": public_user(target_user), "wallet": target_user["wallet"]})

    def handle_lookup(self):
        body = self.validate_body(["token", "username"], {"token": str, "username": str})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        users, _, _ = self._load_admin(token)
        if not users:
            return
        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        roblox = target_user.get("roblox")
        self.send_json({
            "valid": True,
            "user": {
                "username": target_user["username"],
                "role": target_user.get("role", "user"),
                "wallet": target_user.get("wallet", 0),
                "banned": bool(target_user.get("banned")),
                "banReason": (target_user.get("banned") or {}).get("reason"),
                "roblox": {
                    "name": roblox.get("name") if roblox else None,
                    "verified": bool(roblox.get("verified")) if roblox else False,
                    "infinite": bool(roblox.get("infinite")) if roblox else False,
                    "robux": roblox.get("robux", 0) if roblox else 0
                } if roblox else None,
                "purchases": len(target_user.get("purchases", []))
            }
        })

    def handle_sessions(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users, _, _ = self._load_admin(token)
        if not users:
            return
        seen = {}
        for uname in TOKENS.values():
            u = users.get(uname)
            seen.setdefault(uname, {"username": u.get("username", uname) if u else uname, "role": (u or {}).get("role", "?"), "count": 0})
            seen[uname]["count"] += 1
        sessions = list(seen.values())
        self.send_json({"valid": True, "sessions": sessions, "count": len(sessions)})

    def handle_message_state(self):
        self.send_json({"valid": True, "text": MESSAGE["text"], "by": MESSAGE["by"], "at": MESSAGE["at"]})

    def handle_maintenance_state(self):
        self.send_json({"valid": True, "active": MAINTENANCE["active"], "by": MAINTENANCE["by"], "at": MAINTENANCE["at"]})

    def handle_donations(self, parsed):
        users = load_users()
        hidden_roles = ("admin", "tester")
        visible = [d for d in load_donations() if users.get(d.get("user"), {}).get("role", "user") not in hidden_roles]
        totals = {}
        for d in visible:
            totals[d["user"]] = totals.get(d["user"], 0) + d["amount"]
        leaderboard = sorted(
            [{"user": u, "total": t, "count": sum(1 for x in visible if x["user"] == u)} for u, t in totals.items()],
            key=lambda x: -x["total"]
        )
        self.send_json({
            "valid": True,
            "total": sum(d["amount"] for d in visible),
            "count": len(visible),
            "donations": list(reversed(visible[-50:])),
            "leaderboard": leaderboard,
            "hidden": False
        })

    def handle_donate(self):
        body = self.validate_body(["token", "amount"], {"token": str, "amount": int})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        amount = int(body.get("amount", 0))
        note = str(body.get("note", "")).strip()[:160]
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("banned"):
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return
        if user.get("role", "user") in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "role_not_allowed"})
            return
        if not user.get("roblox"):
            self.send_json({"valid": False, "reason": "roblox_not_linked"})
            return
        if user.get("roblox", {}).get("infinite"):
            self.send_json({"valid": False, "reason": "infinite_balance"})
            return
        if amount <= 0 or amount > 10000000:
            self.send_json({"valid": False, "reason": "bad_amount"})
            return
        balance = user["roblox"].get("robux", 0)
        if amount > balance:
            self.send_json({"valid": False, "reason": "insufficient_robux"})
            return

        user["roblox"]["robux"] = balance - amount
        save_users(users)
        donations = load_donations()
        donations.append({
            "user": user["username"],
            "amount": amount,
            "note": note,
            "ts": datetime.now().isoformat(timespec="seconds")
        })
        save_donations(donations)
        log_event("donate", user["username"], "%s RBX%s" % (amount, " :: " + note if note else ""), self.client_address[0])
        if amount >= SPEND_ALERT_THRESHOLD:
            log_event("spending_alert", user["username"], "big donation %s RBX" % amount, self.client_address[0])
        total_all = sum(d["amount"] for d in donations)
        self.send_json({"valid": True, "user": public_user(user), "amount": amount, "total_all": total_all})

    def handle_delete_account(self):
        body = self.validate_body(["token", "password", "username"], {"token": str, "password": str, "username": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        password = str(body.get("password", ""))
        claim = str(body.get("username", "")).strip().lower()
        username = user_for_token(token)
        users = load_users()
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return

        # Kullaniciadi dogrulama: silmek istedigi hesap, token sahibi olmalÄ±.
        if claim != username or user.get("username", "").lower() != username:
            self.send_json({"valid": False, "reason": "username_mismatch"}, 403)
            return

        if not verify_password(password, user.get("salt", ""), user.get("hash", "")):
            log_event("delete_failed", username, "wrong password", self.client_address[0])
            self.send_json({"valid": False, "reason": "bad_credentials"}, 401)
            return

        # Son admin silinsin istesek bile korunur (yanlislikla kilitlenmemesi icin).
        if user.get("role", "user") == "admin":
            others_admin = any(
                uname != username and u.get("role") == "admin"
                for uname, u in users.items()
            )
            if not others_admin:
                self.send_json({"valid": False, "reason": "last_admin_protected"}, 403)
                return

        del users[username]
        save_users(users)
        for t in [t for t, u in list(TOKENS.items()) if u == username]:
            TOKENS.pop(t, None)
        log_event("account_deleted", username, "account permanently deleted", self.client_address[0])
        self.send_json({"valid": True})

    def handle_webhook(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except Exception:
            length = 0
        if length <= 0 or length > 1024 * 1024:
            self.send_json({"valid": False, "reason": "bad_request"}, 400)
            return

        signature = self.headers.get("X-Capy-Signature", "")
        try:
            raw = self.rfile.read(length)
        except Exception:
            raw = b""
        if not verify_webhook_signature(raw, signature):
            log_event("webhook_failed", "system", "invalid signature", self.client_address[0])
            self.send_json({"valid": False, "reason": "invalid_signature"}, 403)
            return

        try:
            payload = json.loads(raw.decode("utf-8"))
            event = str(payload.get("event", "ping"))[:80]
        except Exception:
            event = "malformed"
            self.send_json({"valid": False, "reason": "bad_request"}, 400)
            return

        # Yikici islem iceren komut YOK â€” yalnizca kayit + kontrol sinyalleri.
        log_event("webhook", "system", "event: " + event, self.client_address[0])
        if event == "ping":
            self.send_json({"valid": True, "pong": True, "ts": datetime.now().isoformat()})
        else:
            self.send_json({"valid": True, "received": event})

    def _memory_mb(self):
        try:
            import psutil
            return round(psutil.Process(os.getpid()).memory_info().rss / 1048576, 1)
        except Exception:
            pass
        try:
            import ctypes
            from ctypes import wintypes
            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)
                ]
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            c = PROCESS_MEMORY_COUNTERS()
            c.cb = ctypes.sizeof(c)
            if psapi.GetProcessMemoryInfo(
                k32.GetCurrentProcess(),
                ctypes.byref(c), ctypes.sizeof(c)
            ):
                return round(c.WorkingSetSize / 1048576, 1)
        except Exception:
            pass
        return None

    def handle_server_stats(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("role", "user") not in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "not_tester"}, 403)
            return

        uptime = int(time.time() - START_TIME)
        with REQUEST_LOCK:
            reqs = REQUEST_COUNT
        rich = []
        for uname, u in users.items():
            rb = (u.get("roblox") or {}).get("robux", 0)
            if (u.get("roblox") or {}).get("infinite"):
                rb = float("inf")
            rich.append((uname, rb, bool((u.get("roblox") or {}).get("infinite"))))
        rich.sort(key=lambda kv: (kv[1] == float("inf"), -(kv[1] if kv[1] != float("inf") else 10**12)))
        self.send_json({
            "valid": True,
            "server": {
                "hostname": socket.gethostname(),
                "python": "python " + __import__("sys").version.split()[0],
                "platform": __import__("platform").platform(),
                "pid": os.getpid(),
                "memory_mb": self._memory_mb(),
                "uptime_sec": uptime,
                "started_at": datetime.fromtimestamp(START_TIME).isoformat(),
                "now": datetime.now().isoformat()
            },
            "requests": reqs,
            "sessions": len(TOKENS),
            "counts": {
                "users": len(users),
                "keys": len(load_keys()),
                "scripts": len(load_scripts())
            },
            "breach": {"active": BREACH["active"], "by": BREACH["by"]},
            "maintenance": {"active": MAINTENANCE["active"], "by": MAINTENANCE["by"]},
            "message": {"active": bool(MESSAGE["text"])},
            "richList": [
                {"username": t, "robux": (None if inf else r), "infinite": inf}
                for t, r, inf in rich[:5]
            ]
        })

    def handle_audit(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        target = (params.get("user") or [""])[0].strip().lower()
        users, _, _ = self._load_admin(token)
        if not users:
            return
        entries = list(reversed(LOGS))
        if target:
            entries = [e for e in entries if e.get("user", "").lower() == target]
        self.send_json({"valid": True, "logs": entries[:80], "count": len(entries), "user": target or None})

    def handle_threat_scan(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("role", "user") not in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "not_tester"}, 403)
            return
        users_now = users

        findings = []
        by_user = {}
        by_ip = {}
        for e in LOGS:
            u = e.get("user", "")
            ip = e.get("ip", "")
            if e.get("event") == "login_failed":
                by_user.setdefault(u, 0)
                by_user[u] += 1
                if ip:
                    by_ip.setdefault(ip, {"fails": 0, "events": []})
                    by_ip[ip]["fails"] += 1
            if ip:
                by_ip.setdefault(ip, {"fails": 0, "events": []})
        for u, n in by_user.items():
            if n >= 5:
                findings.append({"severity": "high", "type": "brute_force", "subject": u or "(anon)", "detail": "%d failed logins" % n})
        for ip, info in by_ip.items():
            if info["fails"] >= 10:
                findings.append({"severity": "high", "type": "ip_abuse", "subject": ip, "detail": "%d failed logins / %d events" % (info["fails"], len(info["events"]))})

        recent = list(reversed(LOGS[-200:]))
        unames = {e.get("user", "") for e in recent if e.get("event") == "signup"}
        abuse = 0
        for uname in unames:
            if sum(1 for e in recent if e.get("user") == uname and e.get("event") == "signup") >= 3:
                findings.append({"severity": "medium", "type": "signup_spam", "subject": uname, "detail": "multiple signups"})
                abuse += 1

        banned = sum(1 for u in users_now.values() if u.get("banned"))
        self.send_json({
            "valid": True,
            "scanned": len(LOGS),
            "findings": findings,
            "summary": {
                "failed_logins": sum(by_user.values()),
                "login_failed_users": len(by_user),
                "active_flags": [
                    "BREACH" if BREACH["active"] else None,
                    "MAINTENANCE" if MAINTENANCE["active"] else None
                ],
                "banned_users": banned
            },
            "safe": not findings
        })

    def handle_maintenance(self):
        body = self.validate_body(["token", "action"], {"token": str, "action": str})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        action = str(body.get("action", "")).strip()
        users, username, _ = self._load_admin(token)
        if not users:
            return
        if action == "on":
            MAINTENANCE["active"] = True
        elif action == "off":
            MAINTENANCE["active"] = False
        else:
            self.send_json({"valid": False, "reason": "bad_action"})
            return
        MAINTENANCE["by"] = username
        MAINTENANCE["at"] = datetime.now().isoformat()
        log_event("maintenance", username, "on" if MAINTENANCE["active"] else "off", self.client_address[0])
        self.send_json({"valid": True, "active": MAINTENANCE["active"], "by": MAINTENANCE["by"]})

    def handle_announce(self):
        body = self.validate_body(["token", "text"], {"token": str, "text": str})
        if not body:
            return
        token = str(body.get("token", "")).strip()
        text = str(body.get("text", "")).strip()
        users, caller_name, _ = self._load_admin(token)
        if not users:
            return
        if not text or text.lower() == "clear":
            MESSAGE.update({"text": "", "by": None, "at": None})
            log_event("announce", caller_name, "cleared", self.client_address[0])
            self.send_json({"valid": True, "active": False})
            return
        if len(text) > 220:
            self.send_json({"valid": False, "reason": "too_long"})
            return
        MESSAGE.update({"text": text, "by": caller_name, "at": datetime.now().isoformat()})
        log_event("announce", caller_name, text, self.client_address[0])
        self.send_json({"valid": True, "active": True, "text": text})

    def handle_stats(self):
        users = load_users()
        keys = load_keys()
        purchases = 0
        revenue = 0
        by_script = {}
        by_user = {}
        for uname, u in users.items():
            plist = u.get("purchases", [])
            by_user[uname] = len(plist)
            for p in plist:
                purchases += 1
                revenue += p.get("price", 0)
                sid = p.get("script", "?")
                by_script.setdefault(sid, 0)
                by_script[sid] += 1
        top = sorted(by_user.items(), key=lambda kv: -kv[1])[:5]
        self.send_json({
            "valid": True,
            "counts": {
                "users": len(users),
                "keys": len(keys),
                "scripts": len(load_scripts()),
                "purchases": purchases,
                "revenue": revenue
            },
            "byScript": [{"script": k, "count": v} for k, v in sorted(by_script.items(), key=lambda kv: -kv[1])],
            "topUsers": [{"username": u, "purchases": n} for u, n in top],
            "breach": {"active": BREACH["active"], "by": BREACH["by"]},
            "message": {"active": bool(MESSAGE["text"]), "text": MESSAGE["text"]},
            "recent": list(reversed(LOGS[-8:]))
        })

    def handle_profile(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        info = public_user(user)
        info["wallet"] = user.get("wallet", 0)
        info["banned"] = bool(user.get("banned"))
        info["created"] = user.get("created", "")
        self.send_json({"valid": True, "user": info})

    def handle_creds(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("role", "user") != "admin":
            self.send_json({"valid": False, "reason": "not_admin"}, 403)
            return

        creds = [
            {
                "username": u.get("username", uname),
                "role": u.get("role", "user"),
                "has_hash": bool(u.get("hash")),
                "created": u.get("created", "")
            }
            for uname, u in users.items()
        ]
        log_event("creds_view", username, "listed %d accounts" % len(creds), self.client_address[0])
        self.send_json({"valid": True, "accounts": sorted(creds, key=lambda c: c["username"].lower())})

    def handle_test_data(self, parsed):
        try:
            params = urllib.parse.parse_qs(parsed.query)
        except Exception:
            params = {}
        token = (params.get("token") or [""])[0].strip()
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        role = user.get("role", "user")
        if role not in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "not_tester"}, 403)
            return

        keys = load_keys()
        people = []
        for uname, u in users.items():
            roblox = u.get("roblox")
            people.append({
                "username": u.get("username", uname),
                "role": u.get("role", "user"),
                "robux": (roblox or {}).get("robux", 0),
                "infinite": bool((roblox or {}).get("infinite", False)),
                "purchases": len(u.get("purchases", []))
            })

        sales = 0
        for u in users.values():
            for pu in u.get("purchases", []):
                sales += pu.get("price", 0)

        key_list = None
        if role == "admin":
            key_list = [
                {"key": k, "script": v.get("script"), "expires": v.get("expires")}
                for k, v in sorted(keys.items())
            ]

        self.send_json({
            "valid": True,
            "counts": {
                "users": len(users),
                "keys": len(keys),
                "scripts": len(load_scripts()),
                "sales_value": sales
            },
            "breach": {"active": BREACH["active"], "by": BREACH["by"], "at": BREACH["at"]},
            "users": people,
            "keys": key_list
        })

    def handle_breach(self):
        body = self.validate_body(["token", "action"], {"token": str, "action": str})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        action = str(body.get("action", "")).strip()
        username = user_for_token(token)
        users = load_users()
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("role", "user") != "admin":
            self.send_json({"valid": False, "reason": "not_admin"}, 403)
            return
        if action == "on":
            BREACH["active"] = True
        elif action == "off":
            BREACH["active"] = False
        else:
            self.send_json({"valid": False, "reason": "bad_action"})
            return
        BREACH["by"] = username
        BREACH["at"] = datetime.now().isoformat()
        log_event("breach", username, "active" if BREACH["active"] else "restored", self.client_address[0])
        self.send_json({"valid": True, "active": BREACH["active"], "by": BREACH["by"]})

    def handle_robux_deposit(self):
        body = self.validate_body(["token", "amount"], {"token": str, "amount": int})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        amount = int(body.get("amount", 0))
        users = load_users()
        username = user_for_token(token)
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if user.get("banned"):
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return
        if not user.get("roblox"):
            self.send_json({"valid": False, "reason": "roblox_not_linked"})
            return
        if amount <= 0 or amount > 100000:
            self.send_json({"valid": False, "reason": "bad_amount"})
            return

        user["roblox"]["robux"] = user["roblox"].get("robux", 0) + amount
        save_users(users)
        if amount >= SPEND_ALERT_THRESHOLD:
            log_event("spending_alert", user["username"], "robux deposit %s RBX" % amount, self.client_address[0])
        self.send_json({"valid": True, "user": public_user(user)})

    def handle_give_robux(self):
        body = self.validate_body(["token", "username", "amount"], {"token": str, "username": str, "amount": int})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        target = str(body.get("username", "")).strip().lower()
        amount = int(body.get("amount", 0))
        users = load_users()
        username = user_for_token(token)
        caller = users.get(username)
        if not caller:
            self.send_json({"valid": False, "reason": "invalid_token"}, 401)
            return
        if caller.get("role", "user") not in ("admin", "tester"):
            self.send_json({"valid": False, "reason": "not_tester"}, 403)
            return
        if caller.get("banned"):
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return

        target_user = users.get(target)
        if not target_user:
            self.send_json({"valid": False, "reason": "target_not_found"}, 404)
            return
        if not target_user.get("roblox"):
            self.send_json({"valid": False, "reason": "target_roblox_not_linked"})
            return
        if amount <= 0 or amount > 10000000:
            self.send_json({"valid": False, "reason": "bad_amount"})
            return

        target_user["roblox"]["robux"] = target_user["roblox"].get("robux", 0) + amount
        save_users(users)
        log_event("give_robux", caller["username"], "â†’ %s +%s RBX" % (target_user["username"], amount), self.client_address[0])
        if amount >= SPEND_ALERT_THRESHOLD:
            log_event("spending_alert", target_user["username"], "received %s RBX from %s" % (amount, caller["username"]), self.client_address[0])
        self.send_json({"valid": True, "user": public_user(target_user), "amount": amount})

    def handle_purchase(self):
        body = self.validate_body(["token", "items"], {"token": str, "items": list})
        if not body:
            return

        token = str(body.get("token", "")).strip()
        method = str(body.get("method", "kart"))
        items = body.get("items", [])
        scripts = load_scripts()

        username = user_for_token(token)
        users = load_users()
        user = users.get(username)
        if not user:
            self.send_json({"valid": False, "reason": "login_required"}, 401)
            return
        if user.get("banned"):
            self.send_json({"valid": False, "reason": "banned"}, 403)
            return

        if not isinstance(items, list) or not items:
            self.send_json({"valid": False, "reason": "empty_cart"}, 400)
            return

        total = 0
        for it in items:
            sid = str(it.get("script", "")).strip() if isinstance(it, dict) else str(it)
            if sid not in scripts:
                self.send_json({"valid": False, "reason": "script_not_found", "script": sid}, 404)
                return
            total += SCRIPS_PRICE.get(sid, 0)

        if method == "roblox":
            roblox = user.get("roblox")
            if not roblox:
                self.send_json({"valid": False, "reason": "roblox_not_linked"})
                return
            if not roblox.get("infinite"):
                if roblox.get("robux", 0) < total:
                    self.send_json({"valid": False, "reason": "insufficient_robux"})
                    return
                roblox["robux"] = roblox.get("robux", 0) - total

        keys = load_keys()
        results = []
        purchased = user.setdefault("purchases", [])
        for it in items:
            sid = str(it.get("script", "")).strip() if isinstance(it, dict) else str(it)
            key = new_key()
            keys[key] = {
                "script": sid,
                "created": datetime.now().isoformat(),
                "expires": (datetime.now() + timedelta(days=365)).isoformat()
            }
            purchased.append({
                "script": sid,
                "key": key,
                "date": datetime.now().isoformat(),
                "price": SCRIPS_PRICE.get(sid, 0)
            })
            results.append({"script": sid, "key": key})

        save_keys(keys)
        save_users(users)
        log_event("purchase", username, ", ".join("%s(%s)" % (r["script"], mask_key(r["key"])) for r in results), self.client_address[0])
        if total >= SPEND_ALERT_THRESHOLD:
            log_event("spending_alert", username, "basket %s RBX (%d script)" % (total, len(results)), self.client_address[0])
        self.send_json({"valid": True, "keys": results, "user": public_user(user)})

    def handle_download(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        key = (params.get("key") or [""])[0].strip().upper()
        sid = (params.get("script") or [""])[0].strip()

        if is_demo_key(key) and not demo_key_allowed(self.client_ip()):
            self.send_json({"valid": False, "reason": "demo_key_disabled"}, 403)
            return

        if not valid_key_format(key) or not valid_script_id(sid):
            self.send_json({"valid": False, "reason": "invalid_key_or_script"}, 403)
            return

        keys = load_keys()
        entry = keys.get(key)
        if not entry or entry.get("script") != sid:
            self.send_json({"valid": False, "reason": "invalid_key_or_script"}, 403)
            return

        expires = entry.get("expires")
        if expires and datetime.fromisoformat(expires) < datetime.now():
            self.send_json({"valid": False, "reason": "expired"}, 403)
            return

        filename = os.path.join(SCRIPTS_DIR, sid + ".lua")
        if not os.path.isfile(filename):
            self.send_json({"valid": False, "reason": "script_file_missing"}, 404)
            return

        with open(filename, "r", encoding="utf-8-sig") as f:
            content = f.read()

        host_header = self.headers.get("Host", "").strip()
        if not host_header:
            host_header = (local_ips() + ["localhost"])[0] + ":" + str(PORT)
        # CRLF/enjeksiyon riskine karsi Host basligini temizle.
        host_header = re.sub(r"[^\w.:\[\]-]", "", host_header)[:200]
        scheme = self.headers.get("X-Forwarded-Proto", "http").strip() or "http"
        scheme = scheme if scheme in ("http", "https") else "http"
        base_host = scheme + "://" + host_header

        content = content.replace("__CAPY_KEY__", key).replace(
            "__CAPY_EXPIRES__", expires or "unlimited"
        ).replace("__CAPY_HOST__", base_host)

        body = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", 'attachment; filename="%s.lua"' % sid)
        add_security_headers(self)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        add_security_headers(self)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        try:
            print("[capy] " + (fmt % args))
        except Exception:
            pass


def local_ips():
    ips = []
    try:
        host = socket.gethostbyname_ex(socket.gethostname())[2]
        ips.extend(host)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return list(dict.fromkeys(ips))


def main():
    promote_legacy_admin()
    admin_bootstrap()
    ensure_demo_key()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("=" * 52)
    print("  CAPY SCRIPTS â€” SUNUCU AÃ‡ILDI")
    print("=" * 52)
    print("  Kendin icin : http://localhost:%d" % PORT)
    for ip in local_ips():
        print("  Ag uzerinden: http://%s:%d" % (ip, PORT))
    print("  * Script dosyalarina erisim adresi otomatik gomulur.")
    print("  * Farkli adres icin CAPY_HOST ortam degiskenini ayarla.")
    print("  Cikmak icin : Ctrl+C")
    print("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSunucu kapatildi.")
        server.server_close()


if __name__ == "__main__":
    main()

