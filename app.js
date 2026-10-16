/* ========== Kimi 食谱工坊 · 前端逻辑 ========== */
const $ = s => document.querySelector(s);
const api = (url, opts = {}) =>
  fetch(url, { headers: { "Content-Type": "application/json" }, ...opts }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
    return data;
  });

const getAuthor = () => localStorage.getItem("author") || "匿名厨友";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = iso => new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });

/* ---------- 视图切换 ---------- */
document.querySelectorAll("[data-view]").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault();
    const view = el.dataset.view;
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    $(`#view-${view}`).classList.add("active");
    document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
    if (view === "community") loadCommunity();
    if (view === "settings") loadSettings();
  });
});

/* ---------- 食谱渲染 ---------- */
function recipeHTML(r) {
  return `
    <div class="recipe-head">
      <div>
        <h3>${esc(r.title)}</h3>
        <p class="recipe-desc">${esc(r.description || "")}</p>
      </div>
    </div>
    <div class="badges">
      <span class="badge hot">⏱ 准备 ${esc(r.prep_time || "—")}</span>
      <span class="badge hot">🔥 烹饪 ${esc(r.cook_time || "—")}</span>
      <span class="badge">${esc(r.difficulty || "")}</span>
      ${r.author ? `<span class="badge">by ${esc(r.author)}</span>` : ""}
    </div>
    <div class="recipe-cols">
      <div>
        <p class="sub-title">食材</p>
        <ul class="ing-list">
          ${(r.ingredients || []).map(i => `<li><b>${esc(i.name)}</b><span>${esc(i.amount)}</span></li>`).join("")}
        </ul>
      </div>
      <div>
        <p class="sub-title">步骤</p>
        <ol class="steps">${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol>
      </div>
    </div>
    ${(r.tips || []).length ? `<div class="tips"><p class="sub-title">小贴士</p><ul>${r.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    ${r.changes ? `<div class="tips"><p class="sub-title">本次改良</p>${esc(r.changes)}</div>` : ""}
  `;
}

/* ---------- AI 生成 ---------- */
$("#btn-generate").addEventListener("click", async () => {
  const btn = $("#btn-generate"), status = $("#generate-status");
  const ingredients = $("#f-ingredients").value.trim();
  if (!ingredients) { status.textContent = "请先填写食材～"; status.className = "status error"; return; }
  btn.disabled = true; status.className = "status";
  status.textContent = "Kimi 正在为你创作食谱，请稍候…";
  try {
    const data = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        ingredients,
        cuisine: $("#f-cuisine").value.trim(),
        servings: $("#f-servings").value.trim(),
        style: $("#f-style").value.trim(),
        extra: $("#f-extra").value.trim()
      })
    });
    window._generated = data.recipe;
    const panel = $("#result-panel");
    panel.innerHTML = recipeHTML(data.recipe) + `
      <div class="result-actions">
        <button class="btn-primary" id="btn-publish">📮 发布到社区</button>
        <button class="btn-ghost" id="btn-regen">🔄 再生成一次</button>
      </div>`;
    $("#result-area").classList.remove("hidden");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    status.textContent = "✅ 生成成功！满意的话可以发布到社区。";
    $("#btn-publish").onclick = () => publishRecipe(data.recipe);
    $("#btn-regen").onclick = () => btn.click();
  } catch (e) {
    status.textContent = "生成失败：" + e.message;
    status.className = "status error";
  } finally {
    btn.disabled = false;
  }
});

async function publishRecipe(recipe, parent_id = null) {
  try {
    await api("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ recipe, author: getAuthor(), parent_id })
    });
    alert("🎉 已发布到社区！");
    document.querySelector('[data-view="community"]').click();
  } catch (e) { alert("发布失败：" + e.message); }
}

/* ---------- 社区 ---------- */
async function loadCommunity() {
  const list = $("#recipe-list");
  list.innerHTML = `<p class="muted">加载中…</p>`;
  try {
    const recipes = await api("/api/recipes");
    if (!recipes.length) {
      list.innerHTML = `<div class="empty-state">还没有食谱。<br>先去「AI 创作」生成一份，发布到这里吧 👨‍🍳</div>`;
      return;
    }
    list.innerHTML = recipes.map(r => `
      <div class="card" data-id="${r.id}">
        ${r.parent_id ? `<span class="remix-tag">↳ 改良版</span>` : ""}
        <h4>${esc(r.title)}</h4>
        <p class="card-desc">${esc(r.description || "")}</p>
        <div class="card-meta">
          <span>by ${esc(r.author)}</span>
          <span>❤ ${r.likes || 0}</span>
          <span>💬 ${r.comments || 0}</span>
          <span>${fmtDate(r.created_at)}</span>
        </div>
      </div>`).join("");
    list.querySelectorAll(".card").forEach(c =>
      c.addEventListener("click", () => openDetail(c.dataset.id)));
  } catch (e) {
    list.innerHTML = `<div class="empty-state">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------- 详情弹层 ---------- */
async function openDetail(id) {
  try {
    const r = await api(`/api/recipes/${id}`);
    const body = $("#modal-body");
    body.innerHTML = recipeHTML(r) + `
      <div class="result-actions">
        <button class="btn-ghost btn-accent" id="d-like">❤ 点赞 (${r.likes || 0})</button>
        <button class="btn-ghost" id="d-fork">🍴 改良再创作</button>
        ${r.parent ? `<button class="btn-ghost" id="d-parent">↩ 查看原版</button>` : ""}
      </div>

      <div class="remix-box" id="remix-box" style="display:none">
        <p class="sub-title">🤖 让 Kimi 帮你改良</p>
        <textarea id="remix-input" rows="2" placeholder="想怎么改？例如：做成低脂版 / 换成空气炸锅 / 加辣…"></textarea>
        <div class="result-actions">
          <button class="btn-primary" id="btn-remix">✨ 开始改良</button>
        </div>
        <p id="remix-status" class="status"></p>
      </div>

      <div class="comments">
        <p class="sub-title">评论 (${r.comments.length})</p>
        <div id="comment-list">
          ${r.comments.map(c => `<div class="comment"><b>${esc(c.author)}</b><time>${fmtDate(c.created_at)}</time><br>${esc(c.text)}</div>`).join("") || `<p class="muted">还没有评论，来抢沙发～</p>`}
        </div>
        <div class="comment-form">
          <input id="comment-input" placeholder="写下你的想法或改良建议…">
          <button class="btn-ghost btn-accent" id="btn-comment">发送</button>
        </div>
      </div>

      ${r.children && r.children.length ? `
        <div class="comments">
          <p class="sub-title">这份食谱的改良版 (${r.children.length})</p>
          ${r.children.map(ch => `<div class="comment" style="cursor:pointer" data-goto="${ch.id}">🍴 <b>${esc(ch.title)}</b> <span class="muted">by ${esc(ch.author)}</span></div>`).join("")}
        </div>` : ""}
    `;

    $("#d-like").onclick = async () => {
      const d = await api(`/api/recipes/${id}/like`, { method: "POST" });
      $("#d-like").textContent = `❤ 点赞 (${d.likes})`;
    };
    $("#d-fork").onclick = () => {
      const box = $("#remix-box");
      box.style.display = box.style.display === "none" ? "block" : "none";
    };
    if (r.parent) $("#d-parent").onclick = () => openDetail(r.parent.id);

    $("#btn-comment").onclick = async () => {
      const text = $("#comment-input").value.trim();
      if (!text) return;
      await api(`/api/recipes/${id}/comments`, { method: "POST", body: JSON.stringify({ text, author: getAuthor() }) });
      openDetail(id);
    };

    $("#btn-remix").onclick = async () => {
      const btn = $("#btn-remix"), status = $("#remix-status");
      btn.disabled = true; status.className = "status"; status.textContent = "Kimi 正在改良这份食谱…";
      try {
        const data = await api("/api/remix", {
          method: "POST",
          body: JSON.stringify({ id, suggestion: $("#remix-input").value.trim() })
        });
        // 直接发布改良版并跳转
        const saved = await api("/api/recipes", {
          method: "POST",
          body: JSON.stringify({ recipe: data.recipe, author: getAuthor(), parent_id: id })
        });
        openDetail(saved.id);
      } catch (e) {
        status.textContent = "改良失败：" + e.message;
        status.className = "status error";
      } finally { btn.disabled = false; }
    };

    body.querySelectorAll("[data-goto]").forEach(el =>
      el.addEventListener("click", () => openDetail(el.dataset.goto)));

    $("#modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  } catch (e) { alert("加载失败：" + e.message); }
}

$("#modal-close").onclick = closeModal;
$("#modal").addEventListener("click", e => { if (e.target === $("#modal")) closeModal(); });
function closeModal() { $("#modal").classList.add("hidden"); document.body.style.overflow = ""; }

/* ---------- 设置 ---------- */
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("#s-key").value = s.key || "";
    $("#s-model").value = s.model || "";
    $("#s-base").value = s.base_url || "";
    $("#s-author").value = localStorage.getItem("author") || "";
    const status = $("#settings-status");
    status.className = "status";
    status.textContent = s.has_key ? "✅ API Key 已配置" : "⚠️ 尚未配置 API Key，AI 功能不可用";
  } catch { /* 忽略 */ }
}

$("#btn-save-settings").addEventListener("click", async () => {
  const status = $("#settings-status");
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ key: $("#s-key").value, model: $("#s-model").value, base_url: $("#s-base").value })
    });
    localStorage.setItem("author", $("#s-author").value.trim());
    status.textContent = "✅ 已保存";
    status.className = "status";
  } catch (e) {
    status.textContent = "保存失败：" + e.message;
    status.className = "status error";
  }
});

/* 初始加载 */
loadSettings();
