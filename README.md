# 🍳 Kimi 食谱工坊

「简约风 AI 食谱共创社区」：用 Kimi API 生成原创食谱，发布到社区，
他人可再让 AI 改良、接力创作，形成不断演进的「食谱家谱」。

## 目录结构

```
.
├── index.html          # 前端单文件应用（CSS/JS 已内联，双击即可预览界面）
├── backend/            # Python (Flask) 后端
│   ├── app.py          # Flask 服务：代理 Kimi API + 社区数据接口 + 账号体系
│   ├── requirements.txt
│   ├── .env.example    # API Key 配置模板
│   └── data/db.json    # 社区数据（JSON 文件存储）
├── .github/
│   └── workflows/      # GitHub Pages 自动部署前端
└── README.md
```

## 启动（完整功能）

```bash
cd backend
pip install -r requirements.txt
python app.py      # → http://localhost:3000
```

复制 `backend/.env.example` 为 `backend/.env`，只需填入 `KIMI_API_KEY`（platform.moonshot.cn 获取），
重启服务即可。模型与 API 地址使用内置默认值，无需填写；网站用户更不需要接触任何配置。

## 部署（GitHub Pages + 腾讯云云托管）

**前端 → GitHub Pages**（push 到 main 后由 `.github/workflows/deploy.yml` 自动部署）：
1. 打开 `index.html`，把顶部部署配置改成你自己的地址：
   - `SITE_URL`：你的 Pages 地址，如 `https://你的用户名.github.io/仓库名`
2. Settings → Pages 确认已开启（Source 选 GitHub Actions）

**后端 → 腾讯云云托管**：
1. 上传 `backend/` 目录，启动命令 `python app.py`，暴露端口 3000，开启外网访问
2. 在云托管控制台配置环境变量（等价于 `.env`）：
   - `KIMI_API_KEY`（必填）
   - `ALLOWED_ORIGIN`（必填）：你的 GitHub Pages 域名，如 `https://你的用户名.github.io`
   - `SESSION_SAMESITE=None`、`SESSION_SECURE=true`（跨域登录 Cookie 必填）
3. 把云托管服务地址填入 `index.html` 的 `API_BASE`，重新 push 前端

> ⚠️ 云托管实例重启会丢失 `data/db.json`（JSON 文件存储），生产使用请挂载持久化存储或定期备份。

## 功能一览

| 模块 | 说明 |
|---|---|
| 账号体系 | 注册/登录/退出，密码 scrypt 加盐哈希存储（与 Node 版哈希互通），HttpOnly Cookie 会话（7 天），发帖评论须登录 |
| AI 创作 | 填食材/口味/份量 → Kimi 生成结构化食谱 |
| 社区 | 浏览、点赞、评论 |
| 改良再创作 | 基于任意食谱 + 改良意见，Kimi 生成新版本并自动关联原版 |

> 提示：直接双击打开 `index.html` 只能看到界面（AI 与社区功能需启动后端）。
