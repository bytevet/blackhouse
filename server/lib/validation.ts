import { z } from "zod";

export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const volumeMountSchema = z.array(
  z.object({
    name: z.string().regex(VOLUME_NAME_RE, "Invalid volume name"),
    mountPath: z.string().min(1),
  }),
);
