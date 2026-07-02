import { chromium } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logoSvg = await readFile(resolve(appRoot, "public/logo-buzz.svg"), "utf8");
const iosIconSet = resolve(appRoot, "resources/app-icon/AppIcon.appiconset");

const webIcons = [
  ["public/apple-touch-icon.png", 180],
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
];

const iosIcons = [
  { idiom: "iphone", size: "20x20", scale: "2x", pixels: 40 },
  { idiom: "iphone", size: "20x20", scale: "3x", pixels: 60 },
  { idiom: "iphone", size: "29x29", scale: "2x", pixels: 58 },
  { idiom: "iphone", size: "29x29", scale: "3x", pixels: 87 },
  { idiom: "iphone", size: "40x40", scale: "2x", pixels: 80 },
  { idiom: "iphone", size: "40x40", scale: "3x", pixels: 120 },
  { idiom: "iphone", size: "60x60", scale: "2x", pixels: 120 },
  { idiom: "iphone", size: "60x60", scale: "3x", pixels: 180 },
  { idiom: "ipad", size: "20x20", scale: "1x", pixels: 20 },
  { idiom: "ipad", size: "20x20", scale: "2x", pixels: 40 },
  { idiom: "ipad", size: "29x29", scale: "1x", pixels: 29 },
  { idiom: "ipad", size: "29x29", scale: "2x", pixels: 58 },
  { idiom: "ipad", size: "40x40", scale: "1x", pixels: 40 },
  { idiom: "ipad", size: "40x40", scale: "2x", pixels: 80 },
  { idiom: "ipad", size: "76x76", scale: "1x", pixels: 76 },
  { idiom: "ipad", size: "76x76", scale: "2x", pixels: 152 },
  { idiom: "ipad", size: "83.5x83.5", scale: "2x", pixels: 167 },
  { idiom: "ios-marketing", size: "1024x1024", scale: "1x", pixels: 1024 },
];

function iconFilename({ idiom, size, scale, pixels }) {
  return `AppIcon-${idiom}-${size.replaceAll(".", "_")}-${scale}-${pixels}.png`;
}

async function renderIcon(page, outputPath, pixels) {
  await mkdir(dirname(outputPath), { recursive: true });
  await page.setViewportSize({ width: pixels, height: pixels });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <style>
          html, body {
            margin: 0;
            width: ${pixels}px;
            height: ${pixels}px;
            overflow: hidden;
            background: transparent;
          }

          .icon {
            display: block;
            width: ${pixels}px;
            height: ${pixels}px;
            background: #F2F2F7;
          }

          svg {
            display: block;
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>
        <div class="icon">${logoSvg}</div>
      </body>
    </html>
  `);
  await page.locator(".icon").screenshot({ path: outputPath });
}

const contents = {
  images: [],
  info: {
    author: "xcode",
    version: 1,
  },
};

const browser = await chromium.launch();

try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await rm(iosIconSet, { force: true, recursive: true });

  for (const [relativePath, pixels] of webIcons) {
    await renderIcon(page, resolve(appRoot, relativePath), pixels);
  }

  for (const icon of iosIcons) {
    const filename = iconFilename(icon);
    await renderIcon(page, resolve(iosIconSet, filename), icon.pixels);
    contents.images.push({
      filename,
      idiom: icon.idiom,
      scale: icon.scale,
      size: icon.size,
    });
  }
} finally {
  await browser.close();
}

contents.images.sort((left, right) => {
  const idiomOrder = left.idiom.localeCompare(right.idiom);
  if (idiomOrder !== 0) return idiomOrder;
  const sizeOrder = Number.parseFloat(left.size) - Number.parseFloat(right.size);
  if (sizeOrder !== 0) return sizeOrder;
  return left.scale.localeCompare(right.scale);
});

await writeFile(resolve(iosIconSet, "Contents.json"), `${JSON.stringify(contents, null, 2)}\n`);

console.log(`Generated ${webIcons.length} web icons and ${iosIcons.length} iOS app icons.`);
