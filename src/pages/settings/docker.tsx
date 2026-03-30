import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useSession } from "@/lib/auth-client";
import { client, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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

interface ContainerInfo {
  containerId: string;
  image: string;
  status: string;
  session?: { name: string } | null;
  created?: number;
}

export function DockerPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [dockerStatus, setDockerStatus] = useState<{ connected: boolean; version?: string } | null>(
    null,
  );
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    socketPath: "",
    host: "",
    port: "",
  });

  useEffect(() => {
    if (!isAdmin && session) {
      navigate("/settings/profile", { replace: true });
      return;
    }
    const load = async () => {
      try {
        const [status, config, containerList] = await Promise.all([
          client.api.settings.docker.status
            .$get()
            .then((r) => unwrap<{ connected: boolean; version?: string }>(r)),
          client.api.settings.docker
            .$get()
            .then((r) => unwrap<{ socketPath?: string; host?: string; port?: number }>(r)),
          client.api.settings.containers.$get().then((r) => unwrap<ContainerInfo[]>(r)),
        ]);
        setDockerStatus(status);
        setContainers(containerList);
        setFormData({
          socketPath: config?.socketPath || "",
          host: config?.host || "",
          port: config?.port?.toString() || "",
        });
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isAdmin, session, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await client.api.settings.docker.$put({
        json: {
          socketPath: formData.socketPath.trim() || undefined,
          host: formData.host.trim() || undefined,
          port: formData.port ? parseInt(formData.port, 10) : undefined,
        },
      });
      const status = await client.api.settings.docker.status
        .$get()
        .then((r) => unwrap<{ connected: boolean; version?: string }>(r));
      setDockerStatus(status);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading Docker configuration...</div>;
  }

  const isConnected = dockerStatus?.connected ?? false;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Connection Status</h2>
        <div className="flex items-center gap-2">
          <Badge variant={isConnected ? "default" : "destructive"}>
            {isConnected ? "Connected" : "Disconnected"}
          </Badge>
          {dockerStatus?.version && (
            <span className="text-xs text-muted-foreground">v{dockerStatus.version}</span>
          )}
        </div>
      </div>

      <div className="max-w-md space-y-3">
        <h2 className="text-sm font-medium text-foreground">Configuration</h2>
        <p className="text-xs text-muted-foreground">
          Configure how Blackhouse connects to the Docker daemon.
        </p>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel>Socket Path</FieldLabel>
              <Input
                placeholder="/var/run/docker.sock"
                value={formData.socketPath}
                onChange={(e) => setFormData((prev) => ({ ...prev, socketPath: e.target.value }))}
              />
            </Field>

            <Field>
              <FieldLabel>Host</FieldLabel>
              <Input
                placeholder="localhost"
                value={formData.host}
                onChange={(e) => setFormData((prev) => ({ ...prev, host: e.target.value }))}
              />
            </Field>

            <Field>
              <FieldLabel>Port</FieldLabel>
              <Input
                type="number"
                placeholder="2375"
                value={formData.port}
                onChange={(e) => setFormData((prev) => ({ ...prev, port: e.target.value }))}
              />
            </Field>

            <Button type="submit" disabled={saving} className="w-fit">
              <Save className="size-3" />
              {saving ? "Saving..." : "Save Config"}
            </Button>
          </FieldGroup>
        </form>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Active Containers</h2>
        <p className="text-xs text-muted-foreground">Containers managed by Blackhouse sessions.</p>
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
                  <TableRow key={c.containerId}>
                    <TableCell className="font-mono text-xs">
                      {c.containerId?.slice(0, 12)}
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-muted-foreground">
                      {c.image}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {c.session?.name || "\u2014"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {c.created ? timeAgo(new Date(c.created * 1000)) : "\u2014"}
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
