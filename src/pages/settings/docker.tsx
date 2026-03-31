import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useSession } from "@/lib/auth-client";
import { client, unwrap, type Paginated } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Save, ChevronLeft, ChevronRight } from "lucide-react";
import { timeAgo } from "@/lib/time";

interface ContainerInfo {
  containerId: string;
  image: string;
  status: string;
  session?: { name: string } | null;
  created?: number;
}

interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  size: number | null;
  refCount: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function DockerPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [dockerStatus, setDockerStatus] = useState<{
    connected: boolean;
    version?: string;
    error?: string;
  } | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersTotal, setContainersTotal] = useState(0);
  const [containersPage, setContainersPage] = useState(1);
  const containersPerPage = 20;
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
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
        const [status, config, containerList, volumeList] = await Promise.all([
          client.api.settings.docker.status
            .$get()
            .then((r) => unwrap<{ connected: boolean; version?: string; error?: string }>(r)),
          client.api.settings.docker
            .$get()
            .then((r) => unwrap<{ socketPath?: string; host?: string; port?: number }>(r)),
          client.api.settings.containers
            .$get({ query: { page: String(containersPage), perPage: String(containersPerPage) } })
            .then((r) => unwrap<Paginated<ContainerInfo>>(r)),
          client.api.settings.volumes.$get().then((r) => unwrap<VolumeInfo[]>(r)),
        ]);
        setDockerStatus(status);
        setContainers(containerList.data);
        setContainersTotal(containerList.total);
        setVolumes(volumeList);
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
  }, [isAdmin, session, navigate, containersPage]);

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
        .then((r) => unwrap<{ connected: boolean; version?: string; error?: string }>(r));
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection Status
            <Badge variant={isConnected ? "default" : "destructive"}>
              {isConnected ? "Connected" : "Disconnected"}
            </Badge>
            {dockerStatus?.version && (
              <span className="text-xs font-normal text-muted-foreground">
                v{dockerStatus.version}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {!isConnected && dockerStatus?.error ? (
              <span className="text-destructive">{dockerStatus.error}</span>
            ) : (
              "Configure how Blackhouse connects to the Docker daemon."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-md">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Containers</CardTitle>
          <CardDescription>Containers managed by Blackhouse sessions.</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {Math.ceil(containersTotal / containersPerPage) > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={containersPage <= 1}
            onClick={() => setContainersPage((p) => p - 1)}
          >
            <ChevronLeft className="size-3" /> Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {containersPage} of {Math.ceil(containersTotal / containersPerPage)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={containersPage >= Math.ceil(containersTotal / containersPerPage)}
            onClick={() => setContainersPage((p) => p + 1)}
          >
            Next <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Volumes</CardTitle>
          <CardDescription>
            Docker volumes used by agent credential mounts and session data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            const hasUsageData = volumes.some((v) => v.size != null || v.refCount != null);
            return (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead className="hidden sm:table-cell">Mountpoint</TableHead>
                    {hasUsageData && <TableHead>Size</TableHead>}
                    {hasUsageData && <TableHead>In Use</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {volumes.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={hasUsageData ? 5 : 3}
                        className="text-center text-muted-foreground"
                      >
                        No volumes found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    volumes.map((v) => (
                      <TableRow key={v.name}>
                        <TableCell className="font-mono text-xs">{v.name}</TableCell>
                        <TableCell className="text-muted-foreground">{v.driver}</TableCell>
                        <TableCell
                          className="hidden max-w-60 truncate text-muted-foreground sm:table-cell"
                          title={v.mountpoint}
                        >
                          {v.mountpoint}
                        </TableCell>
                        {hasUsageData && (
                          <TableCell className="text-muted-foreground">
                            {v.size != null ? formatBytes(v.size) : "\u2014"}
                          </TableCell>
                        )}
                        {hasUsageData && (
                          <TableCell>
                            {v.refCount != null && v.refCount > 0 ? (
                              <Badge variant="outline">{v.refCount}</Badge>
                            ) : (
                              <span className="text-muted-foreground">{"\u2014"}</span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}
