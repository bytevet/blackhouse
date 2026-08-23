import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { getDockerClient } from "../lib/docker.js";
import { validateAgentForContainer } from "../lib/agent-ws-auth.js";
import { configurePtyHub, type PtyDocker, type PtyHub } from "./pty-hub.js";

/**
 * Wire the process-wide PTY hub against the `agents` table.
 *
 * This is called at server startup, NOT lazily from the terminal WebSocket
 * route, and the distinction is load-bearing.
 *
 * The hub has two consumers: browser peers attaching to a terminal, and the
 * injector delivering a channel mention onto the agent's stdin. Configuring it
 * from the WS route meant the injector's `getPtyHub()` threw
 * "PtyHub not configured" unless somebody had already opened that agent's
 * Terminal tab in this server process. Mentioning an agent without first
 * visiting its terminal — the ordinary case — failed the run outright.
 *
 * `resolveContainer` remains the only coupling point: the hub itself knows
 * nothing about agents, Docker lookups, or how a container is authorized.
 */
export function ensurePtyHubConfigured(): PtyHub {
  return configurePtyHub({
    resolveContainer: (agentId) => validateAgentForContainer(agentId),
    getDocker: async () => (await getDockerClient()) as unknown as PtyDocker,
    onDetached: async (agentId) => {
      // The attach stream ended, so the container's main process exited.
      await db
        .update(agents)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },
  });
}
