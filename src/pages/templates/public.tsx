import { useState, useEffect } from "react";
import { client, unwrap } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/time";
import type { Template } from "@/db/schema";

export function PublicTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.api.templates
      .$get({ query: { mine: "false" } })
      .then((r) => unwrap<Template[]>(r))
      .then(setTemplates)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading public templates...</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Browse templates shared by other users on the platform.
      </p>
      {templates.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No public templates available yet.</p>
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
