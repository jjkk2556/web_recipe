/**
 * Kimi Recipe Studio — 后端服务
 * 功能：代理 Kimi API 生成食谱；社区食谱的发布 / 改良 / 点赞 / 评论
 */
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ENV_FILE = path.join(__dirname, ".env");
const ENV_EXAMPLE = path.join(__dirname, ".env.example");

/* ---------- 工具：.env 读写 ---------- */
function loadEnv() {
  const env = {};
  const file = fs.existsSync(ENV_FILE) ? ENV_FILE : ENV_EXAMPLE;
  if (fs.existsSync(file)) {
    fs.readFileSync(file, "utf8").split("\n").forEach(line => {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    });
  }
  env.KIMI_BASE_URL = env.KIMI_BASE_URL || "https://api.moonshot.cn/v1";
  env.KIMI_MODEL = env.KIMI_MODEL || "kimi-latest";
  return env;
}
function saveEnvKey(key, value) {
  let lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, "utf8").split("\n")
    : fs.readFileSync(ENV_EXAMPLE, "utf8").split("\n");
  let found = false;
  lines = lines.map(l => {
    if (l.startsWith(key + "=")) { found = true; return `${key}=${value}`; }
    return l;
  });
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n"));
}

/* ---------- 工具：JSON 数据库 ---------- */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { recipes: [], comments: [] }; }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 中间件 ---------- */
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..")));   // 前端文件位于项目根目录

