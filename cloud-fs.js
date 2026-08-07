/* ===========================================================================
   cloud-fs.js - makes Supabase look like a folder on disk.

   Every tool in this suite talks to the File System Access API: it asks for a
   directory handle, walks it, reads files and writes them back. That API only
   exists in desktop Chrome and Edge, which is why none of the tools worked on
   a phone.

   Rather than rewrite each tool, this file provides the same shape of object
   the browser would have given them - a directory handle with
   getDirectoryHandle / getFileHandle / entries / values / createWritable /
   removeEntry - backed by the `files` table and the `art` storage bucket.
   Include it after a tool's own script and the tool needs no other change.

   Markdown lives in `files`. Anything under Art/ lives in the `art` bucket,
   with a read-only fallback to the copy published alongside the static site,
   so images that were never uploaded still display.
   =========================================================================== */
(function () {
  "use strict";

  const CFG = window.CDB_CONFIG || {};
  const SLUG = CFG.slug || "character-database";
  const ROOT_NAME = "Character Database";
  const ART_PREFIX = "Art/";
  const ART_BASE = CFG.artBase || "./art/";   // read-only fallback: the copy published with the static site
  const APP_URL = CFG.appUrl || "app.html";

  if (!CFG.url || !CFG.key) {
    console.error("[cloud-fs] config.js missing");
    return;
  }

  /* ------------------------------------------------------------ tiny REST
     No SDK: one dependency-free wrapper is smaller than pulling in
     supabase-js on every tool page, and the session already lives in
     localStorage because app.html put it there. */
  const REST = CFG.url + "/rest/v1/";
  const STORAGE = CFG.url + "/storage/v1/";

  function readToken() {
    // supabase-js v2 stores the session under sb-<project-ref>-auth-token
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      try {
        let raw = localStorage.getItem(k);
        if (raw && raw.startsWith("base64-")) raw = atob(raw.slice(7));
        const v = JSON.parse(raw);
        const s = v && (v.access_token ? v : v.currentSession || v.session);
        if (s && s.access_token) return s;
      } catch (e) { /* not ours */ }
    }
    return null;
  }

  let session = readToken();
  const authHeaders = () => ({
    apikey: CFG.key,
    Authorization: "Bearer " + ((session && session.access_token) || CFG.key),
  });

  async function rest(path, opts) {
    const r = await fetch(REST + path, Object.assign({}, opts, {
      headers: Object.assign({ "Content-Type": "application/json" },
        authHeaders(), (opts && opts.headers) || {}),
    }));
    if (!r.ok) throw new Error("supabase " + r.status + ": " + (await r.text()).slice(0, 200));
    if (r.status === 204) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  function expired() {
    if (!session || !session.expires_at) return false;
    return session.expires_at * 1000 < Date.now() + 30000;
  }
  async function refresh() {
    if (!session || !session.refresh_token) return false;
    const r = await fetch(CFG.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.key },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) return false;
    const s = await r.json();
    session = s;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(k)) { localStorage.setItem(k, JSON.stringify(s)); break; }
    }
    return true;
  }

  /* --------------------------------------------------------- virtual tree */
  const dirNode = (name) => ({ kind: "directory", name, children: new Map() });
  const TREE = dirNode(ROOT_NAME);
  const CONTENT = new Map();   // path -> string (markdown)
  const BLOBS = new Map();     // path -> Blob (art, lazily fetched)
  const DIRTY = new Set();

  function parts(p) { return String(p).split("/").filter(Boolean); }

  function ensureDir(segs) {
    let n = TREE;
    for (const s of segs) {
      if (!n.children.has(s)) n.children.set(s, dirNode(s));
      n = n.children.get(s);
      if (n.kind !== "directory") throw new Error("not a directory: " + s);
    }
    return n;
  }
  function addFile(path) {
    const segs = parts(path);
    const name = segs.pop();
    const dir = ensureDir(segs);
    if (!dir.children.has(name)) dir.children.set(name, { kind: "file", name, path });
    return dir.children.get(name);
  }
  function findNode(path) {
    let n = TREE;
    for (const s of parts(path)) {
      if (n.kind !== "directory" || !n.children.has(s)) return null;
      n = n.children.get(s);
    }
    return n;
  }
  function removeNode(path) {
    const segs = parts(path);
    const name = segs.pop();
    const dir = findNode(segs.join("/"));
    if (dir && dir.kind === "directory") dir.children.delete(name);
  }

  /* --------------------------------------------------------------- typing
     Mirrors build-site.py so the derived `entries` index stays truthful when
     a tool writes through this shim. */
  function typeOf(path) {
    const p = String(path).replace(/\\/g, "/");
    if (p.startsWith("Characters/")) return "character";
    if (p.startsWith("World/Locations/")) return "location";
    if (p.startsWith("World/Factions/")) return "faction";
    if (p.startsWith("Events/")) return "event";
    if (p.startsWith("Stories/")) return p.slice(8).includes("/") ? "chapter" : "story";
    return "world-index";
  }
  const slugify = (s) => String(s || "").toLowerCase().replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";

  function frontmatterOf(text) {
    const t = String(text).replace(/\r\n/g, "\n");
    const out = {};
    if (!t.startsWith("---\n")) return { fm: out, body: t };
    const end = t.indexOf("\n---", 3);
    if (end === -1) return { fm: out, body: t };
    for (const line of t.slice(4, end + 1).split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.startsWith("[")) {
        v = v.replace(/^\[|\]$/g, "").split(",")
          .map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else {
        v = v.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
        if (v === "true") v = true; else if (v === "false") v = false;
      }
      out[m[1]] = v;
    }
    const after = t.indexOf("\n", end + 1);
    return { fm: out, body: after === -1 ? "" : t.slice(after + 1) };
  }
  function stripScratch(body) {
    const out = []; let skip = false;
    for (const line of String(body).split("\n")) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        if (/^scratch\b/i.test(h[2].trim())) { skip = true; continue; }
        if (skip && h[1].length <= 2) skip = false;
      }
      if (!skip) out.push(line);
    }
    return out.join("\n").trim();
  }

  /* --------------------------------------------------------------- loading */
  let WORLD_ID = null;

  async function loadAll() {
    if (expired()) await refresh();

    // Returns your world, claims the original seeded one on first-ever
    // sign-in, or creates a fresh empty world for a brand-new account.
    const w = await rest("rpc/my_world", { method: "POST", body: "{}" });
    const world = Array.isArray(w) ? w[0] : w;
    if (!world || !world.id) throw new Error("could not get or create your world");
    WORLD_ID = world.id;

    const rows = await rest("files?select=path,content&deleted_at=is.null&world_id=eq." + WORLD_ID);
    for (const r of rows) { CONTENT.set(r.path, r.content); addFile(r.path); }

    // Art lives in object storage; list it so the tools can see the folder.
    try {
      const listed = await listStorage(WORLD_ID);
      for (const key of listed) addFile(ART_PREFIX + key.slice(WORLD_ID.length + 1));
    } catch (e) {
      console.warn("[cloud-fs] could not list art bucket:", e.message);
    }
    ensureDir(["Art"]);
  }

  async function listStorage(prefix) {
    const found = [];
    const walk = async (p) => {
      const r = await fetch(STORAGE + "object/list/art", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ prefix: p, limit: 500, offset: 0,
          sortBy: { column: "name", order: "asc" } }),
      });
      if (!r.ok) throw new Error("storage list " + r.status);
      const items = await r.json();
      for (const it of items) {
        const key = p ? p + "/" + it.name : it.name;
        if (it.id === null || it.metadata === null) await walk(key); // folder
        else found.push(key);
      }
    };
    await walk(prefix);
    return found;
  }

  /* Art read: storage first, then the copy published with the static site. */
  async function readArt(path) {
    if (BLOBS.has(path)) return BLOBS.get(path);
    const key = path.slice(ART_PREFIX.length);
    let blob = null;
    try {
      const r = await fetch(STORAGE + "object/art/" + WORLD_ID + "/" + key.split("/").map(encodeURIComponent).join("/"),
        { headers: authHeaders() });
      if (r.ok) blob = await r.blob();
    } catch (e) { /* fall through */ }
    if (!blob) {
      try {
        const r = await fetch(ART_BASE + key.split("/").map(encodeURIComponent).join("/"));
        if (r.ok) blob = await r.blob();
      } catch (e) { /* give up */ }
    }
    if (!blob) blob = new Blob([], { type: "application/octet-stream" });
    BLOBS.set(path, blob);
    return blob;
  }

  async function writeArt(path, blob) {
    const key = path.slice(ART_PREFIX.length);
    const r = await fetch(STORAGE + "object/art/" + WORLD_ID + "/" + key.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: Object.assign({ "x-upsert": "true" }, authHeaders()),
      body: blob,
    });
    if (!r.ok && r.status !== 200) {
      const put = await fetch(STORAGE + "object/art/" + WORLD_ID + "/" + key.split("/").map(encodeURIComponent).join("/"), {
        method: "PUT", headers: authHeaders(), body: blob,
      });
      if (!put.ok) throw new Error("art upload failed: " + put.status);
    }
    BLOBS.set(path, blob);
  }

  async function writeText(path, text) {
    if (expired()) await refresh();
    await rest("files?on_conflict=world_id,path", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        world_id: WORLD_ID, path, content: text,
        updated_at: new Date().toISOString(), deleted_at: null,
      }),
    });
    const { fm, body } = frontmatterOf(text);
    const name = String(fm.name || fm.title || path.split("/").pop().replace(/\.md$/i, ""));
    await rest("entries?on_conflict=world_id,path", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        world_id: WORLD_ID, path, type: typeOf(path), name, slug: slugify(name),
        status: fm.status || null,
        tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
        frontmatter: fm, body_text: stripScratch(body),
        is_private: fm.private === true, deleted_at: null,
      }),
    });
    CONTENT.set(path, text);
  }

  async function deletePath(path) {
    if (path.startsWith(ART_PREFIX)) {
      const key = path.slice(ART_PREFIX.length);
      await fetch(STORAGE + "object/art/" + WORLD_ID + "/" + key.split("/").map(encodeURIComponent).join("/"),
        { method: "DELETE", headers: authHeaders() });
      BLOBS.delete(path);
    } else {
      if (expired()) await refresh();
      await rest("files?world_id=eq." + WORLD_ID + "&path=eq." + encodeURIComponent(path),
        { method: "DELETE" });
      CONTENT.delete(path);
    }
    removeNode(path);
  }

  /* ------------------------------------------------------------- handles */
  function fileHandle(node, fullPath) {
    return {
      kind: "file",
      name: node.name,
      async getFile() {
        let blob;
        if (fullPath.startsWith(ART_PREFIX)) blob = await readArt(fullPath);
        else blob = new Blob([CONTENT.get(fullPath) || ""], { type: "text/markdown" });
        const f = new File([blob], node.name, {
          type: blob.type || "text/markdown", lastModified: Date.now(),
        });
        return f;
      },
      async createWritable() {
        const chunks = [];
        return {
          async write(data) {
            if (data && typeof data === "object" && "data" in data) data = data.data;
            chunks.push(data);
          },
          async truncate() { chunks.length = 0; },
          async seek() { /* whole-file writes only, which is all the tools do */ },
          async close() {
            if (fullPath.startsWith(ART_PREFIX)) {
              await writeArt(fullPath, new Blob(chunks));
            } else {
              let text = "";
              for (const c of chunks) {
                if (typeof c === "string") text += c;
                else if (c instanceof Blob) text += await c.text();
                else text += new TextDecoder().decode(c);
              }
              await writeText(fullPath, text);
            }
            DIRTY.add(fullPath);
          },
          async abort() { chunks.length = 0; },
        };
      },
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async isSameEntry(other) { return other && other.name === node.name; },
    };
  }

  function dirHandle(node, prefix) {
    const full = (name) => (prefix ? prefix + "/" + name : name);
    const h = {
      kind: "directory",
      name: node.name,
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async isSameEntry(other) { return other && other.name === node.name; },
      async getDirectoryHandle(name, opts) {
        let child = node.children.get(name);
        if (!child) {
          if (!(opts && opts.create)) {
            const err = new Error("no directory " + name);
            err.name = "NotFoundError";
            throw err;
          }
          child = dirNode(name);
          node.children.set(name, child);
        }
        if (child.kind !== "directory") {
          const err = new Error(name + " is a file");
          err.name = "TypeMismatchError";
          throw err;
        }
        return dirHandle(child, full(name));
      },
      async getFileHandle(name, opts) {
        let child = node.children.get(name);
        if (!child) {
          if (!(opts && opts.create)) {
            const err = new Error("no file " + name);
            err.name = "NotFoundError";
            throw err;
          }
          child = { kind: "file", name, path: full(name) };
          node.children.set(name, child);
          if (!full(name).startsWith(ART_PREFIX)) CONTENT.set(full(name), "");
        }
        if (child.kind !== "file") {
          const err = new Error(name + " is a directory");
          err.name = "TypeMismatchError";
          throw err;
        }
        return fileHandle(child, full(name));
      },
      async removeEntry(name, opts) {
        const child = node.children.get(name);
        if (!child) {
          const err = new Error("no entry " + name);
          err.name = "NotFoundError";
          throw err;
        }
        if (child.kind === "file") { await deletePath(full(name)); return; }
        const collect = (n, p, acc) => {
          for (const [k, v] of n.children) {
            if (v.kind === "file") acc.push(p + "/" + k); else collect(v, p + "/" + k, acc);
          }
          return acc;
        };
        const inside = collect(child, full(name), []);
        if (inside.length && !(opts && opts.recursive)) {
          const err = new Error("directory not empty");
          err.name = "InvalidModificationError";
          throw err;
        }
        for (const p of inside) await deletePath(p);
        node.children.delete(name);
      },
      async *entries() {
        for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          yield [name, child.kind === "directory" ? dirHandle(child, full(name)) : fileHandle(child, full(name))];
        }
      },
      async *values() {
        for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          yield child.kind === "directory" ? dirHandle(child, full(name)) : fileHandle(child, full(name));
        }
      },
      async *keys() {
        for (const name of [...node.children.keys()].sort()) yield name;
      },
    };
    h[Symbol.asyncIterator] = h.entries;
    return h;
  }

  /* ---------------------------------------------------------------- boot */
  const ROOT = dirHandle(TREE, "");
  window.CDB_CLOUD = { root: ROOT, reload, isCloud: true };

  // Tools feature-detect with `typeof window.showDirectoryPicker === "function"`.
  window.showDirectoryPicker = async function () { return ROOT; };

  async function reload() {
    TREE.children.clear(); CONTENT.clear(); BLOBS.clear();
    await loadAll();
    return ROOT;
  }

  /* Every tool in the suite has the same connect-folder button (#btnConnect,
     with #fsDot / #fsLabel). In the cloud there is no folder to connect - the
     thing you connect is your account - so repurpose it as a sign-in button.
     Cloning the node drops the tool's own connectFolder handler. */
  function restyleAuthUI(signedIn) {
    const goApp = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } location.href = APP_URL; };
    const btn = document.getElementById("btnConnect");
    if (btn) {
      const clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
      clone.addEventListener("click", goApp);
      // Some tools keep the label inside the button; others give the button
      // its own text. Only relabel the ones that do.
      if (!clone.querySelector("#fsLabel")) clone.textContent = signedIn ? "Account" : "Sign in";
      clone.title = signedIn ? "Signed in - manage your account" : "Sign in to load your world";
    }
    if (!signedIn) {
      const label = document.getElementById("fsLabel");
      const dot = document.getElementById("fsDot");
      if (label) { label.textContent = "Sign in"; label.style.cursor = "pointer"; label.onclick = goApp; }
      if (dot) dot.className = "dot warn";
    }
  }

  function banner(msg, kind) {
    let el = document.getElementById("cdbCloudBanner");
    if (!el) {
      el = document.createElement("div");
      el.id = "cdbCloudBanner";
      // Bottom of the screen, not the top - the tools keep their own header
      // up there, and on a phone a top banner sits exactly on the sign-in
      // button it is pointing at.
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;" +
        "padding:10px 14px calc(10px + env(safe-area-inset-bottom));" +
        "font:14px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 -4px 16px rgba(0,0,0,.35);";
      document.body.appendChild(el);
    }
    el.style.background = kind === "err" ? "#7a2b2b" : "#2b4a7a";
    el.style.color = "#fff";
    el.innerHTML = msg;
  }

  async function start() {
    session = readToken();
    if (!session) {
      const next = encodeURIComponent(location.pathname.split("/").pop() + location.hash);
      banner('Not signed in. <a style="color:#fff" href="' + APP_URL + '?next=' + next + '">Sign in</a> to load your world.', "err");
      restyleAuthUI(false);
      return;
    }
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      banner("Could not load from the cloud: " + (err.message || err), "err");
      return;
    }
    // Hand the tool its folder, exactly as if the user had picked one.
    for (let i = 0; i < 40 && typeof window.useFolder !== "function"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (typeof window.useFolder === "function") {
      try { await window.useFolder(ROOT, true); } catch (e) { console.error("[cloud-fs] useFolder", e); }
    } else {
      console.warn("[cloud-fs] this page has no useFolder(); showDirectoryPicker still works");
    }
    restyleAuthUI(true);
    const b = document.getElementById("cdbCloudBanner");
    if (b) b.remove();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0));
  } else {
    setTimeout(start, 0);
  }
})();
