import { createFileRoute } from "@tanstack/react-router";
import { listTemplates } from "@/server/templates";
import type { Template } from "@/db/schema";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/time";

export const Route = createFileRoute("/_authed/templates/public")({
  loader: () => listTemplates({ data: { mine: false } }),
  component: PublicTemplatesPage,
});

function PublicTemplatesPage() {
  const templates = Route.useLoaderData() as Template[];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Browse templates shared by other users on the platform.
      </p>
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No public templates available yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{template.name}</span>
                  <span className="flex shrink-0 gap-1">
                    {template.gitRequired && <Badge className="shrink-0">Git Required</Badge>}
                    <Badge variant="outline" className="shrink-0">
                      Public
                    </Badge>
                  </span>
                </CardTitle>
                {template.description && (
                  <CardDescription className="line-clamp-2">{template.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground">
                  Created {timeAgo(template.createdAt)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
