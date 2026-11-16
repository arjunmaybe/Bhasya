import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const SCREENSHOT_DIR = path.join(ROOT, "assets", "screenshots");

const EXPECTED_SCREENSHOTS = [
  "reader-highlight",
  "passage-thread",
  "resume-reading",
];
const SCREENSHOT_WIDTHS = [1440, 720];
const SCREENSHOT_HEIGHTS = new Map([
  [1440, 900],
  [720, 450],
]);
const SCREENSHOT_FORMATS = ["avif", "webp"];
const OG_FILE = "og-bhasya-1200x630.png";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

function normalizeAssetUrl(value) {
  return value
    .split("#")[0]
    .split("?")[0]
    .replace(/^\.\//, "/");
}

function parseSrcset(value) {
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return {
        url: normalizeAssetUrl(url),
        descriptor: descriptor.join(" "),
      };
    });
}

function screenshotFile(name, width, format) {
  return `${name}-${width}.${format}`;
}

function screenshotPath(name, width, format) {
  return `/assets/screenshots/${screenshotFile(name, width, format)}`;
}

function assertLocalAsset(relativePath, context) {
  let target = path.join(ROOT, relativePath.replace(/^\/+/, ""));
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  assert(fs.existsSync(target), `${context}: missing local asset ${relativePath}`);
}

function checkLocalReferences(html, sourceFile) {
  for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
    const href = match[1];
    if (
      href === "" ||
      href.startsWith("#") ||
      href.startsWith("//") ||
      /^(https?:|mailto:|tel:|data:)/i.test(href)
    ) {
      continue;
    }
    const clean = href.split("#")[0].split("?")[0];
    if (clean) assertLocalAsset(clean, sourceFile);
  }

  for (const match of html.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) {
    const value = match[1];
    if (/^data:/i.test(value)) continue;
    for (const candidate of value.split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (!url || /^(https?:|\/\/)/i.test(url)) continue;
      assertLocalAsset(url, sourceFile);
    }
  }
}

function checkImages(html, sourceFile) {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    assert(/\balt="[^"]+"/.test(tag), `${sourceFile}: image is missing useful alt text`);
    assert(/\bwidth="\d+"/.test(tag), `${sourceFile}: image is missing width`);
    assert(/\bheight="\d+"/.test(tag), `${sourceFile}: image is missing height`);
  }
}

function readWebpDimensions(bytes, label) {
  assert(bytes.length >= 30, `${label}: WebP file is truncated`);
  assert(
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
    `${label}: not a WebP image`,
  );

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.subarray(offset, offset + 4).toString("latin1");
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    assert(payload + size <= bytes.length, `${label}: truncated WebP chunk ${fourcc}`);

    if (fourcc === "VP8X") {
      assert(size >= 10, `${label}: VP8X chunk is too short`);
      return {
        width: 1 + bytes.readUIntLE(payload + 4, 3),
        height: 1 + bytes.readUIntLE(payload + 7, 3),
      };
    }

    if (fourcc === "VP8 " && size >= 10) {
      assert(
        bytes[payload + 3] === 0x9d &&
          bytes[payload + 4] === 0x01 &&
          bytes[payload + 5] === 0x2a,
        `${label}: invalid VP8 frame header`,
      );
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
      };
    }

    if (fourcc === "VP8L" && size >= 5) {
      assert(bytes[payload] === 0x2f, `${label}: invalid VP8L signature`);
      const bits = bytes.readUInt32LE(payload + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    offset = payload + size + (size % 2);
  }

  fail(`${label}: no WebP dimensions found`);
}

