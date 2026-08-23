/**
 * The system prompt every agent gets, and how it composes with the operator's.
 *
 * WHY THIS IS A CONSTANT AND NOT A SEED VALUE
 *
 * `server/db/seed.ts` only inserts blueprints when the table is empty. A prompt
 * shipped as a seeded column therefore reaches exactly zero existing installs —
 * every deployment that has ever booted already has its three rows — and every
 * later wording change becomes a hand-written migration against user-edited
 * data. A constant composed at container start has neither problem: an agent
 * picks up the current text on its next restart, with no data change at all.
 *
 * WHY THE BASE IS NOT DROPPABLE
 *
 * What follows is harness *facts*, not personality: that channels exist, how to
 * reach them, and that nobody can see the agent's files. An operator who writes
 * a blueprint prompt is choosing a voice, not opting out of knowing where the
 * output goes — so their text is appended to these facts rather than replacing
 * them. The failure this prevents is concrete: an agent that does not know
 * about `submit-result.sh` publishes its HTML report to whatever external
 * service its CLI ships with, and the humans who asked for it never see it.
 *
 * If an escape hatch is ever genuinely needed, it should be an explicit boolean
 * on the blueprint (`suppressBasePrompt`) rather than an empty-string
 * convention — "" is what an operator types when they mean "no override", and
 * overloading it to mean "no facts either" makes the safe edit the dangerous
 * one.
 */

/**
 * `{handle}` is the only placeholder. Interpolated by `composeSystemPrompt`.
 *
 * The channel is optional in the usages below because `post.sh` and
 * `submit-result.sh` now default to the channel of the prompt being answered —
 * the server resolves it from the run in flight. That sentence was deliberately
 * held back until the inference actually shipped: anything the prompt claims
 * and the scripts do not do is a lie the agent will act on, and an agent
 * following instructions that never worked is far harder to debug than a prompt
 * that undersells. `tests/unit/system-prompt.test.ts` pins the two script names
 * so the prompt and the shipped scripts cannot drift apart silently.
 */
export const BLACKHOUSE_BASE_PROMPT = `You are @{handle}, a persistent agent in a Blackhouse workspace — a chat app where
humans and other agents share channels. This terminal is your session and it stays
up between conversations.

Work arrives as text typed onto your stdin. Each prompt from a channel begins with a
line naming that channel. That channel is where your answer is expected, and
post.sh and submit-result.sh go there by default — pass '#channel' only to
target a different one.

There is no inbox, nothing to poll, and nothing to acknowledge. Answering means posting.

  ~/.claude/skills/blackhouse/
    post.sh "..."                                say something in the channel
    submit-result.sh < report.html               publish something to LOOK at
    update-title.sh "..."                        your one-line status
    list-channels.sh                             your channels and your peers
    read.sh '#channel'                           catch up on what you missed

What you cannot do: no one can see your files. There is no desktop here, no shared
disk, and no way for a human to open a path you print. Your own tools still work —
they just do not reach anyone, and neither does anything you publish to a service
outside this workspace. If you made something to be looked at, submit it as an
artifact; if you have something to say, post it. Work that ends in this terminal
reached nobody.

You cannot dispatch another agent. mention.sh files a request a human approves. Do not
wait on a reply and do not poll. Finish, post, and go idle — idle is correct.`;

/**
 * Base facts, then whichever operator prompt is in effect.
 *
 * `agentOverride` replaces `blueprintPrompt` — the per-agent field is described
 * in the UI as an override, and two stacked personalities read as one confused
 * one. Neither replaces the base.
 *
 * The join is trimmed and conditional so an absent override cannot leave a
 * trailing blank paragraph. That is cosmetic in a file and not cosmetic on a
 * command line: this string is passed through `--append-system-prompt "$(cat …)"`,
 * and trailing whitespace is the kind of thing that ends up quoted into a
 * transcript.
 */
export function composeSystemPrompt(input: {
  handle: string;
  blueprintPrompt: string | null;
  agentOverride: string | null;
}): string {
  // Handles are stored bare (`server/lib/mentions.ts` strips a leading `@`
  // before matching), and the template already supplies the sigil.
  const handle = input.handle.replace(/^@/, "");
  const base = BLACKHOUSE_BASE_PROMPT.replaceAll("{handle}", handle);

  const operator = (input.agentOverride ?? input.blueprintPrompt ?? "").trim();
  return operator ? `${base}\n\n${operator}` : base;
}
