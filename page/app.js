const $ = (id) => document.getElementById(id);

function text(value) {
  if (value === undefined || value === null || value === "") return "(none)";
  return String(value);
}

function renderDl(node, entries) {
  node.innerHTML = "";
  for (const [key, value] of entries) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = text(value);
    node.append(dt, dd);
  }
}

function result(title, meta, body) {
  const node = document.createElement("div");
  node.className = "result";
  node.innerHTML = `
    <div class="result-title"></div>
    <div class="result-meta"></div>
    <div class="result-body"></div>
  `;
  node.querySelector(".result-title").textContent = title;
  node.querySelector(".result-meta").textContent = meta;
  node.querySelector(".result-body").textContent = body;
  return node;
}

async function loadStatus() {
  const status = await fetch("/api/status").then((r) => r.json());
  $("setup").innerHTML = "";
  for (const command of status.setup || []) {
    const li = document.createElement("li");
    li.textContent = command;
    $("setup").append(li);
  }

  renderDl($("embeddings"), [
    ["provider", status.embeddings?.provider],
    ["model", status.embeddings?.model],
    ["cache", status.embeddings?.cache_dir],
    ["available", status.embeddings?.available],
    ["paid", status.embeddings?.paid],
    ["approval", status.embeddings?.approved],
    ["indexed", status.embeddings?.indexed_current_model],
    ["pending", status.embeddings?.pending_current_model],
  ]);
  renderDl($("graph"), [
    ["fresh", status.graph?.is_fresh ?? status.graph?.status],
    ["nodes", status.graph?.node_count],
    ["edges", status.graph?.edge_count],
    ["built", status.graph?.created_at ?? status.graph?.updated_at],
    ["commit", status.graph?.built_at_commit],
  ]);

  $("counts").innerHTML = "";
  for (const [name, count] of Object.entries(status.counts || {})) {
    const node = document.createElement("div");
    node.className = "count";
    node.innerHTML = `<strong></strong><span></span>`;
    node.querySelector("strong").textContent = count;
    node.querySelector("span").textContent = name;
    $("counts").append(node);
  }
}

async function runSearch(event) {
  event.preventDefault();
  const q = $("search-input").value.trim();
  if (!q) return;
  const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  const out = $("search-results");
  out.innerHTML = "";
  for (const doc of data.docs || []) {
    out.append(result(doc.source_path || "doc chunk", `doc score ${doc.score}`, doc.excerpt || ""));
  }
  for (const file of data.files || []) {
    out.append(result(file.path || "file", `file score ${file.score}`, file.excerpt || ""));
  }
  for (const memory of data.memories || []) {
    out.append(result(memory.summary || "memory", `${memory.kind} score ${memory.score}`, ""));
  }
  if (!out.children.length) out.append(result("No results", "search", "Try a more specific task or run ingest first."));
}

async function runContext(event) {
  event.preventDefault();
  const task = $("context-input").value.trim();
  if (!task) return;
  const data = await fetch(`/api/context?task=${encodeURIComponent(task)}`).then((r) => r.json());
  const out = $("context-results");
  out.innerHTML = "";
  if (data.error) {
    out.append(result("Context preview failed", "error", data.error));
    return;
  }
  out.append(result(
    `Mode: ${data.query_plan?.mode || "hybrid"}`,
    `${data.token_budget?.estimated_tokens || 0}/${data.token_budget?.target_tokens || 0} estimated tokens`,
    Object.entries(data.counts || {}).map(([k, v]) => `${k}: ${v}`).join("  "),
  ));
  for (const channel of data.query_plan?.channels || []) {
    out.append(result(channel.channel, `${channel.target_items} target items`, channel.reason));
  }
}

$("refresh").addEventListener("click", loadStatus);
$("search-form").addEventListener("submit", runSearch);
$("context-form").addEventListener("submit", runContext);
loadStatus().catch((err) => {
  $("counts").innerHTML = "";
  $("counts").append(result("Status failed", "error", err.message));
});
