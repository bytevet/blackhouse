/* ------------------------------------------------------------------------- *
 *                                                                             *
 *   ███  FIXTURE DATA — NOT WIRED INTO THE RUNNING APP  ███                   *
 *                                                                             *
 *   The Channel View reads the real API now: `use-channel-data.ts` fetches,    *
 *   `channel-mapping.ts` projects, and `channel.tsx` lays out. Nothing in      *
 *   `src/` imports this file any more.                                        *
 *                                                                             *
 *   It is kept because it is a hand-checked, fully populated example of every  *
 *   transcript kind — the five entry shapes, an expanded turn, an artifact     *
 *   card, a pending dispatch and a queued chip — which makes it the cheapest   *
 *   fixture for tests and stories that need a believable channel without a     *
 *   server. Keep it in step with `types.ts`; do not import it from a page.     *
 *                                                                             *
 * ------------------------------------------------------------------------- */

import type { AgentView, ArtifactView, ChannelView, TranscriptEntry, UserView } from "./types";

/** The signed-in human. Stands in for the Better Auth session user. */
export const mockCurrentUser: UserView = {
  id: "usr_dana",
  name: "Dana Okafor",
  role: "owner",
};

export const mockWorkspace = {
  name: "Acme Storefront",
  /** `blackhouse · self-hosted` in the design's workspace switcher. */
  tagline: "blackhouse · self-hosted",
};

/**
 * The roster. Note that `status` and `activity` vary independently across
 * these four — `@reviewer` is a *running* container that is *idle*, and
 * `@frontend` is an *error* container whose activity is therefore `unknown`,
 * never `idle`. Any UI that folds these into one indicator loses that.
 */
export const mockAgents: AgentView[] = [
  {
    id: "agt_scout",
    handle: "scout",
    displayName: "Scout",
    status: "running",
    activity: "busy",
    statusLine: "reading src/db/schema.ts",
  },
  {
    id: "agt_backend",
    handle: "backend",
    displayName: "Backend",
    status: "running",
    activity: "busy",
    statusLine: "running tests · 34/50",
  },
  {
    id: "agt_reviewer",
    handle: "reviewer",
    displayName: "Reviewer",
    status: "running",
    activity: "idle",
    statusLine: "idle · last run 12m ago",
  },
  {
    id: "agt_frontend",
    handle: "frontend",
    displayName: "Frontend",
    status: "error",
    activity: "unknown",
    statusLine: "sandbox exited (code 1)",
  },
];

export const mockChannels: ChannelView[] = [
  {
    id: "chn_general",
    slug: "general",
    name: "general",
    topic: "Everything else",
    gitRepoUrl: null,
    gitBranch: null,
    autoApproveDispatch: false,
    isPrivate: false,
    unreadCount: 0,
    hasMention: false,
    humanCount: 4,
    agentCount: 1,
  },
  {
    id: "chn_backend",
    slug: "backend",
    name: "backend",
    topic: "Payments refactor",
    gitRepoUrl: "acme/storefront",
    gitBranch: "main",
    autoApproveDispatch: false,
    isPrivate: false,
    unreadCount: 3,
    hasMention: false,
    humanCount: 2,
    agentCount: 3,
  },
  {
    id: "chn_frontend",
    slug: "frontend",
    name: "frontend",
    topic: "Checkout UI",
    gitRepoUrl: "acme/storefront",
    gitBranch: "main",
    autoApproveDispatch: false,
    isPrivate: false,
    unreadCount: 0,
    hasMention: false,
    humanCount: 3,
    agentCount: 2,
  },
  {
    id: "chn_incidents",
    slug: "incidents",
    name: "incidents",
    topic: "Production pages land here",
    gitRepoUrl: null,
    gitBranch: null,
    autoApproveDispatch: true,
    isPrivate: false,
    unreadCount: 0,
    hasMention: true,
    humanCount: 5,
    agentCount: 2,
  },
  {
    id: "chn_random",
    slug: "random",
    name: "random",
    topic: null,
    gitRepoUrl: null,
    gitBranch: null,
    autoApproveDispatch: false,
    isPrivate: false,
    unreadCount: 0,
    hasMention: false,
    humanCount: 6,
    agentCount: 0,
  },
];

const mockArtifact: ArtifactView = {
  id: "art_flowmap",
  kind: "html",
  title: "checkout-flow-map.html",
  sizeBytes: 24_576,
  description: "rendered HTML",
  previewNodes: [
    { label: "checkout/page.tsx", depth: 0, tone: "info" },
    { label: "actions.ts", depth: 1, tone: "neutral" },
    { label: "payments/stripe.ts", depth: 1, tone: "accent" },
    { label: "webhooks/stripe ⚠", depth: 1, tone: "warning" },
    { label: "db/schema.ts · orders", depth: 2, tone: "neutral" },
  ],
};

