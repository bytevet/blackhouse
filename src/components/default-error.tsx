import type { ErrorComponentProps } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function DefaultErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "An unexpected error occurred."}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            reset();
            router.invalidate();
          }}
        >
          Try again
        </Button>
        <Button size="sm" onClick={() => router.navigate({ to: "/" })}>
          Go home
        </Button>
      </div>
    </div>
  );
}
