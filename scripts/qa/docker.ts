import { createHash } from "node:crypto";
import { relative } from "node:path";
import CONFIG from "@qa/config.json";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";

export type Runtime = {
  image: string;
  revision: string;
  volume: string;
  directory: string;
  network: string;
  owner: string;
};
export const user = (uid: number, gid: number): { uid: number; gid: number } =>
  uid === 0 ? { uid: CONFIG.workerUid, gid: CONFIG.workerGid } : { uid, gid };
export const command = async (args: string[]): Promise<string> => {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: Protocol.REQUEST_MS,
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Docker ${args[0]} failed: ${errors.trim()}`);

  return output.trim();
};
const description = z.object({
  Id: z.string(),
  Image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  HostConfig: z.object({
    Mounts: z
      .array(
        z.object({
          Type: z.string(),
          Source: z.string().optional(),
          Target: z.string(),
        }),
      )
      .nullable(),
    Binds: z.array(z.string()).nullable(),
  }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
});
export const runtime = (value: unknown): Runtime => {
  const self = description.parse(value);
  const named = (name: string, destination: string): boolean =>
    Boolean(
      self.HostConfig.Mounts?.some(
        (item): boolean =>
          item.Type === "volume" &&
          item.Source === name &&
          item.Target === destination,
      ) ||
        self.HostConfig.Binds?.some(
          (item): boolean =>
            item === `${name}:${destination}` ||
            item.startsWith(`${name}:${destination}:`),
        ),
    );
  const mount = self.Mounts.find(
    (item): boolean => item.Destination === CONFIG.controller.directory,
  );
  if (
    mount?.Type !== "volume" ||
    !mount.Name ||
    !mount.RW ||
    !named(mount.Name, CONFIG.controller.directory)
  )
    throw new Error(
      `Controller requires a writable named volume at ${CONFIG.controller.directory}`,
    );
  const owner: string = createHash("sha256")
    .update(mount.Name)
    .digest("hex")
    .slice(0, 24);

  return {
    image: self.Image,
    revision: self.Config.Labels?.["app.qa.revision"] ?? "",
    volume: mount.Name,
    directory: CONFIG.controller.directory,
    network: `qa-${owner}`,
    owner,
  };
};
export const inspect = async (): Promise<Runtime> => {
  if (!process.env.HOSTNAME || !(await Bun.file("/.dockerenv").exists()))
    throw new Error(
      "Controller requires Docker; leave the container hostname at its default",
    );

  return runtime(
    JSON.parse(await command(["inspect", process.env.HOSTNAME]))[0],
  );
};
export const mount = (
  value: Runtime,
  path: string,
  target: string,
  readonly: boolean = false,
): string => {
  const subpath: string = relative(value.directory, path);
  if (!subpath || subpath.startsWith("..") || /[,\n]/.test(subpath))
    throw new Error("Worker mount must stay within its private run directory");

  return `type=volume,src=${value.volume},volume-subpath=${subpath},dst=${target}${readonly ? ",readonly" : ""}`;
};
export const cleanup = async (value: Pick<Runtime, "owner">): Promise<void> => {
  const ids: string = await command([
    "ps",
    "-aq",
    "--filter",
    `label=${CONFIG.controller.label}=${value.owner}`,
  ]);
  if (ids) await command(["rm", "-f", ...ids.split("\n")]);
};
export const network = async (value: Runtime): Promise<void> => {
  const existing: string = await command([
    "network",
    "ls",
    "-q",
    "--filter",
    `name=^${value.network}$`,
  ]);
  if (!existing)
    await command([
      "network",
      "create",
      "--label",
      `${CONFIG.controller.label}=${value.owner}`,
      value.network,
    ]);
  const attached: unknown = JSON.parse(
    await command(["network", "inspect", value.network]),
  );
  const parsed = z
    .array(
      z.object({
        Containers: z
          .record(z.string(), z.object({ Name: z.string() }))
          .nullable(),
      }),
    )
    .parse(attached);
  const self: string = process.env.HOSTNAME ?? "";
  if (
    !Object.keys(parsed[0].Containers ?? {}).some((id: string): boolean =>
      id.startsWith(self),
    )
  )
    await command([
      "network",
      "connect",
      "--alias",
      "qa-controller",
      value.network,
      self,
    ]);
};