const AGENT_REPLY_BODY = `The checkout flow touches **4 modules**. The payments call sites you'll need to migrate:

- \`src/lib/payments/stripe.ts\` — the client wrapper (7 exports)
- \`src/app/checkout/actions.ts\` — 3 server actions call it directly
- \`src/db/schema.ts\` — \`orders.payment_intent_id\` FK

The one that will bite you is the webhook handler — it constructs the Stripe client a second time instead of importing the wrapper:

\`\`\`ts
// src/app/api/webhooks/stripe/route.ts:14
const stripe = new Stripe(process.env.STRIPE_KEY!)
//        ^ bypasses lib/payments/stripe.ts — migrate this too
\`\`\`

I rendered a dependency map so you can see the blast radius before touching anything.`;

const today = (hours: number, minutes: number): Date => {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
};

const yesterday = (hours: number, minutes: number): Date => {
  const d = today(hours, minutes);
  d.setDate(d.getDate() - 1);
  return d;
};

/** Ordered oldest → newest, exactly as a keyset page arrives. */
export const mockTranscript: TranscriptEntry[] = [
  {
    kind: "system",
    id: "msg_0",
    seq: 1180,
    createdAt: yesterday(17, 42),
    body: "Dana Okafor set the channel repo to acme/storefront @ main",
  },
  {
    kind: "human",
    id: "msg_1",
    seq: 1201,
    createdAt: today(10, 24),
    author: mockCurrentUser,
    body: "@scout summarise everything the checkout flow touches — we're about to refactor the payments module and I don't want to miss a call site.",
  },
  {
    kind: "turn",
    id: "msg_2",
    seq: 1202,
    createdAt: today(10, 24),
    agent: mockAgents[0],
    turn: {
      runId: "run_scout_1",
      status: "done",
      toolCallCount: 8,
      durationMs: 31_000,
      tokens: 9_400,
      toolCalls: [
        {
          id: "tc_1",
          glyph: "◇",
          tone: "info",
          verb: "Read",
          target: "src/app/checkout/page.tsx",
          meta: "118 ln",
        },
        {
          id: "tc_2",
          glyph: "◇",
          tone: "info",
          verb: "Read",
          target: "src/lib/payments/stripe.ts",
          meta: "204 ln",
        },
        {
          id: "tc_3",
          glyph: "⌕",
          tone: "neutral",
          verb: "Grep",
          target: '"stripe" · 42 matches',
          meta: "—",
        },
        {
          id: "tc_4",
          glyph: "◇",
          tone: "info",
          verb: "Read",
          target: "src/db/schema.ts",
          meta: "340 ln",
        },
        {
          id: "tc_5",
          glyph: "▶",
          tone: "success",
          verb: "Ran",
          target: "rg --files src/app/checkout",
          meta: "0.4s",
        },
        {
          id: "tc_6",
          glyph: "◇",
          tone: "info",
          verb: "Read",
          target: "src/app/api/webhooks/stripe/route.ts",
          meta: "61 ln",
        },
        {
          id: "tc_7",
          glyph: "✎",
          tone: "warning",
          verb: "Wrote",
          target: "checkout-flow-map.html",
          meta: "24 KB",
        },
        {
          id: "tc_8",
          glyph: "▶",
          tone: "success",
          verb: "Ran",
          target: "npx tsc --noEmit",
          meta: "6.2s",
        },
      ],
    },
  },
  {
    kind: "agent-text",
    id: "msg_3",
    seq: 1203,
    createdAt: today(10, 24),
    agent: mockAgents[0],
    body: AGENT_REPLY_BODY,
    artifact: mockArtifact,
  },
  {
    kind: "dispatch",
    id: "msg_4",
    seq: 1204,
    createdAt: today(10, 25),
    dispatch: {
      id: "dsp_1",
      fromHandle: "scout",
      toHandle: "reviewer",
      prompt:
        "Review the payments migration plan in checkout-flow-map.html and flag any call site I missed before we start editing.",
      approvedPrompt: null,
      status: "pending",
      decidedByName: null,
      // Five minutes out from mount, so the countdown visibly ticks.
      expiresAt: new Date(Date.now() + 5 * 60_000),
      autoApproved: false,
      runId: null,
    },
  },
  {
    kind: "human",
    id: "msg_5",
    seq: 1205,
    createdAt: today(10, 26),
    author: mockCurrentUser,
    body: "@backend once tests are green, open a PR against main.",
    queued: {
      runId: "run_backend_1",
      agentHandle: "backend",
      reason: "running tests",
      mode: "queue",
    },
  },
];
