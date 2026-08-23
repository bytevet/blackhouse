import { useState } from "react";
import { Button, Checkbox, Dialog, Field, Input } from "@notyet.im/ui";

/**
 * Create a channel. A channel carries project context — repo and branch — so
 * agents created into it inherit somewhere to work; the agent's own checkout
 * stays authoritative.
 *
 * Presentational: it hands a plain object back and knows nothing about how it
 * is persisted.
 */
export function CreateChannelDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { slug: string; repo: string; branch: string; isPrivate: boolean }) => void;
}) {
  const [slug, setSlug] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [isPrivate, setIsPrivate] = useState(false);

  const normalised = slug
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a channel"
      description="Channels organise a team and its agents around a piece of work."
      size="sm"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!normalised}
            onClick={() => {
              onCreate({ slug: normalised, repo: repo.trim(), branch: branch.trim(), isPrivate });
              setSlug("");
            }}
          >
            Create channel
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Name" help="lowercase, no spaces · use - to separate words">
          <Input value={slug} onChange={setSlug} placeholder="payments-refactor" prefix="#" />
        </Field>
        <Field label="Repo & branch">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Input value={repo} onChange={setRepo} placeholder="acme/storefront" />
            <span style={{ color: "var(--ny-text-subtle)", fontFamily: "var(--ny-font-mono)" }}>
              @
            </span>
            <Input value={branch} onChange={setBranch} placeholder="main" />
          </div>
        </Field>
        <Checkbox
          checked={isPrivate}
          onChange={setIsPrivate}
          label="Private — only invited members and agents"
        />
      </div>
    </Dialog>
  );
}
