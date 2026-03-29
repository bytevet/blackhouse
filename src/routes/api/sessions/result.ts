import { createFileRoute } from "@tanstack/react-router";
import { db } from "@/db";
import { codingSessions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const Route = createFileRoute("/api/sessions/result")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as {
          sessionId: string;
          html: string;
          token: string;
        };

        if (!body.sessionId || !body.html || !body.token) {
          return new Response("Missing fields", { status: 400 });
        }

        // Validate the token matches the session's container
        const [session] = await db
          .select()
          .from(codingSessions)
          .where(eq(codingSessions.id, body.sessionId))
          .limit(1);

        if (!session) {
          return new Response("Session not found", { status: 404 });
        }

        if (!session.sessionToken || session.sessionToken !== body.token) {
          return new Response("Invalid token", { status: 403 });
        }

        await db
          .update(codingSessions)
          .set({ resultHtml: body.html, updatedAt: new Date() })
          .where(eq(codingSessions.id, body.sessionId));

        return new Response("OK", { status: 200 });
      },
    },
  },
});