function findAvifIspe(bytes, start, end, label) {
  let offset = start;

  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    let headerSize = 8;

    if (size === 1) {
      assert(offset + 16 <= end, `${label}: truncated ISO BMFF box ${type}`);
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      assert(
        largeSize <= BigInt(Number.MAX_SAFE_INTEGER),
        `${label}: ISO BMFF box ${type} is too large`,
      );
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    assert(size >= headerSize, `${label}: invalid ISO BMFF box size for ${type}`);
    const boxEnd = offset + size;
    assert(boxEnd <= end, `${label}: truncated ISO BMFF box ${type}`);
    const payload = offset + headerSize;

    if (type === "ispe") {
      assert(payload + 12 <= boxEnd, `${label}: truncated ispe box`);
      return {
        width: bytes.readUInt32BE(payload + 4),
        height: bytes.readUInt32BE(payload + 8),
      };
    }

    if (type === "meta") {
      assert(payload + 4 <= boxEnd, `${label}: truncated meta box`);
      const found = findAvifIspe(bytes, payload + 4, boxEnd, label);
      if (found) return found;
    } else if (type === "iprp" || type === "ipco") {
      const found = findAvifIspe(bytes, payload, boxEnd, label);
      if (found) return found;
    }

    offset = boxEnd;
  }

  return null;
}

function readAvifDimensions(bytes, label) {
  assert(bytes.length >= 16, `${label}: AVIF file is truncated`);
  assert(bytes.subarray(4, 8).toString("latin1") === "ftyp", `${label}: not an AVIF image`);

  const ftypSize = bytes.readUInt32BE(0);
  assert(ftypSize >= 16 && ftypSize <= bytes.length, `${label}: invalid AVIF ftyp box`);
  const brand = bytes.subarray(8, 12).toString("latin1");
  const compatibleBrands = bytes.subarray(16, ftypSize).toString("latin1");
  assert(
    brand === "avif" ||
      brand === "avis" ||
      compatibleBrands.includes("avif") ||
      compatibleBrands.includes("avis"),
    `${label}: ftyp does not identify an AVIF image`,
  );

  const dimensions = findAvifIspe(bytes, 0, bytes.length, label);
  assert(dimensions, `${label}: no AVIF ispe dimensions found`);
  return dimensions;
}

export function readImageDimensions(bytes, format, label = "image") {
  if (format === "webp") return readWebpDimensions(bytes, label);
  if (format === "avif") return readAvifDimensions(bytes, label);
  fail(`${label}: unsupported image format ${format}`);
}

function checkPng(filePath, label) {
  const bytes = fs.readFileSync(filePath);
  assert(bytes.length > 1024, `${label} is unexpectedly small`);
  assert(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `${label} is not a PNG`,
  );
  assert(bytes.subarray(12, 16).toString("latin1") === "IHDR", `${label} is missing an IHDR chunk`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width === 1200 && height === 630, `${label} must be 1200x630, got ${width}x${height}`);
}

function checkScreenshotFile(name, width, format) {
  const file = screenshotFile(name, width, format);
  const absolute = path.join(SCREENSHOT_DIR, file);
  assert(fs.existsSync(absolute), `missing screenshot asset: assets/screenshots/${file}`);

  const bytes = fs.readFileSync(absolute);
  assert(bytes.length > 1024, `screenshot asset is unexpectedly small: ${file}`);

  const dimensions = readImageDimensions(bytes, format, file);
  const expectedHeight = SCREENSHOT_HEIGHTS.get(width);
  assert(expectedHeight, `no expected height configured for screenshot width ${width}`);
  assert(
    dimensions.width === width && dimensions.height === expectedHeight,
    `${file}: expected ${width}x${expectedHeight}, got ${dimensions.width}x${dimensions.height}`,
  );
}

function assertScreenshotSrcset(name, format, srcset, label) {
  const candidates = parseSrcset(srcset);
  assert(
    candidates.length === 2,
    `${name}: ${label} must contain exactly two candidates, got ${candidates.length}`,
  );

  const expected = new Map([
    [screenshotPath(name, 720, format), "720w"],
    [screenshotPath(name, 1440, format), "1440w"],
  ]);
  const seenUrls = new Set();
  const seenDescriptors = new Set();

  for (const candidate of candidates) {
    assert(
      !seenUrls.has(candidate.url),
      `${name}: ${label} contains duplicate candidate ${candidate.url}`,
    );
    seenUrls.add(candidate.url);

    assert(
      expected.has(candidate.url),
      `${name}: ${label} contains unexpected candidate ${candidate.url}`,
    );

    assert(
      !seenDescriptors.has(candidate.descriptor),
      `${name}: ${label} contains duplicate descriptor ${candidate.descriptor}`,
    );
    seenDescriptors.add(candidate.descriptor);

    assert(
      candidate.descriptor === expected.get(candidate.url),
      `${name}: ${label} must describe ${candidate.url} as ${expected.get(candidate.url)}, got ${
        candidate.descriptor || "(none)"
      }`,
    );
  }

  for (const [url, descriptor] of expected) {
    assert(seenUrls.has(url), `${name}: ${label} must reference ${url}`);
    assert(
      seenDescriptors.has(descriptor),
      `${name}: ${label} must include the ${descriptor} descriptor`,
    );
  }
}

