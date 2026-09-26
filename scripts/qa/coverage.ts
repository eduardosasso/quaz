import {
  type Catalog,
  catalog as catalogSchema,
  type Flow,
} from "@/qa_protocol";

const request = async <T>(path: string, body?: unknown): Promise<T> => {
  const origin: string = process.env.QA_BRIDGE_URL ?? "";
  const token: string = process.env.QA_BRIDGE_TOKEN ?? "";
  if (!origin || !token || process.env.QA_DISPOSABLE !== "1")
    throw new Error("Coverage requires a scoped QA bridge");
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    throw new Error(`QA coverage ${path} failed: ${String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`QA coverage returned ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch (error: unknown) {
    throw new Error(`QA coverage ${path} failed: ${String(error)}`, {
      cause: error,
    });
  }
};
export const catalog = async (): Promise<Catalog> =>
  catalogSchema.parse(await request<unknown>("/catalog"));
export const publication = async (): Promise<Catalog | null> =>
  catalogSchema.nullable().parse(await request<unknown>("/publication", {}));
export const list = async (): Promise<Flow[]> => request<Flow[]>("/flows");
export const claim = async (key: string, goal: string): Promise<boolean> =>
  (await request<{ accepted: boolean }>("/claim", { key, goal })).accepted;
if (import.meta.main) {
  const [command, key, goal]: string[] = process.argv.slice(2);
  if (command === "list") console.log(JSON.stringify(await list()));
  else if (command === "claim")
    console.log(JSON.stringify({ accepted: await claim(key, goal) }));
  else throw new Error("Use list or claim <flow-slug> <goal>");
}
