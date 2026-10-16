"""
Kimi Recipe Studio — 后端服务（Flask 版）
功能：代理 Kimi API 生成食谱；社区食谱的发布 / 改良 / 点赞 / 评论；账号体系
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

from flask import Flask, request, jsonify, make_response, send_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "db.json")
ENV_FILE = os.path.join(BASE_DIR, ".env")
ENV_EXAMPLE = os.path.join(BASE_DIR, ".env.example")
INDEX_HTML = os.path.join(ROOT_DIR, "index.html")

SESSION_MAX_AGE = 7 * 24 * 3600  # 7 天
app = Flask(__name__)


# ---------- 工具：.env 读取 ----------
def load_env():
    env = {}
    path = ENV_FILE if os.path.exists(ENV_FILE) else ENV_EXAMPLE
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^\s*([A-Z_]+)\s*=\s*(.*)$", line)
                if m:
                    env[m.group(1)] = m.group(2).strip()
    env.setdefault("KIMI_BASE_URL", "https://api.moonshot.cn/v1")
    env.setdefault("KIMI_MODEL", "kimi-latest")
    env.setdefault("PORT", "3000")
    return env


# ---------- 工具：JSON 数据库 ----------
def read_db():
    try:
        with open(DB_FILE, encoding="utf-8") as f:
            db = json.load(f)
    except Exception:
        db = {}
    # 兼容旧格式数据文件，自动补齐缺失字段
    for key in ("recipes", "comments", "users", "sessions"):
        db.setdefault(key, [])
    return db


def write_db(db):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)


def uid():
    return f"{int(time.time() * 1000):x}{secrets.token_hex(4)}"


def json_response(data, status=200, session_token=None, clear_session=False):
    resp = make_response(jsonify(data), status)
    # 跨域部署（如 GitHub Pages ↔ 腾讯云云托管）时，通过 .env 配置：
    #   SESSION_SAMESITE=None 且 SESSION_SECURE=true（浏览器要求 SameSite=None 必须加 Secure）
    env = load_env()
    secure = env.get("SESSION_SECURE", "").lower() == "true"
    samesite = env.get("SESSION_SAMESITE", "Lax")
    if session_token:
        resp.set_cookie("session", session_token, max_age=SESSION_MAX_AGE,
                        httponly=True, samesite=samesite, secure=secure, path="/")
    if clear_session:
        resp.set_cookie("session", "", max_age=0, httponly=True,
                        samesite=samesite, secure=secure, path="/")
    return resp


# 跨域支持：ALLOWED_ORIGIN 配置为 GitHub Pages 域名后，允许其携带 Cookie 访问
@app.after_request
def add_cors_headers(resp):
    origin = load_env().get("ALLOWED_ORIGIN", "")
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    return resp


# ---------- 密码哈希（scrypt，与 Node scryptSync 默认参数一致，可互通） ----------
def hash_password(password, salt_hex):
    # 盐直接取 hex 字符串的 ASCII 字节（与 Node scryptSync 行为一致，保证跨语言兼容）
    return hashlib.scrypt(password.encode(), salt=salt_hex.encode(),
                          n=16384, r=8, p=1, dklen=64).hex()


def verify_password(password, user):
    a = bytes.fromhex(hash_password(password, user["salt"]))
    b = bytes.fromhex(user["password_hash"])
    return hmac.compare_digest(a, b)


def get_session_user(db):
    token = request.cookies.get("session")
    if not token:
        return None
    s = next((x for x in db["sessions"] if x["token"] == token), None)
    if not s:
        return None
    return next((u for u in db["users"] if u["id"] == s["user_id"]), None)


def public_user(u):
    return {"id": u["id"], "username": u["username"], "created_at": u["created_at"]}


def require_auth():
    """返回 (db, user)；未登录时返回 (None, 401响应)"""
    db = read_db()
    user = get_session_user(db)
    if not user:
        return None, json_response({"error": "请先登录后再操作"}, 401)
    return (db, user), None


# ---------- Kimi 调用 ----------
class KimiError(Exception):
    def __init__(self, message, detail=""):
        super().__init__(message)
        self.detail = detail


def call_kimi(messages, env, use_json_mode=True):
    body = {"model": env["KIMI_MODEL"], "messages": messages, "temperature": 0.7}
    if use_json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urlrequest.Request(
        env["KIMI_BASE_URL"] + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {env['KIMI_API_KEY']}"})
    try:
        with urlrequest.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except HTTPError as e:
        text = e.read().decode(errors="replace")
        # 模型不支持 json_object 模式时，回退为普通模式（仍靠 parse_recipe_json 容错解析）
        if use_json_mode and e.code == 400 and re.search(r"response_format|json", text, re.I):
            return call_kimi(messages, env, use_json_mode=False)
        raise KimiError(f"Kimi API 错误 ({e.code})", text)
    except URLError as e:
        raise KimiError(f"无法连接 Kimi API：{e.reason}")
    return data["choices"][0]["message"]["content"]


def parse_recipe_json(content):
    """从模型输出中提取 JSON"""
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
    try:
        return json.loads(m.group(1) if m else content)
    except Exception:
        s, e = content.find("{"), content.rfind("}")
        if s != -1 and e != -1:
            return json.loads(content[s:e + 1])
    raise KimiError("无法解析食谱数据")


def build_generate_prompt(body):
    return f"""你是一位经验丰富、富有创意的中式家常菜谱设计师。请根据以下要求创作一份食谱：

