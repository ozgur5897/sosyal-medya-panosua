"""Sosyal Medya İş Panosu — üyelikli, rol tabanlı backend."""

import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import shutil
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Veri (veritabanı, oturum anahtarı, yüklenen dosyalar) normalde kod ile aynı
# klasörde tutulur. Render gibi platformlarda ücretsiz plan bu klasörü her
# "uykuya dalma/uyanma" veya yeniden başlatmada sıfırlar; kalıcı bir disk
# eklendiğinde DATA_DIR ortam değişkenini o diskin bağlandığı yola
# ayarlayarak (örn. /var/data) verilerin kalıcı olmasını sağlayabilirsiniz.
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "data.db"
UPLOADS_DIR = DATA_DIR / "uploads"
SECRET_KEY_PATH = DATA_DIR / "secret_key.txt"

UPLOADS_DIR.mkdir(exist_ok=True)

ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v"}
MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # 300 MB

VALID_ROLES = {"istek_sahibi", "sosyal_medya"}
VALID_STATUSES = {"bekliyor", "devam_ediyor", "tamamlandi", "paylasildi", "iptal"}

PLATFORM_LABELS = {
    "instagram": "Instagram",
    "x": "X",
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "linkedin": "LinkedIn",
    "facebook": "Facebook",
}
BRAND_LABELS = {
    "bex_coffee": "Bex Coffee",
    "estanbul_gaming": "Estanbul Gaming",
    "ortak": "Ortak",
}
SIZE_LABELS = {
    "kare": "Kare (1:1)",
    "story": "Story (9:16)",
    "yatay": "Yatay (16:9)",
}


def platform_label(key: str) -> str:
    return PLATFORM_LABELS.get(key, key)


def brand_label(key: str) -> str:
    return BRAND_LABELS.get(key, "Ortak")


def size_label(key: str) -> str:
    return SIZE_LABELS.get(key, key)


FIELD_LABELS = {
    "description": "açıklama",
    "due_date": "paylaşım tarihi",
    "urgent": "acil durumu",
    "platforms": "platformlar",
    "brand": "marka",
    "link": "bağlantı",
    "assigned_to": "atanan kişi",
    "sizes": "görsel boyutları",
}


def get_or_create_secret_key() -> str:
    if SECRET_KEY_PATH.exists():
        key = SECRET_KEY_PATH.read_text().strip()
        if key:
            return key
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key)
    return key


app = FastAPI(title="Sosyal Medya İş Panosu")
app.add_middleware(
    SessionMiddleware,
    secret_key=get_or_create_secret_key(),
    session_cookie="smp_session",
    max_age=60 * 60 * 24 * 30,  # 30 gün
    same_site="lax",
)


# ---------------- Şifre hash'leme ----------------

