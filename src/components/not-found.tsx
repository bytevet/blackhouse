import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold text-foreground">Page not found</h2>
      <p className="text-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Button size="sm" asChild>
        <Link to="/">Go home</Link>
      </Button>
    </div>
  );
}
