import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Project from "@qa/project";

const ORIGIN: string = "http://127.0.0.1:3001";
const CONTENT: string = "QA saved note";
export const prepare: Project.Adapter["prepare"] = async (input) => ({
  origin: ORIGIN,
  entry: "/",
  ready: "/",
  storageState: { cookies: [], origins: [] },
  command: [
    process.execPath,
    "--no-env-file",
    "/app/src/__tests__/fixtures/qa-target.ts",
    "serve",
  ],
  env: {
    QA_SAMPLE_SAVED: join(input.directory, "note.txt"),
    QA_SAMPLE_FIXED: input.settings.fixed ?? "0",
    QA_REVISION: input.revision,
  },
  metadata: { account: "disposable sample" },
});
export const smoke: Project.Adapter["smoke"] = async (
  prepared,
  browser,
  output,
) => {
  await mkdir(join(output, "smoke"), { recursive: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await page.goto(prepared.origin);
    await page.getByLabel("Note title").fill(CONTENT);
    await page.getByRole("button", { name: "Save note" }).click();
    await page.reload();
    await page.screenshot({ path: join(output, "smoke/mobile.png") });
    if ((await page.getByRole("status").textContent()) !== CONTENT)
      throw new Error("Saved sample note does not survive reload");
    return { persisted: true, evidence: ["smoke/mobile.png"] };
  } finally {
    await browser.close();
  }
};
const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
if (import.meta.main && process.argv[2] === "serve") {
  const savedPath: string | undefined = process.env.QA_SAMPLE_SAVED;
  if (!savedPath) throw new Error("Missing disposable sample data path");
  Bun.serve({
    hostname: "127.0.0.1",
    port: 3001,
    fetch: async (request: Request): Promise<Response> => {
      const path: string = new URL(request.url).pathname;
      if (path === "/version")
        return Response.json({ revision: process.env.QA_REVISION });
      if (path === "/save" && request.method === "POST") {
        const form = await request.formData();
        if (process.env.QA_SAMPLE_FIXED === "1")
          await writeFile(savedPath, String(form.get("title") ?? ""));
        return new Response(null, { status: 303, headers: { Location: "/" } });
      }
      let saved: string = "No saved note";
      try {
        saved = await readFile(savedPath, "utf8");
      } catch (error: unknown) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      return new Response(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample notes</title></head><body><main><h1>Saved notes</h1><form action="/save" method="post"><label for="title">Note title</label><input id="title" name="title" required><button type="submit">Save note</button></form><p role="status">${escaped(saved)}</p></main></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
}