export function checkScreenshotPictures(html) {
  const pictures = [...html.matchAll(/<picture\b([^>]*)>([\s\S]*?)<\/picture>/gi)].map(
    (match) => ({
      attributes: match[1],
      body: match[2],
    }),
  );

  const picturesByName = new Map();
  for (const picture of pictures) {
    const name = getAttribute(picture.attributes, "data-screenshot");
    assert(name, "every screenshot <picture> must have a data-screenshot attribute");
    assert(
      EXPECTED_SCREENSHOTS.includes(name),
      `unexpected data-screenshot value: ${name}`,
    );
    assert(!picturesByName.has(name), `duplicate screenshot <picture> for ${name}`);
    picturesByName.set(name, picture);
  }

  for (const name of EXPECTED_SCREENSHOTS) {
    const picture = picturesByName.get(name);
    assert(picture, `index.html is missing <picture data-screenshot="${name}">`);

    const sources = [...picture.body.matchAll(/<source\b([^>]*)>/gi)].map((match) => match[1]);
    const typedSources = sources.map((source) => ({
      source,
      type: (getAttribute(source, "type") || "").toLowerCase(),
    }));

    const avifSources = typedSources.filter((item) => item.type === "image/avif");
    const webpSources = typedSources.filter((item) => item.type === "image/webp");

    assert(
      typedSources.length === 2,
      `${name}: <picture> may only contain one AVIF and one WebP <source>`,
    );
    assert(
      avifSources.length === 1,
      `${name}: must contain exactly one AVIF <source>, got ${avifSources.length}`,
    );
    assert(
      webpSources.length === 1,
      `${name}: must contain exactly one WebP <source>, got ${webpSources.length}`,
    );

    const avifIndex = typedSources.findIndex((item) => item.type === "image/avif");
    const webpIndex = typedSources.findIndex((item) => item.type === "image/webp");
    assert(avifIndex < webpIndex, `${name}: AVIF <source> must come before WebP`);

    const avifSrcset = getAttribute(avifSources[0].source, "srcset");
    assert(avifSrcset, `${name}: AVIF <source> is missing srcset`);
    assertScreenshotSrcset(name, "avif", avifSrcset, "AVIF srcset");

    const avifSizes = getAttribute(avifSources[0].source, "sizes");
    assert(avifSizes, `${name}: AVIF <source> is missing sizes`);

    const webpSrcset = getAttribute(webpSources[0].source, "srcset");
    assert(webpSrcset, `${name}: WebP <source> is missing srcset`);
    assertScreenshotSrcset(name, "webp", webpSrcset, "WebP srcset");

    const webpSizes = getAttribute(webpSources[0].source, "sizes");
    assert(webpSizes, `${name}: WebP <source> is missing sizes`);

    const imgTag = picture.body.match(/<img\b[^>]*>/i)?.[0];
    assert(imgTag, `${name}: <picture> is missing its <img> fallback`);

    const imgSrc = getAttribute(imgTag, "src");
    assert(
      imgSrc && normalizeAssetUrl(imgSrc) === screenshotPath(name, 1440, "webp"),
      `${name}: <img> src must be ${screenshotPath(name, 1440, "webp")}`,
    );

    const imgSrcset = getAttribute(imgTag, "srcset");
    assert(imgSrcset, `${name}: <img> is missing srcset`);
    assertScreenshotSrcset(name, "webp", imgSrcset, "fallback img srcset");

    const imgSizes = getAttribute(imgTag, "sizes");
    assert(imgSizes, `${name}: <img> is missing sizes`);
    assert(
      avifSizes === imgSizes,
      `${name}: AVIF <source> sizes must match the fallback <img> sizes`,
    );
    assert(
      webpSizes === imgSizes,
      `${name}: WebP <source> sizes must match the fallback <img> sizes`,
    );
    assert(getAttribute(imgTag, "alt")?.trim(), `${name}: <img> is missing useful alt text`);
    assert(
      Number(getAttribute(imgTag, "width")) === 1440,
      `${name}: <img> width must be 1440`,
    );
    assert(
      Number(getAttribute(imgTag, "height")) === 900,
      `${name}: <img> height must be 900`,
    );
  }
}