def hash_password(password: str, salt_hex: Optional[str] = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return digest.hex(), salt.hex()


def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    digest, _ = hash_password(password, salt_hex)
    return hmac.compare_digest(digest, hash_hex)


# ---------------- DB ----------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'istek_sahibi',
            is_admin INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            due_date TEXT NOT NULL,
            urgent INTEGER NOT NULL DEFAULT 0,
            platforms TEXT NOT NULL DEFAULT '[]',
            brand TEXT NOT NULL DEFAULT 'ortak',
            link TEXT,
            sizes TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'bekliyor',
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL,
            approved_by INTEGER REFERENCES users(id),
            approved_at TEXT,
            completed_by INTEGER REFERENCES users(id),
            completed_at TEXT,
            published_by INTEGER REFERENCES users(id),
            published_at TEXT,
            rejected_by INTEGER REFERENCES users(id),
            rejected_at TEXT,
            assigned_to INTEGER REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            author_id INTEGER NOT NULL REFERENCES users(id),
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            uploaded_by INTEGER NOT NULL REFERENCES users(id),
            uploaded_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id INTEGER NOT NULL REFERENCES users(id),
            action TEXT NOT NULL,
            card_id INTEGER,
            card_description TEXT,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS card_reads (
            user_id INTEGER NOT NULL REFERENCES users(id),
            card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            last_seen_at TEXT NOT NULL,
            PRIMARY KEY (user_id, card_id)
        );
        """
    )
    # Önceki bir sürümden yükseltilen veritabanlarında bazı sütunlar eksik olabilir.
    existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(cards)").fetchall()}
    if "link" not in existing_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN link TEXT")
    if "rejected_by" not in existing_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN rejected_by INTEGER REFERENCES users(id)")
    if "rejected_at" not in existing_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN rejected_at TEXT")
    if "assigned_to" not in existing_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN assigned_to INTEGER REFERENCES users(id)")
    if "sizes" not in existing_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN sizes TEXT NOT NULL DEFAULT '[]'")
    conn.commit()
    conn.close()


@app.on_event("startup")
def on_startup() -> None:
    init_db()


# ---------------- Yardımcılar ----------------

def user_public(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "is_admin": bool(row["is_admin"]),
        "is_active": bool(row["is_active"]),
    }


def display_name_for(conn: sqlite3.Connection, user_id: Optional[int]) -> Optional[str]:
    if user_id is None:
        return None
    row = conn.execute("SELECT display_name FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["display_name"] if row else None


def normalize_link(raw: str) -> Optional[str]:
    value = (raw or "").strip()
    if not value:
        return None
    if not value.lower().startswith(("http://", "https://")):
        value = "https://" + value
    return value


def save_upload(file: UploadFile) -> tuple[str, str]:
    ext = Path(file.filename or "").suffix.lower()
    if ext in ALLOWED_IMAGE_EXT:
        media_type = "image"
    elif ext in ALLOWED_VIDEO_EXT:
        media_type = "video"
    else:
        raise HTTPException(400, f"Desteklenmeyen dosya türü: {ext or 'bilinmiyor'}")

    fname = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOADS_DIR / fname
    size = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(400, "Dosya çok büyük (300 MB üst sınır)")
            out.write(chunk)
    return f"/uploads/{fname}", media_type


def card_to_dict(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    d = dict(row)
    d["urgent"] = bool(d["urgent"])
    try:
        d["platforms"] = json.loads(d["platforms"])
    except (TypeError, ValueError):
        d["platforms"] = []
    try:
        d["sizes"] = json.loads(d["sizes"])
    except (TypeError, ValueError):
        d["sizes"] = []
    d["created_by_name"] = display_name_for(conn, d["created_by"])
    d["approved_by_name"] = display_name_for(conn, d["approved_by"])
    d["completed_by_name"] = display_name_for(conn, d["completed_by"])
    d["published_by_name"] = display_name_for(conn, d["published_by"])
    d["rejected_by_name"] = display_name_for(conn, d["rejected_by"])
    d["assigned_to_name"] = display_name_for(conn, d["assigned_to"])
    try:
        due = datetime.fromisoformat(d["due_date"])
        d["is_overdue"] = d["status"] not in ("paylasildi", "iptal") and due < datetime.now()
    except ValueError:
        d["is_overdue"] = False
    return d


# ---------------- Auth bağımlılıkları ----------------

def get_current_user(request: Request) -> dict:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(401, "Giriş yapmalısın")
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if not row or not row["is_active"]:
        request.session.clear()
        raise HTTPException(401, "Giriş yapmalısın")
    return dict(row)


def require_manager(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "sosyal_medya":
        raise HTTPException(403, "Bu işlem için sosyal medya ekibi rolü gerekiyor")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "Bu işlem için yönetici yetkisi gerekiyor")
    return user


# ---------------- Pydantic modelleri ----------------

class SetupRequest(BaseModel):
    username: str
    password: str
    display_name: str


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    display_name: str
    role: str = "istek_sahibi"
    is_admin: bool = False


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class CardEditRequest(BaseModel):
    description: str
    due_date: str
    urgent: bool
    platforms: list[str]
    brand: str
    link: Optional[str] = None
    assigned_to: Optional[int] = None
    sizes: list[str] = []


# ---------------- Auth uç noktaları ----------------

@app.get("/api/setup-status")
def setup_status():
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    conn.close()
    return {"needs_setup": count == 0}


@app.post("/api/setup")
def setup(body: SetupRequest, request: Request):
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if count > 0:
        conn.close()
        raise HTTPException(400, "Kurulum zaten tamamlanmış")
    if len(body.username.strip()) < 2:
        conn.close()
        raise HTTPException(400, "Kullanıcı adı en az 2 karakter olmalı")
    if len(body.password) < 6:
        conn.close()
        raise HTTPException(400, "Şifre en az 6 karakter olmalı")

    pwd_hash, salt = hash_password(body.password)
    now = datetime.now().isoformat(timespec="minutes")
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, salt, display_name, role, is_admin, created_at) VALUES (?, ?, ?, ?, 'sosyal_medya', 1, ?)",
        (body.username.strip(), pwd_hash, salt, body.display_name.strip() or body.username.strip(), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    request.session["user_id"] = row["id"]
    return user_public(row)


@app.post("/api/login")
def login(body: LoginRequest, request: Request):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (body.username.strip(),)).fetchone()
    conn.close()
    if not row or not verify_password(body.password, row["salt"], row["password_hash"]):
        raise HTTPException(401, "Kullanıcı adı veya şifre hatalı")
    if not row["is_active"]:
        raise HTTPException(401, "Kullanıcı adı veya şifre hatalı")
    request.session["user_id"] = row["id"]
    return user_public(row)


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(get_current_user)):
    return user_public(user)


# ---------------- Kullanıcı yönetimi (admin) ----------------

@app.get("/api/users")
def list_users(admin: dict = Depends(require_admin)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM users ORDER BY created_at ASC").fetchall()
    conn.close()
    return [user_public(r) for r in rows]


@app.post("/api/users")
def create_user(body: CreateUserRequest, admin: dict = Depends(require_admin)):
    if body.role not in VALID_ROLES:
        raise HTTPException(400, "Geçersiz rol")
    if len(body.username.strip()) < 2:
        raise HTTPException(400, "Kullanıcı adı en az 2 karakter olmalı")
    if len(body.password) < 6:
        raise HTTPException(400, "Şifre en az 6 karakter olmalı")

    conn = get_db()
    pwd_hash, salt = hash_password(body.password)
    now = datetime.now().isoformat(timespec="minutes")
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, salt, display_name, role, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (body.username.strip(), pwd_hash, salt, body.display_name.strip() or body.username.strip(), body.role, int(body.is_admin), now),
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Bu kullanıcı adı zaten var")
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return user_public(row)


@app.patch("/api/users/{user_id}")
def update_user(user_id: int, body: UpdateUserRequest, admin: dict = Depends(require_admin)):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Kullanıcı bulunamadı")

    if body.role is not None and body.role not in VALID_ROLES:
        conn.close()
        raise HTTPException(400, "Geçersiz rol")

    # Son aktif yöneticiyi yönetici olmaktan çıkarmayı / devre dışı bırakmayı engelle
    becoming_non_admin = body.is_admin is False and row["is_admin"]
    becoming_inactive = body.is_active is False and row["is_active"]
    if row["is_admin"] and row["is_active"] and (becoming_non_admin or becoming_inactive):
        active_admin_count = conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND is_active = 1"
        ).fetchone()["c"]
        if active_admin_count <= 1:
            conn.close()
            raise HTTPException(400, "Son aktif yönetici hesabı bu şekilde değiştirilemez")

    new_display_name = body.display_name.strip() if body.display_name else row["display_name"]
    new_role = body.role if body.role is not None else row["role"]
    new_is_admin = int(body.is_admin) if body.is_admin is not None else row["is_admin"]
    new_is_active = int(body.is_active) if body.is_active is not None else row["is_active"]

    conn.execute(
        "UPDATE users SET display_name = ?, role = ?, is_admin = ?, is_active = ? WHERE id = ?",
        (new_display_name, new_role, new_is_admin, new_is_active, user_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return user_public(row)


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, admin: dict = Depends(require_admin)):
    """Kullanıcıyı gerçekten silmez — geçmiş kayıtlar (kartlar, yorumlar, log) bozulmasın diye
    hesabı devre dışı bırakır. Devre dışı kullanıcı artık giriş yapamaz."""
    if user_id == admin["id"]:
        raise HTTPException(400, "Kendi hesabını devre dışı bırakamazsın")
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Kullanıcı bulunamadı")
    if row["is_admin"] and row["is_active"]:
        active_admin_count = conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND is_active = 1"
        ).fetchone()["c"]
        if active_admin_count <= 1:
            conn.close()
            raise HTTPException(400, "Son aktif yönetici hesabı devre dışı bırakılamaz")
    conn.execute("UPDATE users SET is_active = 0 WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/me/password")
def change_own_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not row or not verify_password(body.current_password, row["salt"], row["password_hash"]):
        conn.close()
        raise HTTPException(400, "Mevcut şifre hatalı")
    if len(body.new_password) < 6:
        conn.close()
        raise HTTPException(400, "Yeni şifre en az 6 karakter olmalı")
    pwd_hash, salt = hash_password(body.new_password)
    conn.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", (pwd_hash, salt, user["id"]))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------- İş kartları ----------------

@app.get("/api/assignable-users")
def list_assignable_users(user: dict = Depends(get_current_user)):
    """Herhangi bir giriş yapmış kullanıcı, işleri atayabilmek için sosyal medya
    ekibindeki aktif kişilerin sade bir listesini görebilir (tam kullanıcı
    yönetimi değil — o hâlâ sadece yöneticilere açık)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, display_name FROM users WHERE role = 'sosyal_medya' AND is_active = 1 ORDER BY display_name ASC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/cards")
def list_cards(user: dict = Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute(
        """
        SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
             WHERE cm.card_id = c.id
               AND cm.created_at > COALESCE(
                   (SELECT last_seen_at FROM card_reads WHERE user_id = ? AND card_id = c.id),
                   ''
               )
            ) AS unread_comments
        FROM cards c
        ORDER BY c.urgent DESC, c.created_at DESC
        """,
        (user["id"],),
    ).fetchall()
    result = [card_to_dict(conn, r) for r in rows]
    conn.close()
    return result


@app.post("/api/cards/{card_id}/mark-read")
def mark_card_read(card_id: int, user: dict = Depends(get_current_user)):
    conn = get_db()
    if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    # Tam hassasiyet (mikrosaniyeye kadar) kullanılıyor: aynı dakika içinde art arda
    # olan "gördüm" ve "yeni yorum" olayları yanlışlıkla eşit sayılıp yorum
    # okunmuş gibi görünmesin diye.
    now = datetime.now().isoformat()
    conn.execute(
        """INSERT INTO card_reads (user_id, card_id, last_seen_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, card_id) DO UPDATE SET last_seen_at = excluded.last_seen_at""",
        (user["id"], card_id, now),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/cards")
def create_card(
    description: str = Form(...),
    due_date: str = Form(...),
    urgent: str = Form("false"),
    platforms: str = Form("[]"),
    brand: str = Form("ortak"),
    link: str = Form(""),
    assigned_to: str = Form(""),
    sizes: str = Form("[]"),
    attachment: Optional[UploadFile] = File(None),
    user: dict = Depends(get_current_user),
):
    try:
        platform_list = json.loads(platforms)
        if not isinstance(platform_list, list):
            platform_list = []
    except (TypeError, ValueError):
        platform_list = []

    try:
        size_list = json.loads(sizes)
        if not isinstance(size_list, list):
            size_list = []
    except (TypeError, ValueError):
        size_list = []

    link_value = normalize_link(link)
    assigned_to_value = int(assigned_to) if assigned_to.strip().isdigit() else None

    now = datetime.now().isoformat(timespec="minutes")
    is_urgent = urgent.lower() in ("true", "1", "on", "yes")

    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cards (description, due_date, urgent, platforms, brand, link, assigned_to, sizes, created_by, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bekliyor')""",
        (description, due_date, int(is_urgent), json.dumps(platform_list), brand, link_value, assigned_to_value, json.dumps(size_list), user["id"], now),
    )
    card_id = cur.lastrowid

    if attachment is not None and attachment.filename:
        file_path, media_type = save_upload(attachment)
        conn.execute(
            "INSERT INTO media (card_id, file_path, media_type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)",
            (card_id, file_path, media_type, user["id"], now),
        )

    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.get("/api/cards/{card_id}")
def get_card(card_id: int, user: dict = Depends(get_current_user)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    comments = conn.execute(
        "SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC", (card_id,)
    ).fetchall()
    media = conn.execute(
        "SELECT * FROM media WHERE card_id = ? ORDER BY uploaded_at ASC", (card_id,)
    ).fetchall()
    card = card_to_dict(conn, row)
    card["comments"] = [
        {**dict(c), "author_name": display_name_for(conn, c["author_id"])} for c in comments
    ]
    card["media"] = [
        {**dict(m), "uploaded_by_name": display_name_for(conn, m["uploaded_by"])} for m in media
    ]
    conn.close()
    return card


@app.patch("/api/cards/{card_id}")
def edit_card(card_id: int, body: CardEditRequest, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")

    current = card_to_dict(conn, row)
    new_link = normalize_link(body.link or "")
    new_assigned_name = display_name_for(conn, body.assigned_to) if body.assigned_to else None
    new_values = {
        "description": body.description,
        "due_date": body.due_date,
        "urgent": body.urgent,
        "platforms": body.platforms,
        "brand": body.brand,
        "link": new_link,
        "assigned_to": new_assigned_name,
        "sizes": body.sizes,
    }
    current_for_diff = dict(current)
    current_for_diff["assigned_to"] = current["assigned_to_name"]

    changes = []
    for key, label in FIELD_LABELS.items():
        before = current_for_diff[key]
        after = new_values[key]
        is_diff = sorted(before) != sorted(after) if isinstance(before, list) else before != after
        if is_diff:
            changes.append({"field": label, "before": before, "after": after})

    if changes:
        conn.execute(
            "UPDATE cards SET description = ?, due_date = ?, urgent = ?, platforms = ?, brand = ?, link = ?, assigned_to = ?, sizes = ? WHERE id = ?",
            (body.description, body.due_date, int(body.urgent), json.dumps(body.platforms), body.brand, new_link, body.assigned_to, json.dumps(body.sizes), card_id),
        )
        now = datetime.now().isoformat(timespec="minutes")
        conn.execute(
            "INSERT INTO activity_log (actor_id, action, card_id, card_description, payload, created_at) VALUES (?, 'edited', ?, ?, ?, ?)",
            (user["id"], card_id, current["description"], json.dumps({"changes": changes}), now),
        )
        conn.commit()

    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.delete("/api/cards/{card_id}")
def delete_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")

    current = card_to_dict(conn, row)
    comments = conn.execute("SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC", (card_id,)).fetchall()
    media = conn.execute("SELECT * FROM media WHERE card_id = ? ORDER BY uploaded_at ASC", (card_id,)).fetchall()

    snapshot = {
        "description": current["description"],
        "due_date": current["due_date"],
        "urgent": current["urgent"],
        "platforms": current["platforms"],
        "brand": current["brand"],
        "link": current["link"],
        "status": current["status"],
        "created_by": current["created_by_name"],
        "created_at": current["created_at"],
        "approved_by": current["approved_by_name"],
        "completed_by": current["completed_by_name"],
        "published_by": current["published_by_name"],
        "rejected_by": current["rejected_by_name"],
        "assigned_to": current["assigned_to_name"],
        "sizes": current["sizes"],
        "comments": [
            {"author": display_name_for(conn, c["author_id"]), "text": c["text"], "created_at": c["created_at"]}
            for c in comments
        ],
        "media_summary": [
            {
                "media_type": m["media_type"],
                "uploaded_by": display_name_for(conn, m["uploaded_by"]),
                "uploaded_at": m["uploaded_at"],
                "file_path": m["file_path"],
            }
            for m in media
        ],
    }

    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "INSERT INTO activity_log (actor_id, action, card_id, card_description, payload, created_at) VALUES (?, 'deleted', ?, ?, ?, ?)",
        (user["id"], card_id, current["description"], json.dumps({"snapshot": snapshot}), now),
    )
    conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/cards/{card_id}/approve")
def approve_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    if row["status"] != "bekliyor":
        conn.close()
        raise HTTPException(400, "Bu iş zaten onaylanmış")
    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "UPDATE cards SET status = 'devam_ediyor', approved_by = ?, approved_at = ? WHERE id = ?",
        (user["id"], now, card_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.post("/api/cards/{card_id}/reject")
def reject_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    if row["status"] != "bekliyor":
        conn.close()
        raise HTTPException(400, "Sadece onay bekleyen bir iş iptal edilebilir")
    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "UPDATE cards SET status = 'iptal', rejected_by = ?, rejected_at = ? WHERE id = ?",
        (user["id"], now, card_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.post("/api/cards/{card_id}/complete")
def complete_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "UPDATE cards SET status = 'tamamlandi', completed_by = ?, completed_at = ? WHERE id = ?",
        (user["id"], now, card_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.post("/api/cards/{card_id}/publish")
def publish_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "UPDATE cards SET status = 'paylasildi', published_by = ?, published_at = ? WHERE id = ?",
        (user["id"], now, card_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


@app.post("/api/cards/{card_id}/reopen")
def reopen_card(card_id: int, user: dict = Depends(require_manager)):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    if row["status"] == "iptal":
        # İptal edilen bir iş hiç onaylanmamıştı, tekrar açılınca onay bekleme aşamasına döner.
        conn.execute(
            "UPDATE cards SET status = 'bekliyor', rejected_by = NULL, rejected_at = NULL WHERE id = ?",
            (card_id,),
        )
    else:
        conn.execute(
            "UPDATE cards SET status = 'devam_ediyor', completed_by = NULL, completed_at = NULL, published_by = NULL, published_at = NULL WHERE id = ?",
            (card_id,),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    result = card_to_dict(conn, row)
    conn.close()
    return result


# ---------------- Yorumlar ----------------

@app.post("/api/cards/{card_id}/comments")
def add_comment(card_id: int, text: str = Form(...), user: dict = Depends(get_current_user)):
    conn = get_db()
    if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    # Tam hassasiyet: bkz. mark_card_read üzerindeki not.
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT INTO comments (card_id, author_id, text, created_at) VALUES (?, ?, ?, ?)",
        (card_id, user["id"], text, now),
    )
    # Yazan kişi kendi yorumunu otomatik "görmüş" sayılır, kendi rozetinde
    # okunmamış olarak görünmesin.
    conn.execute(
        """INSERT INTO card_reads (user_id, card_id, last_seen_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, card_id) DO UPDATE SET last_seen_at = excluded.last_seen_at""",
        (user["id"], card_id, now),
    )
    conn.commit()
    rows = conn.execute(
        "SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC", (card_id,)
    ).fetchall()
    result = [{**dict(r), "author_name": display_name_for(conn, r["author_id"])} for r in rows]
    conn.close()
    return result


# ---------------- Medya ----------------

@app.post("/api/cards/{card_id}/media")
def upload_media(card_id: int, file: UploadFile = File(...), user: dict = Depends(require_manager)):
    conn = get_db()
    if not conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "İş bulunamadı")
    file_path, media_type = save_upload(file)
    now = datetime.now().isoformat(timespec="minutes")
    conn.execute(
        "INSERT INTO media (card_id, file_path, media_type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)",
        (card_id, file_path, media_type, user["id"], now),
    )
    conn.commit()
    rows = conn.execute(
        "SELECT * FROM media WHERE card_id = ? ORDER BY uploaded_at ASC", (card_id,)
    ).fetchall()
    result = [{**dict(r), "uploaded_by_name": display_name_for(conn, r["uploaded_by"])} for r in rows]
    conn.close()
    return result


# ---------------- Değişiklik geçmişi ----------------

@app.get("/api/activity-log")
def get_activity_log(user: dict = Depends(require_manager)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["actor_name"] = display_name_for(conn, r["actor_id"])
        try:
            d["payload"] = json.loads(d["payload"])
        except (TypeError, ValueError):
            d["payload"] = {}
        result.append(d)
    conn.close()
    return result


# ---------------- Dışa aktarma ----------------

STATUS_LABELS_TR = {
    "bekliyor": "Onay bekliyor",
    "devam_ediyor": "Devam ediyor",
    "tamamlandi": "Tamamlandı",
    "paylasildi": "Paylaşım yapıldı",
    "iptal": "İptal edildi",
}


@app.get("/api/export/csv")
def export_csv(user: dict = Depends(require_manager)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM cards ORDER BY created_at ASC").fetchall()
    cards = [card_to_dict(conn, r) for r in rows]
    conn.close()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "ID", "Açıklama", "Marka", "Platformlar", "Görsel Boyutları", "Durum", "Acil", "Bağlantı",
        "Atanan", "Açan", "Oluşturulma", "Paylaşım Tarihi",
        "Onaylayan", "Onay Tarihi", "Tamamlayan", "Tamamlanma Tarihi",
        "Paylaşan", "Paylaşım Yapılma Tarihi", "Reddeden", "Red Tarihi",
    ])
    for c in cards:
        writer.writerow([
            c["id"],
            c["description"],
            brand_label(c["brand"]),
            ", ".join(platform_label(p) for p in c["platforms"]),
            ", ".join(size_label(s) for s in c["sizes"]),
            STATUS_LABELS_TR.get(c["status"], c["status"]),
            "Evet" if c["urgent"] else "Hayır",
            c["link"] or "",
            c["assigned_to_name"] or "",
            c["created_by_name"] or "",
            c["created_at"],
            c["due_date"],
            c["approved_by_name"] or "",
            c["approved_at"] or "",
            c["completed_by_name"] or "",
            c["completed_at"] or "",
            c["published_by_name"] or "",
            c["published_at"] or "",
            c["rejected_by_name"] or "",
            c["rejected_at"] or "",
        ])

    csv_bytes = "\ufeff" + buf.getvalue()  # başına BOM: Excel Türkçe karakterleri doğru göstersin
    filename = f"isler-{datetime.now().strftime('%Y-%m-%d')}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/backup")
def download_backup(admin: dict = Depends(require_admin)):
    conn = get_db()
    users = [dict(r) for r in conn.execute(
        "SELECT id, username, display_name, role, is_admin, is_active, created_at FROM users"
    ).fetchall()]
    cards = [card_to_dict(conn, r) for r in conn.execute("SELECT * FROM cards").fetchall()]
    comments = [
        {**dict(r), "author_name": display_name_for(conn, r["author_id"])}
        for r in conn.execute("SELECT * FROM comments").fetchall()
    ]
    media = [
        {**dict(r), "uploaded_by_name": display_name_for(conn, r["uploaded_by"])}
        for r in conn.execute("SELECT * FROM media").fetchall()
    ]
    log_rows = conn.execute("SELECT * FROM activity_log").fetchall()
    activity_log = []
    for r in log_rows:
        d = dict(r)
        d["actor_name"] = display_name_for(conn, r["actor_id"])
        try:
            d["payload"] = json.loads(d["payload"])
        except (TypeError, ValueError):
            d["payload"] = {}
        activity_log.append(d)
    conn.close()

    backup = {
        "exported_at": datetime.now().isoformat(),
        "users": users,
        "cards": cards,
        "comments": comments,
        "media": media,
        "activity_log": activity_log,
    }
    filename = f"yedek-{datetime.now().strftime('%Y-%m-%d-%H%M')}.json"
    return Response(
        content=json.dumps(backup, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/", response_class=HTMLResponse)
def serve_index():
    # Ana sayfa (index.html) tarayıcı tarafından önbelleğe alınmasın diye özellikle
    # burada elle serve ediyoruz — statik dosya mount'u bunu otomatik yapardı ama
    # bazı tarayıcılar/aracı sunucular onu da önbellekleyip eski sürümü gösterebiliyordu.
    # app.js ve styles.css için önbellek yönetimi index.html içindeki ?v= numarasıyla yapılıyor.
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
