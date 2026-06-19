/**
 * Articulated Spiral Builder — Deno web server
 * --------------------------------------------------------------------------
 *  • Serves the single-page app (index.html + any static assets).
 *  • REST API for project CRUD, persisted to a single JSON file (data/projects.json).
 *
 *  Run:   deno task start          (see deno.json)
 *    or:  deno run --allow-net --allow-read --allow-write server.ts
 *
 *  A "project" is just a saved app configuration (alignment geometry, pin/hole
 *  points, slider values). The list endpoint returns lightweight summaries;
 *  the heavy geometry is only sent when a single project is fetched.
 */

const PORT = Number(Deno.env.get("PORT") ?? 8005);
const ROOT = new URL("./", import.meta.url);            // dir this file lives in
const DATA_DIR = new URL("./data/", import.meta.url);
const DB_FILE = new URL("./data/projects.json", import.meta.url);
const MESH_DIR = new URL("./data/meshes/", import.meta.url);   // uploaded part meshes

const MESH_EXT = new Set(["stl", "glb", "gltf"]);
const MAX_MESH_BYTES = 64 * 1024 * 1024;                       // 64 MB upload cap

/* ----------------------------- types ----------------------------- */
interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;   // gatherConfig() payload from the client
}
type DB = Record<string, Project>;

/* --------------------------- JSON storage ------------------------- */
async function ensureStore() {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  await Deno.mkdir(MESH_DIR, { recursive: true });
  try { await Deno.stat(DB_FILE); }
  catch { await Deno.writeTextFile(DB_FILE, "{}\n"); }
}
async function readDB(): Promise<DB> {
  try { return JSON.parse(await Deno.readTextFile(DB_FILE)) as DB; }
  catch { return {}; }
}
// Serialize writes so concurrent requests can't corrupt the file.
let writeChain: Promise<void> = Promise.resolve();
function writeDB(db: DB): Promise<void> {
  writeChain = writeChain.then(() =>
    Deno.writeTextFile(DB_FILE, JSON.stringify(db, null, 2)),
  );
  return writeChain;
}

/* a slim summary for the list view (no bulky geometry) */
function summarize(p: Project) {
  const cfg = (p.config ?? {}) as Record<string, any>;
  const params = (cfg.params ?? {}) as Record<string, any>;
  return {
    id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
    links: params.count ?? null,
    // meshId references an uploaded file in data/meshes/; geometry[] is the legacy inline form
    hasGeometry: !!cfg.meshId || (Array.isArray(cfg.geometry) && cfg.geometry.length > 0),
  };
}

/* --------------------------- HTTP helpers ------------------------- */
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
const err = (msg: string, status = 400) => json({ error: msg }, status);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", ico: "image/x-icon",
  stl: "model/stl", glb: "model/gltf-binary",
};
async function serveStatic(pathname: string): Promise<Response> {
  // map "/" → index.html; prevent path traversal
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) return err("bad path", 400);
  try {
    const fileUrl = new URL(rel, ROOT);
    const body = await Deno.readFile(fileUrl);
    const ext = rel.split(".").pop()!.toLowerCase();
    return new Response(body, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    return err("not found", 404);
  }
}

/* ----------------------- meshes (uploaded parts) ----------------------- */
// A mesh id is just its on-disk filename: "<uuid>.<ext>". We generate it, so
// it can't contain path separators — but re-validate on read to be safe.
async function handleMeshes(req: Request, parts: string[]): Promise<Response> {
  const id = parts[1];

  // POST /api/meshes  → store raw bytes, return { id, name, url }
  if (!id) {
    if (req.method !== "POST") return err("method not allowed", 405);
    const name = (req.headers.get("x-filename") ?? "part.stl").toString();
    const ext = name.split(".").pop()?.toLowerCase() ?? "stl";
    if (!MESH_EXT.has(ext)) return err(`unsupported mesh type: .${ext}`);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return err("empty upload");
    if (bytes.length > MAX_MESH_BYTES) return err("mesh too large", 413);
    const fileId = `${crypto.randomUUID()}.${ext}`;
    await Deno.writeFile(new URL(fileId, MESH_DIR), bytes);
    return json({ id: fileId, name, url: `/api/meshes/${fileId}` }, 201);
  }

  // GET /api/meshes/:id  → serve the stored mesh
  if (req.method !== "GET") return err("method not allowed", 405);
  if (id.includes("/") || id.includes("..") || !MESH_EXT.has(id.split(".").pop()!.toLowerCase()))
    return err("bad mesh id", 400);
  try {
    const body = await Deno.readFile(new URL(id, MESH_DIR));
    const ext = id.split(".").pop()!.toLowerCase();
    return new Response(body, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    return err("mesh not found", 404);
  }
}

/* ------------------------------ API ------------------------------ */
async function handleApi(req: Request, parts: string[]): Promise<Response> {
  // parts = ["projects"] or ["projects", id]
  if (parts[0] === "meshes") return await handleMeshes(req, parts);
  if (parts[0] !== "projects") return err("unknown endpoint", 404);
  const id = parts[1];
  const db = await readDB();

  // /api/projects  (collection)
  if (!id) {
    if (req.method === "GET") {
      const list = Object.values(db)
        .map(summarize)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return json(list);
    }
    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return err("invalid JSON body"); }
      const name = (body?.name ?? "").toString().trim();
      if (!name) return err("project name is required");
      const now = new Date().toISOString();
      const proj: Project = {
        id: crypto.randomUUID(), name, createdAt: now, updatedAt: now,
        config: body?.config ?? {},
      };
      db[proj.id] = proj;
      await writeDB(db);
      return json(proj, 201);
    }
    return err("method not allowed", 405);
  }

  // /api/projects/:id  (item)
  const existing = db[id];
  if (req.method === "GET") {
    return existing ? json(existing) : err("project not found", 404);
  }
  if (req.method === "PUT" || req.method === "PATCH") {
    if (!existing) return err("project not found", 404);
    let body: any;
    try { body = await req.json(); } catch { return err("invalid JSON body"); }
    if (typeof body?.name === "string" && body.name.trim()) existing.name = body.name.trim();
    if (body?.config !== undefined) existing.config = body.config;
    existing.updatedAt = new Date().toISOString();
    db[id] = existing;
    await writeDB(db);
    return json(existing);
  }
  if (req.method === "DELETE") {
    if (!existing) return err("project not found", 404);
    delete db[id];
    await writeDB(db);
    return json({ ok: true, id });
  }
  return err("method not allowed", 405);
}

/* ---------------------------- router ----------------------------- */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (parts[0] === "api") return await handleApi(req, parts.slice(1));
    if (req.method !== "GET") return err("method not allowed", 405);
    return await serveStatic(url.pathname);
  } catch (e) {
    console.error(e);
    return err("internal error: " + (e instanceof Error ? e.message : String(e)), 500);
  }
}

await ensureStore();
console.log(`\n  Articulated Spiral Builder`);
console.log(`  ▸ http://localhost:${PORT}`);
console.log(`  ▸ projects stored in ${DB_FILE.pathname}\n`);
Deno.serve({ port: PORT }, handler);
