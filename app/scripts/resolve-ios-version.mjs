import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));

const marketingVersion = process.env.IOS_MARKETING_VERSION_INPUT?.trim() || packageJson.version?.trim();
const buildNumber =
  process.env.IOS_BUILD_NUMBER_INPUT?.trim() ||
  `${process.env.GITHUB_RUN_NUMBER || "1"}.${process.env.GITHUB_RUN_ATTEMPT || "1"}`;

const numericPart = "(0|[1-9]\\d*)";
const marketingVersionPattern = new RegExp(`^${numericPart}(\\.${numericPart}){0,2}$`);
const buildNumberPattern = new RegExp(`^${numericPart}(\\.${numericPart}){0,2}$`);

if (!marketingVersionPattern.test(marketingVersion)) {
  throw new Error(`iOS marketing version must use numeric x, x.y, or x.y.z format; found "${marketingVersion}"`);
}

if (!buildNumberPattern.test(buildNumber)) {
  throw new Error(`iOS build number must use one to three numeric parts; found "${buildNumber}"`);
}

const envLines = [`IOS_MARKETING_VERSION=${marketingVersion}`, `IOS_BUILD_NUMBER=${buildNumber}`];

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `${envLines.join("\n")}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `${[
      "## iOS App Store version",
      "",
      `- Version: \`${marketingVersion}\``,
      `- Build: \`${buildNumber}\``,
    ].join("\n")}\n`,
  );
}

console.log(`Resolved iOS App Store version ${marketingVersion} (${buildNumber})`);
