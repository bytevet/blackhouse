import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { client, unwrap, type Paginated } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { Template } from "@/db/schema";

export function PublicTemplatesPage() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 12;
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.api.templates
      .$get({ query: { mine: "false", page: String(page), perPage: String(perPage) } })
      .then((r) => unwrap<Paginated<Template>>(r))
      .then((result) => {
        setTemplates(result.data);
        setTotal(result.total);
      })
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t("briefings.loadingPublic")}</div>;
  }

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("briefings.publicDescription")}</p>
      {templates.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t("briefings.publicEmptyState")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{template.name}</span>
                  <span className="flex shrink-0 gap-1">
                    {template.gitRequired && (
                      <Badge className="shrink-0">{t("dashboard.form.gitRequired")}</Badge>
                    )}
                    <Badge variant="outline" className="shrink-0">
                      {t("dashboard.form.public")}
                    </Badge>
                  </span>
                </CardTitle>
                {template.description && (
                  <CardDescription className="line-clamp-2">{template.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground">
                  {t("briefings.created", { when: timeAgo(template.createdAt) })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="size-3" /> {t("common.prev")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("dashboard.pageOf", { current: page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.next")} <ChevronRight className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
