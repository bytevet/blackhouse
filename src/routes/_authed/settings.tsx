import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import {
  updateProfile,
  listAgentConfigs,
  upsertAgentConfig,
  deleteAgentConfig,
  getDockerConfig,
  updateDockerConfig,
  getDockerStatus,
  listContainers,
  listUsers,
  createUser,
  deleteUser,
  updateUserRole,
} from "@/server/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Plus, Trash2, Edit, Save, Bot, Container, Users, User } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { AgentConfig, User as DbUser } from "@/db/schema";

export const Route = createFileRoute("/_authed/settings")({
  loader: async () => {
    const agentConfigs = await listAgentConfigs();
    return { agentConfigs };
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">
            <User className="size-3" />
            Profile
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="agents">
              <Bot className="size-3" />
              Coding Agents
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="docker">
              <Container className="size-3" />
              Docker
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="users">
              <Users className="size-3" />
              Users
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="agents">
            <AgentsTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="docker">
            <DockerTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="users">
            <UsersTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const { data: session } = useSession();
  const [displayName, setDisplayName] = useState(session?.user?.name || "");
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveName = async () => {
    setSavingName(true);
    try {
      await updateProfile({ data: { name: displayName.trim() } });
    } finally {
      setSavingName(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || newPassword !== confirmPassword) return;
    setSavingPassword(true);
    try {
      await updateProfile({
        data: {
          currentPassword,
          newPassword,
        },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="max-w-md space-y-6 pt-4">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Display Name</h3>
        <div className="flex gap-2">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
          <Button onClick={handleSaveName} disabled={!displayName.trim() || savingName}>
            <Save className="size-3" />
            {savingName ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Change Password</h3>
        <div className="grid gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="current-pw">Current Password</Label>
            <Input
              id="current-pw"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-pw">New Password</Label>
            <Input
              id="new-pw"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-pw">Confirm Password</Label>
            <Input
              id="confirm-pw"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <p className="text-xs text-destructive">Passwords do not match.</p>
          )}
          <Button
            onClick={handleChangePassword}
            disabled={
              !currentPassword || !newPassword || newPassword !== confirmPassword || savingPassword
            }
            className="w-fit"
          >
            {savingPassword ? "Updating..." : "Update Password"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Coding Agents Tab ────────────────────────────────────────────────────────

function AgentsTab() {
  const { agentConfigs: initial } = Route.useLoaderData();
  const [configs, setConfigs] = useState(initial);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [saving, setSaving] = useState(false);

  // Form
  const [agentType, setAgentType] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [yoloMode, setYoloMode] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [extraArgs, setExtraArgs] = useState("");

  useEffect(() => {
    setConfigs(initial);
  }, [initial]);

  const refresh = async () => {
    const updated = await listAgentConfigs();
    setConfigs(updated);
  };

  const openCreate = () => {
    setEditing(null);
    setAgentType("");
    setDisplayName("");
    setApiKey("");
    setDockerImage("");
    setYoloMode(false);
    setDefaultModel("");
    setExtraArgs("");
    setDialogOpen(true);
  };

  const openEdit = (config: AgentConfig) => {
    setEditing(config);
    setAgentType(config.agentType || "");
    setDisplayName(config.displayName || "");
    setApiKey("");
    setDockerImage(config.dockerImage || "");
    setYoloMode(config.yoloMode ?? false);
    setDefaultModel(config.defaultModel || "");
    setExtraArgs(config.extraArgs ? JSON.stringify(config.extraArgs, null, 2) : "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!agentType.trim() || !displayName.trim()) return;
    setSaving(true);
    try {
      let parsedExtraArgs: Record<string, unknown> | undefined = undefined;
      if (extraArgs.trim()) {
        try {
          parsedExtraArgs = JSON.parse(extraArgs.trim());
        } catch {
          return;
        }
      }
      await upsertAgentConfig({
        data: {
          id: editing?.id,
          agentType: agentType.trim(),
          displayName: displayName.trim(),
          apiKey: apiKey.trim() || undefined,
          dockerImage: dockerImage.trim() || undefined,
          yoloMode,
          defaultModel: defaultModel.trim() || undefined,
          extraArgs: parsedExtraArgs,
        },
      });
      setDialogOpen(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteAgentConfig({ data: { id } });
    await refresh();
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Agent Configurations</h3>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          Add Agent
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent Type</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead className="hidden sm:table-cell">Docker Image</TableHead>
              <TableHead>Yolo</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No agent configurations yet.
                </TableCell>
              </TableRow>
            ) : (
              configs.map((c: AgentConfig) => (
                <TableRow key={c.id}>
                  <TableCell>{c.agentType}</TableCell>
                  <TableCell>{c.displayName}</TableCell>
                  <TableCell className="hidden max-w-48 truncate text-muted-foreground sm:table-cell">
                    {c.dockerImage || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.yoloMode ? "default" : "outline"}>
                      {c.yoloMode ? "On" : "Off"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)}>
                        <Edit className="size-3" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(c.id)}>
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Agent Config" : "Add Agent Config"}</DialogTitle>
            <DialogDescription>Configure a coding agent for sessions.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ac-type">Agent Type</Label>
              <Input
                id="ac-type"
                placeholder="e.g. claude-code"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-name">Display Name</Label>
              <Input
                id="ac-name"
                placeholder="Claude Code"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-key">API Key</Label>
              <Input
                id="ac-key"
                type="password"
                placeholder={editing ? "(unchanged)" : "sk-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-image">Docker Image</Label>
              <Input
                id="ac-image"
                placeholder="ghcr.io/org/agent:latest"
                value={dockerImage}
                onChange={(e) => setDockerImage(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-model">Default Model</Label>
              <Input
                id="ac-model"
                placeholder="claude-sonnet-4-20250514"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={yoloMode} onCheckedChange={setYoloMode} size="sm" />
              <Label className="text-xs">Yolo mode (auto-approve)</Label>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-extra">Extra Args (JSON)</Label>
              <Textarea
                id="ac-extra"
                placeholder='{"key": "value"}'
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleSave}
              disabled={!agentType.trim() || !displayName.trim() || saving}
            >
              {saving ? "Saving..." : editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Docker Tab ───────────────────────────────────────────────────────────────

function DockerTab() {
  const [dockerStatus, setDockerStatus] = useState<{ connected: boolean; version?: string } | null>(
    null,
  );
  const [dockerConfig, setDockerConfig] = useState<{
    socketPath?: string;
    host?: string;
    port?: number;
  } | null>(null);
  const [containers, setContainers] = useState<
    { id: string; image: string; status: string; sessionName?: string; createdAt?: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form
  const [socketPath, setSocketPath] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const [status, config, containerList] = await Promise.all([
          getDockerStatus(),
          getDockerConfig(),
          listContainers(),
        ]);
        setDockerStatus(status);
        setDockerConfig(config);
        setContainers(containerList);
        setSocketPath(config?.socketPath || "");
        setHost(config?.host || "");
        setPort(config?.port?.toString() || "");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      await updateDockerConfig({
        data: {
          socketPath: socketPath.trim() || undefined,
          host: host.trim() || undefined,
          port: port ? parseInt(port, 10) : undefined,
        },
      });
      const status = await getDockerStatus();
      setDockerStatus(status);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="pt-4 text-sm text-muted-foreground">Loading Docker configuration...</div>
    );
  }

  const isConnected = dockerStatus?.connected ?? false;

  return (
    <div className="space-y-6 pt-4">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Connection Status</h3>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-sm text-muted-foreground">
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          {dockerStatus?.version && (
            <span className="text-xs text-muted-foreground">(v{dockerStatus.version})</span>
          )}
        </div>
      </div>

      <div className="max-w-md space-y-3">
        <h3 className="text-sm font-medium text-foreground">Configuration</h3>
        <div className="grid gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="docker-socket">Socket Path</Label>
            <Input
              id="docker-socket"
              placeholder="/var/run/docker.sock"
              value={socketPath}
              onChange={(e) => setSocketPath(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="docker-host">Host</Label>
            <Input
              id="docker-host"
              placeholder="localhost"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="docker-port">Port</Label>
            <Input
              id="docker-port"
              type="number"
              placeholder="2375"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <Button onClick={handleSaveConfig} disabled={saving} className="w-fit">
            <Save className="size-3" />
            {saving ? "Saving..." : "Save Config"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Containers</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container ID</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Session</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No containers found.
                  </TableCell>
                </TableRow>
              ) : (
                containers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.id?.slice(0, 12)}</TableCell>
                    <TableCell className="max-w-40 truncate text-muted-foreground">
                      {c.image}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {c.sessionName || "—"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {c.createdAt ? timeAgo(c.createdAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

// ── Users Tab ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<DbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingUser, setDeletingUser] = useState<DbUser | null>(null);
  const [creating, setCreating] = useState(false);

  // Form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");

  useEffect(() => {
    const load = async () => {
      try {
        const userList = await listUsers();
        setUsers(userList);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const refresh = async () => {
    const userList = await listUsers();
    setUsers(userList);
  };

  const openCreate = () => {
    setName("");
    setEmail("");
    setUsername("");
    setPassword("");
    setRole("user");
    setDialogOpen(true);
  };

  const handleCreate = async () => {
    if (!name.trim() || !email.trim() || !username.trim() || !password) return;
    setCreating(true);
    try {
      await createUser({
        data: {
          name: name.trim(),
          email: email.trim(),
          username: username.trim(),
          password,
          role,
        },
      });
      setDialogOpen(false);
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    await updateUserRole({ data: { userId, role: newRole } });
    await refresh();
  };

  const handleDelete = async () => {
    if (!deletingUser) return;
    await deleteUser({ data: { userId: deletingUser.id } });
    setDeleteDialogOpen(false);
    setDeletingUser(null);
    await refresh();
  };

  if (loading) {
    return <div className="pt-4 text-sm text-muted-foreground">Loading users...</div>;
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">User Management</h3>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          Add User
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead className="hidden sm:table-cell">Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.name}</TableCell>
                <TableCell className="hidden sm:table-cell text-muted-foreground">
                  {u.email}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-muted-foreground">
                  {u.username || "—"}
                </TableCell>
                <TableCell>
                  <Select
                    value={u.role || "user"}
                    onValueChange={(val) => handleRoleChange(u.id, val)}
                  >
                    <SelectTrigger className="h-6 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setDeletingUser(u);
                      setDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Add User Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new platform user.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="user-name">Name</Label>
              <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="user-email">Email</Label>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="user-username">Username</Label>
              <Input
                id="user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="user-pw">Password</Label>
              <Input
                id="user-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || !email.trim() || !username.trim() || !password || creating}
            >
              {creating ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingUser?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
