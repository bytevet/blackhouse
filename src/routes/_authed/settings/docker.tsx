import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  getDockerConfig,
  updateDockerConfig,
  getDockerStatus,
  listContainers,
} from "@/server/settings";
import { getServerSession } from "@/lib/auth-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Save } from "lucide-react";
import { timeAgo } from "@/lib/time";

export const Route = createFileRoute("/_authed/settings/docker")({
  beforeLoad: async () => {
    const session = await getServerSession();
    if (!session || session.user.role !== "admin") {
      throw redirect({ to: "/settings/profile" });
    }
  },
  component: DockerTab,
});

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
                      {c.sessionName || "\u2014"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {c.createdAt ? timeAgo(c.createdAt) : "\u2014"}
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
