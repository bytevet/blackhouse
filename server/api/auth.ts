import { Hono } from "hono";
import { auth } from "../lib/auth.js";

const app = new Hono();

/**
 * Mount Better Auth handler at /api/auth/*
 * Better Auth handles its own routing for sign-in, sign-up, session, etc.
 */
app.all("/*", async (c) => {
  return auth.handler(c.req.raw);
});

export default app;
