import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import {
  getDockerConfig,
  updateDockerConfig,
  getDockerStatus,
  listContainers,
} from "@/server/settings";
import { getServerSession } from "@/lib/auth-server";
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

const dockerConfigSchema = z.object({
  socketPath: z.string(),
  host: z.string(),
  port: z.string(),
});

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
  const [containers, setContainers] = useState<
    { id: string; image: string; status: string; sessionName?: string; createdAt?: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  const form = useForm({
    defaultValues: { socketPath: "", host: "", port: "" },
    validators: { onSubmit: dockerConfigSchema },
    onSubmit: async ({ value }) => {
      await updateDockerConfig({
        data: {
          socketPath: value.socketPath.trim() || undefined,
          host: value.host.trim() || undefined,
          port: value.port ? parseInt(value.port, 10) : undefined,
        },
      });
      const status = await getDockerStatus();
      setDockerStatus(status);
    },
  });

  useEffect(() => {
    const load = async () => {
      try {
        const [status, config, containerList] = await Promise.all([
          getDockerStatus(),
          getDockerConfig(),
          listContainers(),
        ]);
        setDockerStatus(status);
        setContainers(containerList);
        form.setFieldValue("socketPath", config?.socketPath || "");
        form.setFieldValue("host", config?.host || "");
        form.setFieldValue("port", config?.port?.toString() || "");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field
              name="socketPath"
              children={(field) => (
                <Field>
                  <FieldLabel>Socket Path</FieldLabel>
                  <Input
                    placeholder="/var/run/docker.sock"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            />

            <form.Field
              name="host"
              children={(field) => (
                <Field>
                  <FieldLabel>Host</FieldLabel>
                  <Input
                    placeholder="localhost"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            />

            <form.Field
              name="port"
              children={(field) => (
                <Field>
                  <FieldLabel>Port</FieldLabel>
                  <Input
                    type="number"
                    placeholder="2375"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            />

            <Button type="submit" disabled={form.state.isSubmitting} className="w-fit">
              <Save className="size-3" />
              {form.state.isSubmitting ? "Saving..." : "Save Config"}
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
