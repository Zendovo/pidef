// End-to-end smoke test for the web build, driven by Playwright.
//
// Usage:
//   npm run dev                      # in one terminal
//   node scripts/e2e-web.mjs         # in another
//
// Or against the production build:
//   npm run build && npm run preview
//   E2E_URL=http://127.0.0.1:4173/ node scripts/e2e-web.mjs
//
// Verifies merge (with pdfium previews), compress (with the size guard),
// split, and the Save As download fallback, failing on any console errors.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const minimalPdf = (label) => {
  const content = `0.2 0.5 0.8 rg\n20 20 160 160 re\nf\n% ${label}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(data.length);
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = data.length;
  data += `xref\n0 ${objects.length + 1}\n`;
  data += "0000000000 65535 f \n";
  for (const offset of offsets) {
    data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(data, "latin1");
};

const temp = mkdtempSync(join(tmpdir(), "pidef-e2e-"));
writeFileSync(join(temp, "a.pdf"), minimalPdf("A"));
writeFileSync(join(temp, "b.pdf"), minimalPdf("B"));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("worker", (worker) => {
  worker.on("console", (message) => {
    if (message.type() === "error") errors.push(`worker: ${message.text()}`);
  });
});

await page.addInitScript(() => {
  Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
});

await page.goto(process.env.E2E_URL ?? "http://127.0.0.1:1420/", {
  waitUntil: "networkidle",
});
console.log("1. app loaded:", await page.title());

await page.getByRole("button", { name: "Merge PDF", exact: true }).click();
const chooserPromise = page.waitForEvent("filechooser");
await page.getByRole("button", { name: /Choose Files/ }).click();
await (await chooserPromise).setFiles([
  join(temp, "a.pdf"),
  join(temp, "b.pdf"),
]);
await page.locator(".split-queue-row").first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(800);
console.log("2. merge queue shows:", await page.locator(".split-queue-row").count(), "documents");

await page.locator(".split-run-pill").click();
await page.getByText("Ready for Export").waitFor({ timeout: 60_000 });
console.log("3. merge complete:", await page.locator(".split-modal-row-meta strong").first().innerText());

const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.getByRole("button", { name: /Save As/ }).click();
const download = await downloadPromise;
console.log("4. saved via download:", download.suggestedFilename());
await page.getByRole("button", { name: "Done" }).click();
await page.getByRole("button", { name: "Compress PDF", exact: true }).click();
const chooserPromise2 = page.waitForEvent("filechooser");
await page.getByRole("button", { name: /Choose File/ }).click();
await (await chooserPromise2).setFiles([join(temp, "a.pdf")]);
await page.locator(".split-run-pill").waitFor({ timeout: 30_000 });
await page.locator(".split-run-pill").click();
await page.getByText("Compress PDF complete").waitFor({ timeout: 60_000 });
console.log("5. compress complete:", await page.locator(".split-modal-heading p").innerText());
await page.getByRole("button", { name: "Done" }).click();

await page.getByRole("button", { name: "Split PDF", exact: true }).click();
const chooserPromise3 = page.waitForEvent("filechooser");
await page.getByRole("button", { name: /Choose File/ }).click();
await (await chooserPromise3).setFiles([join(temp, "a.pdf")]);
await page.locator(".split-group-input").first().waitFor({ timeout: 30_000 });
await page.locator(".split-group-add").click();
await page.locator(".split-group-input").nth(1).fill("1");
await page.getByRole("button", { name: /Split PDF into/ }).click();
await page.getByText("Ready for Export").waitFor({ timeout: 60_000 });
console.log("6. split complete:", await page.locator(".split-modal-row-meta strong").first().innerText());

const zipDownloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.getByRole("button", { name: /Download All/ }).click();
const zipDownload = await zipDownloadPromise;
console.log("7. zip bundle saved:", zipDownload.suggestedFilename());
await page.getByRole("button", { name: "Done" }).click();

await browser.close();

const relevantErrors = errors.filter(
  (message) => !message.includes("favicon") && !message.includes("worker closed"),
);
if (relevantErrors.length > 0) {
  console.log("ERRORS:\n" + relevantErrors.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN — no console/page errors");