/* ---------- Kimi 调用 ---------- */
async function callKimi(messages, env) {
  const res = await fetch(`${env.KIMI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.KIMI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.KIMI_MODEL,
      messages,
      temperature: 0.7,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Kimi API 错误 (${res.status})`);
    err.detail = text;
    throw err;
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseRecipeJSON(content) {
  // 从模型输出中提取 JSON
  try {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse(match ? match[1] : content);
  } catch {
    const s = content.indexOf("{"), e = content.lastIndexOf("}");
    if (s !== -1 && e !== -1) return JSON.parse(content.slice(s, e + 1));
    throw new Error("无法解析食谱数据");
  }
}

function buildGeneratePrompt(body) {
  const { ingredients, cuisine, servings, style, extra } = body;
  return `你是一位经验丰富、富有创意的中式家常菜谱设计师。请根据以下要求创作一份食谱：

【食材】${ingredients || "自由发挥"}
【菜系/口味】${cuisine || "不限"}
【份量】${servings || "2人份"}
【风格】${style || "家常"}
【其他要求】${extra || "无"}

严格只输出一个 JSON 对象（不要输出其他文字），格式如下：
{
  "title": "食谱标题（要有创意但不浮夸）",
  "description": "一句话描述，60字以内",
  "prep_time": "准备时间，如15分钟",
  "cook_time": "烹饪时间，如30分钟",
  "difficulty": "难度：简单/中等/困难",
  "ingredients": [{"name": "食材名", "amount": "用量"}],
  "steps": ["步骤1", "步骤2"],
  "tips": ["实用小贴士1", "小贴士2"]
}
要求：步骤清晰可操作；食材用量按【份量】给出；如有食材冲突请合理替换并在 tips 中说明。`;
}

function buildRemixPrompt(recipe, suggestion) {
  return `你是一位菜谱改良师。下面是一份已有食谱，用户希望对它进行改良再创作。

【原食谱标题】${recipe.title}
【原食谱描述】${recipe.description}
【原食材】${recipe.ingredients.map(i => `${i.name} ${i.amount}`).join("、")}
【原步骤】${recipe.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

【用户改良要求】${suggestion || "请在保持风味的前提下做一次优化升级"}

请在尊重原食谱的基础上进行改良，严格只输出一个 JSON 对象，格式：
{
  "title": "改良后的新标题",
  "description": "一句话说明改良思路与亮点，60字以内",
  "prep_time": "...", "cook_time": "...", "difficulty": "...",
  "ingredients": [{"name": "...", "amount": "..."}],
  "steps": ["..."],
  "tips": ["...", "改良说明：..."],
  "changes": "本次改良说明，80字以内"
}`;
}

/* ---------- API 路由 ---------- */

// 生成新食谱
app.post("/api/generate", async (req, res) => {
  const env = loadEnv();
  if (!env.KIMI_API_KEY) {
    return res.status(400).json({ error: "尚未配置 Kimi API Key，请先在「设置」中填写" });
  }
  try {
    const content = await callKimi([
      { role: "system", content: "你是专业的食谱创作助手，只输出 JSON。" },
      { role: "user", content: buildGeneratePrompt(req.body) }
    ], env);
    res.json({ recipe: parseRecipeJSON(content) });
  } catch (e) {
    res.status(502).json({ error: e.message, detail: e.detail });
  }
});

// 改良已有食谱
app.post("/api/remix", async (req, res) => {
  const env = loadEnv();
  if (!env.KIMI_API_KEY) {
    return res.status(400).json({ error: "尚未配置 Kimi API Key，请先在「设置」中填写" });
  }
  const db = readDB();
  const recipe = db.recipes.find(r => r.id === req.body.id);
  if (!recipe) return res.status(404).json({ error: "食谱不存在" });
  try {
    const content = await callKimi([
      { role: "system", content: "你是专业的食谱改良助手，只输出 JSON。" },
      { role: "user", content: buildRemixPrompt(recipe, req.body.suggestion) }
    ], env);
    res.json({ recipe: parseRecipeJSON(content), parent_id: recipe.id });
  } catch (e) {
    res.status(502).json({ error: e.message, detail: e.detail });
  }
});

// 社区：列表
app.get("/api/recipes", (req, res) => {
  const db = readDB();
  const list = [...db.recipes]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(r => ({ ...r, comments: db.comments.filter(c => c.recipe_id === r.id).length }));
  res.json(list);
});

// 社区：详情
app.get("/api/recipes/:id", (req, res) => {
  const db = readDB();
  const recipe = db.recipes.find(r => r.id === req.params.id);
  if (!recipe) return res.status(404).json({ error: "食谱不存在" });
  const comments = db.comments.filter(c => c.recipe_id === recipe.id);
  const parent = recipe.parent_id ? db.recipes.find(r => r.id === recipe.parent_id) : null;
  const children = db.recipes.filter(r => r.parent_id === recipe.id);
  res.json({ ...recipe, comments, parent, children });
});

// 社区：发布
app.post("/api/recipes", (req, res) => {
  const { recipe, author, parent_id } = req.body;
  if (!recipe || !recipe.title || !Array.isArray(recipe.steps)) {
    return res.status(400).json({ error: "食谱数据不完整" });
  }
  const db = readDB();
  const item = {
    id: uid(),
    ...recipe,
    author: (author || "匿名厨友").slice(0, 20),
    parent_id: parent_id || null,
    likes: 0,
    created_at: new Date().toISOString()
  };
  db.recipes.push(item);
  writeDB(db);
  res.status(201).json(item);
});

// 社区：点赞
app.post("/api/recipes/:id/like", (req, res) => {
  const db = readDB();
  const recipe = db.recipes.find(r => r.id === req.params.id);
  if (!recipe) return res.status(404).json({ error: "食谱不存在" });
  recipe.likes = (recipe.likes || 0) + 1;
  writeDB(db);
  res.json({ likes: recipe.likes });
});

// 社区：评论
app.post("/api/recipes/:id/comments", (req, res) => {
  const db = readDB();
  if (!db.recipes.find(r => r.id === req.params.id)) {
    return res.status(404).json({ error: "食谱不存在" });
  }
  const c = {
    id: uid(),
    recipe_id: req.params.id,
    author: (req.body.author || "匿名厨友").slice(0, 20),
    text: (req.body.text || "").slice(0, 500),
    created_at: new Date().toISOString()
  };
  db.comments.push(c);
  writeDB(db);
  res.status(201).json(c);
});

// 设置：读取/保存 API Key
app.get("/api/settings", (req, res) => {
  const env = loadEnv();
  res.json({ has_key: !!env.KIMI_API_KEY, model: env.KIMI_MODEL, base_url: env.KIMI_BASE_URL, key: env.KIMI_API_KEY || "" });
});
app.post("/api/settings", (req, res) => {
  const { key, model, base_url } = req.body;
  if (key !== undefined) saveEnvKey("KIMI_API_KEY", key.trim());
  if (model) saveEnvKey("KIMI_MODEL", model.trim());
  if (base_url) saveEnvKey("KIMI_BASE_URL", base_url.trim());
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  🍳 Kimi Recipe Studio 已启动`);
  console.log(`  ➜ 本地访问: http://localhost:${PORT}\n`);
});