【食材】{body.get("ingredients") or "自由发挥"}
【菜系/口味】{body.get("cuisine") or "不限"}
【份量】{body.get("servings") or "2人份"}
【风格】{body.get("style") or "家常"}
【其他要求】{body.get("extra") or "无"}

严格只输出一个 JSON 对象（不要输出其他文字），格式如下：
{{
  "title": "食谱标题（要有创意但不浮夸）",
  "description": "一句话描述，60字以内",
  "prep_time": "准备时间，如15分钟",
  "cook_time": "烹饪时间，如30分钟",
  "difficulty": "难度：简单/中等/困难",
  "ingredients": [{{"name": "食材名", "amount": "用量"}}],
  "steps": ["步骤1", "步骤2"],
  "tips": ["实用小贴士1", "小贴士2"]
}}
要求：步骤清晰可操作；食材用量按【份量】给出；如有食材冲突请合理替换并在 tips 中说明。"""


def build_remix_prompt(recipe, suggestion):
    ings = "、".join(f"{i.get('name')} {i.get('amount')}" for i in recipe.get("ingredients", []))
    steps = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(recipe.get("steps", [])))
    return f"""你是一位菜谱改良师。下面是一份已有食谱，用户希望对它进行改良再创作。

【原食谱标题】{recipe.get("title")}
【原食谱描述】{recipe.get("description")}
【原食材】{ings}
【原步骤】{steps}

【用户改良要求】{suggestion or "请在保持风味的前提下做一次优化升级"}

