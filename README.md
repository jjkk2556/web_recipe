# 🍳 Kimi 食谱工坊

「简约风 AI 食谱共创社区」：用 Kimi API 生成原创食谱，发布到社区，
他人可再让 AI 改良、接力创作，形成不断演进的「食谱家谱」。

## 目录结构

```
.
├── index.html          # 前端入口（纯静态，可直接打开预览界面）
├── style.css           # 极简风格样式
├── app.js              # 前端逻辑
├── backend/            # Node.js 后端
│   ├── server.js       # Express 服务：代理 Kimi API + 社区数据接口
│   ├── package.json
│   ├── .env.example    # API Key 配置模板
│   └── data/db.json    # 社区数据（JSON 文件存储）
├── .github/
│   └── workflows/      # GitHub Pages 自动部署前端
└── README.md
```

## 启动（完整功能）

```bash
cd backend
npm install
npm start          # → http://localhost:3000
```

打开网站 → 「设置」页填入 Kimi API Key（platform.moonshot.cn 获取）。
也可以复制 `.env.example` 为 `backend/.env` 手动填写。

## 功能一览

| 模块 | 说明 |
|---|---|
| AI 创作 | 填食材/口味/份量 → Kimi 生成结构化食谱 |
| 社区 | 浏览、点赞、评论 |
| 改良再创作 | 基于任意食谱 + 改良意见，Kimi 生成新版本并自动关联原版 |

> 提示：直接双击打开 `index.html` 只能看到界面（AI 与社区功能需启动后端）。
