import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIconSet = resolve(appRoot, "resources/app-icon/AppIcon.appiconset");
const targetIconSet = resolve(appRoot, "../ios/App/App/Assets.xcassets/AppIcon.appiconset");

async function copyDirectory(source, target) {
  await rm(target, { force: true, recursive: true });
  await mkdir(target, { recursive: true });

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const targetPath = resolve(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }
}

try {
  await copyDirectory(sourceIconSet, targetIconSet);
  console.log(`Installed iOS app icons into ${targetIconSet}`);
} catch (error) {
  throw new Error(`Unable to install iOS app icons. Run npm run icons:generate first, then create or sync the Capacitor iOS project. ${error.message}`);
}
