import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDist, validateSite } from "./check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const OG_FILE = "og-bhasya-1200x630.png";

const ENV = process.env.SITE_ENV || "preview";
const INDEXABLE = process.env.SITE_INDEXABLE === "1";
const ALLOW_PLACEHOLDERS = ENV === "local" && process.env.SITE_ALLOW_PLACEHOLDERS === "1";

function fail(message) {
  throw new Error(message);
}

function parseProductionOrigin(raw) {
  if (!raw) fail("SITE_ORIGIN is required when SITE_ENV=production");
  if (!/^https:\/\//i.test(raw)) fail("SITE_ORIGIN must use HTTPS");

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("SITE_ORIGIN is not a valid URL");
  }

  if (url.username || url.password) fail("SITE_ORIGIN must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    fail("SITE_ORIGIN must be an origin only, without a path, query, or hash");
  }

  const host = url.hostname.toLowerCase();
  const forbidden =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".pages.dev") ||
    host.endsWith(".workers.dev");

  if (forbidden) {
    fail("SITE_ORIGIN must not be a staging, local, pages.dev, or workers.dev host");
  }

  return url.origin;
}

function replaceToken(html, token, replacement) {
  if (!html.includes(token)) fail(`Missing build token ${token}`);
  return html.replace(token, replacement);
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function build() {
  if (!["local", "preview", "production"].includes(ENV)) {
    fail("SITE_ENV must be local, preview, or production");
  }

  if (ENV !== "production" && INDEXABLE) {
    fail("SITE_INDEXABLE=1 is only allowed when SITE_ENV=production");
  }

  let origin = null;
  if (ENV === "production") {
    if (!INDEXABLE) fail("SITE_ENV=production requires SITE_INDEXABLE=1");
    origin = parseProductionOrigin(process.env.SITE_ORIGIN);
  }

  validateSite({
    env: ENV,
    allowPlaceholders: ALLOW_PLACEHOLDERS,
    requireScreenshots: ENV !== "local",
  });

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const canonical = origin
    ? `<link rel="canonical" href="${escapeAttribute(`${origin}/`)}">`
    : "";
  const ogUrl = origin
    ? `<meta property="og:url" content="${escapeAttribute(`${origin}/`)}">`
    : "";
  const ogImage = origin
    ? [
        `<meta property="og:image" content="${escapeAttribute(`${origin}/assets/screenshots/${OG_FILE}`)}">`,
        '  <meta property="og:image:width" content="1200">',
        '  <meta property="og:image:height" content="630">',
        '  <meta property="og:image:alt" content="Bhasya reader showing highlighted passages and a highlights list beside the document.">',
      ].join("\n  ")
    : "";
  const twitterImage = origin
    ? `<meta name="twitter:image" content="${escapeAttribute(`${origin}/assets/screenshots/${OG_FILE}`)}">\n  <meta name="twitter:image:alt" content="Bhasya reader showing highlighted passages and a highlights list beside the document.">`
    : "";

  let html = source;
  html = replaceToken(html, "<!-- BUILD:CANONICAL -->", canonical);
  html = replaceToken(html, "<!-- BUILD:OG_URL -->", ogUrl);
  html = replaceToken(html, "<!-- BUILD:OG_IMAGE -->", ogImage);
  html = replaceToken(html, "<!-- BUILD:TWITTER_IMAGE -->", twitterImage);
  html = html.replace(
    /<meta name="robots" content="noindex, nofollow" data-build-robots>/,
    origin
      ? '<meta name="robots" content="index, follow, max-image-preview:large">'
      : '<meta name="robots" content="noindex, nofollow">',
  );

  fs.writeFileSync(path.join(DIST, "index.html"), html);
  fs.copyFileSync(path.join(ROOT, "404.html"), path.join(DIST, "404.html"));
  fs.cpSync(path.join(ROOT, "assets"), path.join(DIST, "assets"), { recursive: true });

  const robots = origin
    ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
    : "User-agent: *\nAllow: /\n";
  fs.writeFileSync(path.join(DIST, "robots.txt"), robots);

  if (origin) {
    const sitemap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <url><loc>${origin}/</loc></url>`,
      "</urlset>",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);
  }

  const csp = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");

  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    `  Content-Security-Policy: ${csp}`,
    "  Cache-Control: public, max-age=0, must-revalidate",
    ...(origin ? [] : ["  X-Robots-Tag: noindex, nofollow"]),
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=604800",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(DIST, "_headers"), headers);

  validateDist({ env: ENV, origin: origin ?? "" });

  console.log(`Built website to ${DIST}`);
  console.log(
    `env=${ENV}, indexable=${origin ? "yes" : "no"}, origin=${origin ?? "none"}, placeholders=${ALLOW_PLACEHOLDERS ? "allowed" : "rejected"}`,
  );
}

try {
  build();
} catch (error) {
  console.error(`Website build failed: ${error.message}`);
  process.exitCode = 1;
}
