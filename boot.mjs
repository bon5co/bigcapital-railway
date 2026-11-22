// BigCapital on Railway. Order matters: migrate the databases, start the API on its own private port with sign-up closed to everyone but
// ADMIN_EMAIL, create that owner, and only then open the public port. A green healthcheck therefore means a deploy that already has its
// owner and is already closed to strangers. A redeploy finds the owner in place and skips the sign-up.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const log = (m) => console.log(`[railway-boot] ${m}`);
const die = (m) => { console.error(`[railway-boot] ${m}`); process.exit(1); };
const need = (n) => process.env[n] || die(`${n} is required`);

const ADMIN_EMAIL = need("ADMIN_EMAIL");
const ADMIN_PASSWORD = need("ADMIN_PASSWORD");
for (const n of ["DB_HOST", "DB_USER", "DB_PASSWORD", "REDIS_HOST", "APP_JWT_SECRET", "GOTENBERG_URL"]) need(n);
if (ADMIN_PASSWORD.length < 10) die("ADMIN_PASSWORD must be at least 10 characters");

// Railway injects PORT (8080) into every service and the healthcheck dials it, so PORT belongs to the public front door alone.
const PUBLIC_PORT = Number(process.env.PORT || 8080);
const API_PORT = 3000;
const WEB_ROOT = "/app/webapp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server's queue connects to QUEUE_HOST, the cache and rate limiter to REDIS_HOST: same Redis.
const childEnv = {
  ...process.env,
  PORT: String(API_PORT),
  QUEUE_HOST: process.env.REDIS_HOST,
  QUEUE_PORT: process.env.REDIS_PORT || "6379",
  SIGNUP_DISABLED: "true",
  SIGNUP_ALLOWED_EMAILS: ADMIN_EMAIL,
};
delete childEnv.SIGNUP_ALLOWED_DOMAINS;

// 1. Migrations. They need the database up, which on a cold project is often not yet the case, so retry.
for (const cmd of ["system:migrate:latest", "tenants:migrate:latest"]) {
  for (let n = 1; ; n++) {
    const r = spawnSync("node", ["dist/cli.js", cmd], { cwd: "/app/packages/server", env: childEnv, stdio: "inherit" });
    if (r.status === 0) { log(`${cmd} done`); break; }
    if (n >= 60) die(`${cmd} still failing after ${n} attempts`);
    log(`${cmd} failed (attempt ${n}); database not ready yet, retrying in 5s`);
    await sleep(5000);
  }
}

// 2. API on a private port.
const api = spawn("node", ["packages/server/dist/main.js"], { cwd: "/app", env: childEnv, stdio: "inherit" });
let apiExited = false;
api.on("exit", (code) => { apiExited = true; log(`api exited with ${code}`); process.exit(code || 1); });
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => api.kill(s));

const call = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
};

for (let n = 0; ; n++) {
  if (apiExited) die("api exited before it became ready");
  try { if ((await call("GET", "/api/system_db")).status === 200) break; } catch {}
  if (n > 600) die("api did not answer /api/system_db within 600s");
  await sleep(1000);
}
log("api is answering");

// 3. Owner. Sign-up is restricted to ADMIN_EMAIL, and the public port is not open yet.
const signup = await call("POST", "/api/auth/signup", {
  firstName: "Admin", lastName: "Owner", email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
});
if (signup.status >= 200 && signup.status < 300) log(`owner account created for ${ADMIN_EMAIL}`);
else if (signup.text.includes("EMAIL_EXISTS")) log("owner bootstrap skipped: the account already exists");
else die(`owner bootstrap failed: HTTP ${signup.status} ${signup.text.slice(0, 300)}`);

// 4. Public front door: static web app, /api to the server. One response is rewritten: the refusal a stranger gets from the closed sign-up
// is a 4xx the app words as a validation error; a stranger's sign-up is reported as 403 so a client reads it as "forbidden".
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
const isSignup = (req) => req.method === "POST" && req.url.split("?")[0].replace(/\/+$/, "") === "/api/auth/signup";

const serveStatic = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); return res.end(); }
  let rel = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(WEB_ROOT, path.normalize(rel));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_ROOT, "index.html");
  const ext = path.extname(file).toLowerCase();
  const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": cache });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
};

const server = http.createServer((req, res) => {
  if (!req.url.startsWith("/api/") && req.url !== "/api") return serveStatic(req, res);
  const up = http.request({ host: "127.0.0.1", port: API_PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
    if (isSignup(req) && r.statusCode >= 400) {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks);
        const refused = /SIGNUP_RESTRICTED/.test(body.toString("utf8"));
        res.writeHead(refused ? 403 : r.statusCode, { ...r.headers, "content-length": body.length });
        res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream unavailable"); });
  req.pipe(up);
});
server.listen(PUBLIC_PORT, "::", () => log(`public port ${PUBLIC_PORT} open`));
