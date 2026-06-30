import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIconSet = resolve(appRoot, "resources/app-icon/AppIcon.appiconset");
const targetIconSet = resolve(appRoot, "../ios/App/App/Assets.xcassets/AppIcon.appiconset");
const targetAssetCatalog = dirname(targetIconSet);

async function assertDirectory(path, label) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
}

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
  await assertDirectory(sourceIconSet, "Source AppIcon set");
  await assertDirectory(targetAssetCatalog, "Capacitor iOS asset catalog");
  await copyDirectory(sourceIconSet, targetIconSet);
  console.log(`Installed iOS app icons into ${targetIconSet}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Unable to install iOS app icons. Run npm run icons:generate first, then create or sync the Capacitor iOS project. ${message}`, {
    cause: error,
  });
}