请在尊重原食谱的基础上进行改良，严格只输出一个 JSON 对象，格式：
{{
  "title": "改良后的新标题",
  "description": "一句话说明改良思路与亮点，60字以内",
  "prep_time": "...", "cook_time": "...", "difficulty": "...",
  "ingredients": [{{"name": "...", "amount": "..."}}],
  "steps": ["..."],
  "tips": ["...", "改良说明：..."],
  "changes": "本次改良说明，80字以内"
}}"""


def need_key(env):
    if not env.get("KIMI_API_KEY"):
        return json_response(
            {"error": "服务端尚未配置 Kimi API Key，请在 backend/.env 中设置 KIMI_API_KEY 后重启服务"}, 400)
    return None


# ---------- 前端单文件 ----------
@app.route("/")
@app.route("/index.html")
def index():
    return send_file(INDEX_HTML)


# ---------- AI 接口 ----------
@app.route("/api/generate", methods=["POST"])
def generate():
    env = load_env()
    err = need_key(env)
    if err:
        return err
    try:
        content = call_kimi([
            {"role": "system", "content": "你是专业的食谱创作助手，只输出 JSON。"},
            {"role": "user", "content": build_generate_prompt(request.get_json(force=True) or {})},
        ], env)
        return json_response({"recipe": parse_recipe_json(content)})
    except KimiError as e:
        return json_response({"error": str(e), "detail": e.detail}, 502)


@app.route("/api/remix", methods=["POST"])
def remix():
    env = load_env()
    err = need_key(env)
    if err:
        return err
    body = request.get_json(force=True) or {}
    db = read_db()
    recipe = next((r for r in db["recipes"] if r["id"] == body.get("id")), None)
    if not recipe:
        return json_response({"error": "食谱不存在"}, 404)
    try:
        content = call_kimi([
            {"role": "system", "content": "你是专业的食谱改良助手，只输出 JSON。"},
            {"role": "user", "content": build_remix_prompt(recipe, body.get("suggestion"))},
        ], env)
        return json_response({"recipe": parse_recipe_json(content), "parent_id": recipe["id"]})
    except KimiError as e:
        return json_response({"error": str(e), "detail": e.detail}, 502)


# ---------- 账号体系 ----------
@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    body = request.get_json(force=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    db = read_db()
    if not re.match(r"^[\w\u4e00-\u9fa5-]{2,20}$", username):
        return json_response({"error": "用户名需为 2-20 位中英文、数字或下划线"}, 400)
    if not (6 <= len(password) <= 72):
        return json_response({"error": "密码长度需为 6-72 位"}, 400)
    if any(u["username"].lower() == username.lower() for u in db["users"]):
        return json_response({"error": "该用户名已被注册"}, 409)
    salt = secrets.token_hex(16)
    user = {"id": uid(), "username": username, "salt": salt,
            "password_hash": hash_password(password, salt),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    db["users"].append(user)
    token = secrets.token_hex(32)
    db["sessions"].append({"token": token, "user_id": user["id"],
                           "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    write_db(db)
    return json_response({"user": public_user(user)}, 201, session_token=token)


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body = request.get_json(force=True) or {}
    username = str(body.get("username", "")).strip()
    db = read_db()
    user = next((u for u in db["users"] if u["username"].lower() == username.lower()), None)
    if not user or not verify_password(str(body.get("password", "")), user):
        return json_response({"error": "用户名或密码不正确"}, 401)
    token = secrets.token_hex(32)
    db["sessions"].append({"token": token, "user_id": user["id"],
                           "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    write_db(db)
    return json_response({"user": public_user(user)}, session_token=token)


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    db = read_db()
    token = request.cookies.get("session")
    db["sessions"] = [x for x in db["sessions"] if x["token"] != token]
    write_db(db)
    return json_response({"ok": True}, clear_session=True)


@app.route("/api/auth/me")
def auth_me():
    db = read_db()
    user = get_session_user(db)
    return json_response({"user": public_user(user) if user else None})


# ---------- 社区 ----------
@app.route("/api/recipes", methods=["GET"])
def recipes_list():
    db = read_db()
    out = sorted(db["recipes"], key=lambda r: r["created_at"], reverse=True)
    for r in out:
        r["comments"] = sum(1 for c in db["comments"] if c["recipe_id"] == r["id"])
    return json_response(out)


@app.route("/api/recipes/<rid>")
def recipe_detail(rid):
    db = read_db()
    recipe = next((r for r in db["recipes"] if r["id"] == rid), None)
    if not recipe:
        return json_response({"error": "食谱不存在"}, 404)
    recipe = dict(recipe)
    recipe["comments"] = [c for c in db["comments"] if c["recipe_id"] == rid]
    recipe["parent"] = next((r for r in db["recipes"] if r["id"] == recipe.get("parent_id")), None)
    recipe["children"] = [r for r in db["recipes"] if r.get("parent_id") == rid]
    return json_response(recipe)


@app.route("/api/recipes", methods=["POST"])
def recipe_create():
    body = request.get_json(force=True) or {}
    recipe = body.get("recipe")
    if not recipe or not recipe.get("title") or not isinstance(recipe.get("steps"), list):
        return json_response({"error": "食谱数据不完整"}, 400)
    auth, err = require_auth()
    if err:
        return err
    db, user = auth
    item = {**recipe, "id": uid(), "author": user["username"], "author_id": user["id"],
            "parent_id": body.get("parent_id"), "likes": 0,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    db["recipes"].append(item)
    write_db(db)
    return json_response(item, 201)


@app.route("/api/recipes/<rid>/like", methods=["POST"])
def recipe_like(rid):
    db = read_db()
    recipe = next((r for r in db["recipes"] if r["id"] == rid), None)
    if not recipe:
        return json_response({"error": "食谱不存在"}, 404)
    recipe["likes"] = recipe.get("likes", 0) + 1
    write_db(db)
    return json_response({"likes": recipe["likes"]})


@app.route("/api/recipes/<rid>/comments", methods=["POST"])
def recipe_comment(rid):
    auth, err = require_auth()
    if err:
        return err
    db, user = auth
    if not any(r["id"] == rid for r in db["recipes"]):
        return json_response({"error": "食谱不存在"}, 404)
    c = {"id": uid(), "recipe_id": rid, "author": user["username"], "author_id": user["id"],
         "text": str((request.get_json(force=True) or {}).get("text", ""))[:500],
         "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    db["comments"].append(c)
    write_db(db)
    return json_response(c, 201)


# ---------- 设置状态（绝不返回明文 Key） ----------
@app.route("/api/settings")
def settings():
    env = load_env()
    return json_response({"has_key": bool(env.get("KIMI_API_KEY")), "model": env.get("KIMI_MODEL")})


if __name__ == "__main__":
    port = int(load_env().get("PORT", 3000))
    print("\n  🍳 Kimi Recipe Studio 已启动（Flask）")
    print(f"  ➜ 本地访问: http://localhost:{port}\n")
    app.run(port=port)