function extractBracedBlock(source, openBrace) {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  fail("CSS contains an unclosed block");
}

function normalizeCssText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function collectMediaBlocks(css) {
  const blocks = [];
  const pattern = /@media\b([^{]*)\{/g;
  for (const match of css.matchAll(pattern)) {
    const openBrace = match.index + match[0].length - 1;
    const body = extractBracedBlock(css, openBrace);
    blocks.push({
      condition: normalizeCssText(match[1]),
      body,
      start: match.index,
      end: openBrace + body.length + 2,
    });
  }
  return blocks;
}

function stripMediaBlocks(css, mediaBlocks) {
  let output = css;
  for (const block of [...mediaBlocks].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, block.start) + output.slice(block.end);
  }
  return output;
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectRules(source) {
  const rules = [];
  const pattern = /(?:^|[}])\s*([^{}@]+?)\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const selectorText = normalizeCssText(match[1]);
    if (!selectorText) continue;
    const openBrace = match.index + match[0].length - 1;
    rules.push({
      selectorText,
      selectors: selectorText
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      block: extractBracedBlock(source, openBrace),
    });
  }
  return rules;
}

function classNamesIn(selector) {
  return [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
}

function findRuleBlocks(source, selector) {
  const className = selector.replace(/^\./, "");
  return collectRules(stripCssComments(source))
    .filter((rule) =>
      rule.selectors.some((item) => classNamesIn(item).includes(className)),
    )
    .map((rule) => rule.block);
}

function parseDeclarations(block) {
  return block
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const separator = declaration.indexOf(":");
      assert(separator > 0, `CSS contains a malformed declaration: ${declaration}`);
      return {
        property: declaration.slice(0, separator).trim().toLowerCase(),
        value: normalizeCssText(declaration.slice(separator + 1)),
      };
    });
}

