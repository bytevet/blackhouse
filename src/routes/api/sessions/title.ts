import { createFileRoute } from "@tanstack/react-router";
import { db } from "@/db";
import { codingSessions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const Route = createFileRoute("/api/sessions/title")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as {
          sessionId: string;
          title: string;
          token: string;
        };

        if (!body.sessionId || !body.title || !body.token) {
          return new Response("Missing fields", { status: 400 });
        }

        const [session] = await db
          .select()
          .from(codingSessions)
          .where(eq(codingSessions.id, body.sessionId))
          .limit(1);

        if (!session) {
          return new Response("Session not found", { status: 404 });
        }

        if (session.containerId !== body.token) {
          return new Response("Invalid token", { status: 403 });
        }

        await db
          .update(codingSessions)
          .set({ agentTitle: body.title, updatedAt: new Date() })
          .where(eq(codingSessions.id, body.sessionId));

        return new Response("OK", { status: 200 });
      },
    },
  },
});
