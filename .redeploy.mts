import { d } from "./.verify-lib.mjs";
import { createReadStream } from "node:fs";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11,19), ...a);
async function main() {
  log("rebuilding app image ...");
  const s = await d.buildImage(createReadStream("/tmp/ctx.tgz") as any, { t: "blackhouse/app:e2e", dockerfile: "Dockerfile" });
  await new Promise<void>((res, rej) => d.modem.followProgress(s, (e: any, out: any[]) => {
    if (e) return rej(e); const bad = out?.find((o) => o.error); if (bad) return rej(new Error(bad.error)); res();
  }));
  log("rebuilt. recreating bh-app ...");
  const old = d.getContainer("bh-app");
  const insp: any = await old.inspect();
  await old.remove({ force: true });
  const c = await d.createContainer({
    Image: "blackhouse/app:e2e", name: "bh-app", Env: insp.Config.Env,
    HostConfig: { NetworkMode: "blackhouse", Binds: insp.HostConfig.Binds, RestartPolicy: { Name: "unless-stopped" } },
    NetworkingConfig: { EndpointsConfig: { blackhouse: { Aliases: ["app"] } } },
    Labels: { "blackhouse.e2e": "true" },
  });
  await c.start();
  log("bh-app restarted");
}
main().catch((e) => { console.error("REDEPLOY FAILED:", e.message); process.exit(1); });