const PADDING_PROPERTY =
  /^padding(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;

function assertSpacingRule(
  source,
  selector,
  context,
  expectedStart,
  expectedEnd = expectedStart,
) {
  const blocks = findRuleBlocks(source, selector);
  assert(
    blocks.length === 1,
    `${context} must contain exactly one ${selector} rule, found ${blocks.length}`,
  );

  const declarations = parseDeclarations(blocks[0]);
  const paddingBlock = declarations.filter((item) => item.property === "padding-block");
  const conflicting = declarations.filter(
    (item) => item.property !== "padding-block" && PADDING_PROPERTY.test(item.property),
  );

  assert(
    conflicting.length === 0,
    `${context}: ${selector} must not use conflicting padding declarations`,
  );
  assert(
    paddingBlock.length === 1,
    `${context}: ${selector} must declare padding-block exactly once`,
  );

  const paddingValues = paddingBlock[0].value.split(/\s+/);
  assert(
    paddingValues.length === 1 || paddingValues.length === 2,
    `${context}: ${selector} padding-block must contain one or two values, got ${paddingBlock[0].value}`,
  );
  const [actualStart, actualEnd = actualStart] = paddingValues;
  assert(
    actualStart === `var(${expectedStart})`,
    `${context}: ${selector} padding-block-start must be var(${expectedStart}), got ${actualStart}`,
  );
  assert(
    actualEnd === `var(${expectedEnd})`,
    `${context}: ${selector} padding-block-end must be var(${expectedEnd}), got ${actualEnd}`,
  );
}

function assertNoSectionVariantPadding(source, context) {
  for (const rule of collectRules(stripCssComments(source))) {
    const hasSectionVariant = rule.selectors.some((selector) =>
      classNamesIn(selector).some((name) => name.startsWith("section-")),
    );
    if (!hasSectionVariant) continue;
    const declarations = parseDeclarations(rule.block);
    const padding = declarations.filter((item) => PADDING_PROPERTY.test(item.property));
    assert(
      padding.length === 0,
      `${context}: ${rule.selectorText} must not set its own padding; use the shared .section spacing`,
    );
  }
}

function minWidthOf(block) {
  const match = block.condition.match(/^\(min-width:\s*(\d+)px\)$/);
  return match ? Number(match[1]) : null;
}

function checkSpacingPlan(css) {
  const mediaBlocks = collectMediaBlocks(css);
  const baseCss = stripMediaBlocks(css, mediaBlocks);

  const tablet = mediaBlocks.filter((block) => block.condition === "(min-width: 768px)");
  const desktop = mediaBlocks.filter((block) => block.condition === "(min-width: 1121px)");
  assert(
    tablet.length === 1,
    "CSS must contain exactly one tablet media block at (min-width: 768px)",
  );
  assert(
    desktop.length === 1,
    "CSS must contain exactly one desktop media block at (min-width: 1121px)",
  );

  const tabletMin = minWidthOf(tablet[0]);
  const desktopMin = minWidthOf(desktop[0]);
  assert(tabletMin === 768, `tablet media block must start at 768px, got ${tabletMin}`);
  assert(desktopMin === 1121, `desktop media block must start at 1121px, got ${desktopMin}`);
  assert(desktopMin > 1024, "desktop breakpoint must keep 1024px in the tablet range");

  for (const block of mediaBlocks) {
    if (block === tablet[0] || block === desktop[0]) continue;
    for (const selector of [".hero", ".section"]) {
      assert(
        findRuleBlocks(block.body, selector).length === 0,
        `CSS must not override ${selector} in @media ${block.condition}`,
      );
    }
    assertNoSectionVariantPadding(block.body, `@media ${block.condition}`);
  }

  assertSpacingRule(baseCss, ".hero", "base CSS", "--space-80");
  assertSpacingRule(baseCss, ".section", "base CSS", "--space-64");
  assertSpacingRule(tablet[0].body, ".hero", "tablet CSS", "--space-112");
  assertSpacingRule(tablet[0].body, ".section", "tablet CSS", "--space-96");
  assertSpacingRule(
    desktop[0].body,
    ".hero",
    "desktop CSS",
    "--space-80",
    "--space-144",
  );
  assertSpacingRule(desktop[0].body, ".section", "desktop CSS", "--space-128");
  assertNoSectionVariantPadding(baseCss, "base CSS");
  assertNoSectionVariantPadding(tablet[0].body, "tablet CSS");
  assertNoSectionVariantPadding(desktop[0].body, "desktop CSS");

  const expectedByWidth = new Map([
    [320, { hero: "--space-80", section: "--space-64" }],
    [375, { hero: "--space-80", section: "--space-64" }],
    [768, { hero: "--space-112", section: "--space-96" }],
    [1024, { hero: "--space-112", section: "--space-96" }],
    [1440, { hero: "--space-80", section: "--space-128" }],
  ]);

  for (const [width, expected] of expectedByWidth) {
    const effectiveHero =
      width >= desktopMin ? "--space-80" : width >= tabletMin ? "--space-112" : "--space-80";
    const effectiveSection =
      width >= desktopMin ? "--space-128" : width >= tabletMin ? "--space-96" : "--space-64";
    assert(
      effectiveHero === expected.hero,
      `effective hero spacing at ${width}px must be ${expected.hero}`,
    );
    assert(
      effectiveSection === expected.section,
      `effective section spacing at ${width}px must be ${expected.section}`,
    );
  }
}

function checkCss(css) {
  for (const needed of ["--space-112", "--space-144"]) {
    assert(css.includes(`${needed}:`), `CSS must define ${needed}`);
  }

  const definitions = new Map();
  for (const match of css.matchAll(/--space-(\d+):\s*(\d+)px;/g)) {
    const token = Number(match[1]);
    const value = Number(match[2]);
    assert(token === value, `spacing token --space-${token} must equal ${value}px`);
    assert(value > 0 && value % 8 === 0, `spacing token --space-${token} is not an 8-point value`);
    definitions.set(`--space-${token}`, value);
  }

  for (const match of css.matchAll(/var\(\s*(--space-[a-z0-9-]+)/g)) {
    assert(definitions.has(match[1]), `CSS uses undefined spacing token ${match[1]}`);
  }

  assert(!/(linear|radial|conic)-gradient\(/i.test(css), "CSS must not contain gradients");
  assert(
    css.includes("@media (prefers-reduced-motion: reduce)"),
    "CSS must include a reduced-motion rule",
  );

  const spacingDeclaration =
    /(?:^|[;{])\s*(margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|gap|row-gap|column-gap|inset(?:-[a-z]+)?|top|right|bottom|left|min-height|min-width)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(spacingDeclaration)) {
    const property = match[1];
    const value = match[2];
    for (const px of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const amount = Number(px[1]);
      assert(
        amount === 0 || amount % 8 === 0 || /var\(/.test(value),
        `${property} uses a non-8-point spacing value: ${value.trim()}`,
      );
    }
  }

  checkSpacingPlan(css);
}

export function validateSite({
  env = "preview",
  allowPlaceholders = false,
  requireScreenshots = env !== "local",
} = {}) {
  const index = read("index.html");
  const notFound = read("404.html");
  const css = read("assets/site.css");

  assert(/<html lang="en">/.test(index), "index.html must declare lang=\"en\"");
  assert(/<title>[^<]+<\/title>/.test(index), "index.html must have a title");
  assert(
    /<meta name="description" content="[^"]{50,}">/.test(index),
    "index.html must have a meaningful meta description",
  );
  assert(
    /<meta name="robots" content="noindex, nofollow" data-build-robots>/.test(index),
    "index.html must ship with fail-closed noindex metadata",
  );
  assert(
    !/<link\b[^>]*rel="canonical"/i.test(index),
    "source index.html must not contain a canonical tag; the build injects it",
  );
  assert(!/property="og:url"/.test(index), "source index.html must not contain og:url");
  assert(!/property="og:image"/.test(index), "source index.html must not contain og:image");
  assert(!/name="twitter:image"/.test(index), "source index.html must not contain twitter:image");

  for (const token of [
    "<!-- BUILD:CANONICAL -->",
    "<!-- BUILD:OG_URL -->",
    "<!-- BUILD:OG_IMAGE -->",
    "<!-- BUILD:TWITTER_IMAGE -->",
  ]) {
    assert(index.includes(token), `index.html is missing build token ${token}`);
  }

  assert(/<script\b/i.test(index) === false, "index.html must not include client JavaScript");
  assert(/<iframe\b/i.test(index) === false, "index.html must not include iframes");
  assert(/\son[a-z]+\s*=/i.test(index) === false, "index.html must not use inline event handlers");

  const placeholders = [...index.matchAll(/data-screenshot-placeholder="([^"]+)"/g)].map(
    (match) => match[1],
  );

  if (allowPlaceholders) {
    for (const expected of EXPECTED_SCREENSHOTS) {
      assert(
        placeholders.includes(expected),
        `local placeholder set is missing ${expected}`,
      );
    }
  } else {
    assert(
      placeholders.length === 0,
      env === "local"
        ? "local build contains placeholders; set SITE_ALLOW_PLACEHOLDERS=1 to allow them"
        : "placeholders are not allowed in preview or production builds",
    );
    assert(!/Screenshot pending/i.test(index), "public builds must not contain screenshot placeholders");
    checkScreenshotPictures(index);
  }

  for (const [sourceFile, html] of [
    ["index.html", index],
    ["404.html", notFound],
  ]) {
    assert(!/href="#"/.test(html), `${sourceFile}: contains a placeholder href="#"`);
    assert(!/lorem ipsum/i.test(html), `${sourceFile}: contains placeholder copy`);
    assert(!/\bTODO\b|\bFIXME\b/.test(html), `${sourceFile}: contains a TODO or FIXME`);
    assert(!/<script\b/i.test(html), `${sourceFile}: must not include client JavaScript`);
    checkLocalReferences(html, sourceFile);
    checkImages(html, sourceFile);
  }

  assert(
    /<meta name="robots" content="noindex, nofollow">/.test(notFound),
    "404.html must be noindex",
  );

  if (requireScreenshots) {
    for (const name of EXPECTED_SCREENSHOTS) {
      for (const width of SCREENSHOT_WIDTHS) {
        for (const format of SCREENSHOT_FORMATS) {
          checkScreenshotFile(name, width, format);
        }
      }
    }
    const ogPath = path.join(SCREENSHOT_DIR, OG_FILE);
    assert(fs.existsSync(ogPath), `missing Open Graph image: assets/screenshots/${OG_FILE}`);
    checkPng(ogPath, "Open Graph image");
  } else if (exists(`assets/screenshots/${OG_FILE}`)) {
    checkPng(path.join(SCREENSHOT_DIR, OG_FILE), "Open Graph image");
  }

  checkCss(css);

  return {
    env,
    placeholders: placeholders.length,
    screenshotsRequired: requireScreenshots,
  };
}

export function validateDist({ env, origin }) {
  const index = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const headers = fs.readFileSync(path.join(DIST, "_headers"), "utf8");
  const robots = fs.readFileSync(path.join(DIST, "robots.txt"), "utf8");
  const sitemapPath = path.join(DIST, "sitemap.xml");

  assert(!/<!-- BUILD:/.test(index), "build left unresolved metadata tokens in dist/index.html");
  assert(/<meta name="robots"/.test(index), "built page is missing robots metadata");

  if (env === "production") {
    assert(/rel="canonical" href="[^"]+"/.test(index), "production build is missing a canonical URL");
    assert(/property="og:url"/.test(index), "production build is missing og:url");
    assert(/property="og:image"/.test(index), "production build is missing og:image");
    assert(/name="twitter:image"/.test(index), "production build is missing twitter:image");
    assert(!/name="robots" content="noindex/i.test(index), "production build must be indexable");
    assert(!/X-Robots-Tag:\s*noindex/i.test(headers), "production build must not send noindex");
    assert(fs.existsSync(sitemapPath), "production build is missing sitemap.xml");
    assert(robots.includes("Sitemap:"), "production robots.txt is missing a sitemap reference");
    assert(robots.includes(origin), "production robots.txt does not reference the configured origin");
  } else {
    assert(!/rel="canonical"/.test(index), "preview/local build must not contain a canonical URL");
    assert(!/property="og:url"/.test(index), "preview/local build must not contain og:url");
    assert(!/property="og:image"/.test(index), "preview/local build must not contain og:image");
    assert(/name="robots" content="noindex, nofollow"/.test(index), "preview/local build must be noindex");
    assert(/X-Robots-Tag:\s*noindex, nofollow/i.test(headers), "preview/local build must send noindex");
    assert(!fs.existsSync(sitemapPath), "preview/local build must not contain sitemap.xml");
    assert(!robots.includes("Sitemap:"), "preview/local robots.txt must not contain a sitemap");
    assert(robots.includes("Allow: /"), "preview/local robots.txt must allow crawling");
  }
}

function main() {
  const env = process.env.SITE_ENV || "preview";
  const allowPlaceholders = env === "local" && process.env.SITE_ALLOW_PLACEHOLDERS === "1";
  const result = validateSite({ env, allowPlaceholders });
  console.log(
    `Website check passed: env=${result.env}, placeholders=${result.placeholders}, screenshotsRequired=${result.screenshotsRequired}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Website check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
