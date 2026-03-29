import { useState, useCallback, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  gitStatus?: string;
}

interface FileExplorerProps {
  sessionId: string;
  onFileSelect: (path: string) => void;
  selectedFile?: string;
  rootPath?: string;
  status?: string;
}

function fileListFingerprint(files: FileNode[]): string {
  return files.map((f) => `${f.name}:${f.isDirectory}:${f.gitStatus ?? ""}`).join("|");
}

export function FileExplorer({
  sessionId,
  onFileSelect,
  selectedFile,
  rootPath = "/workspace",
  status,
}: FileExplorerProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  const loadDirectory = useCallback(
    async (path: string) => {
      try {
        const { listFiles } = await import("@/server/files");
        const files = await listFiles({ data: { sessionId, path } });
        return files as FileNode[];
      } catch {
        setError("Failed to load files");
        return [];
      }
    },
    [sessionId],
  );

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    const files = await loadDirectory(rootPath);
    setTree(files);
    setLoading(false);
  }, [loadDirectory, rootPath]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  // Poll for changes when session is running
  useEffect(() => {
    if (status !== "running") return;

    const poll = async () => {
      try {
        // Re-fetch root
        const newRoot = await loadDirectory(rootPath);
        setTree((prev) => {
          if (fileListFingerprint(prev) === fileListFingerprint(newRoot)) return prev;
          // Preserve children of expanded dirs
          return mergeTree(prev, newRoot);
        });

        // Re-fetch expanded directories in parallel, batch into single state update
        const expanded = Array.from(expandedPathsRef.current);
        const results = await Promise.all(expanded.map((dirPath) => loadDirectory(dirPath)));
        setTree((prev) => {
          let tree = prev;
          for (let i = 0; i < expanded.length; i++) {
            const dirPath = expanded[i];
            const newChildren = results[i];
            const existing = findNode(tree, dirPath)?.children;
            if (!existing || fileListFingerprint(existing) !== fileListFingerprint(newChildren)) {
              tree = updateTreeChildren(tree, dirPath, newChildren);
            }
          }
          return tree;
        });
      } catch {
        // ignore polling errors
      }
    };

    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [status, rootPath, loadDirectory]);

  const toggleDir = async (path: string) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      const children = await loadDirectory(path);
      setTree((prev) => updateTreeChildren(prev, path, children));
    }
    setExpandedPaths(next);
  };

  return (
    <div className="h-full overflow-auto text-xs">
      {loading && <div className="p-2 text-muted-foreground">Loading files...</div>}
      {error && <div className="p-2 text-destructive">{error}</div>}
      {!loading && tree.length === 0 && (
        <div className="p-2 text-muted-foreground">No files found</div>
      )}
      <div className="py-1">
        {tree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            expandedPaths={expandedPaths}
            selectedFile={selectedFile}
            onToggleDir={toggleDir}
            onFileSelect={onFileSelect}
          />
        ))}
      </div>
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  expandedPaths,
  selectedFile,
  onToggleDir,
  onFileSelect,
}: {
  node: FileNode;
  depth: number;
  expandedPaths: Set<string>;
  selectedFile?: string;
  onToggleDir: (path: string) => void;
  onFileSelect: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedFile === node.path;

  return (
    <>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-muted/50",
          isSelected && "bg-muted text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (node.isDirectory) {
            onToggleDir(node.path);
          } else {
            onFileSelect(node.path);
          }
        }}
      >
        {node.isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            {isExpanded ? (
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <>
            <span className="size-3 shrink-0" />
            <File className={cn("size-3.5 shrink-0", fileIconColor(node.name))} />
          </>
        )}
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="truncate">{node.name}</span>
          {node.gitStatus && <GitStatusBadge status={node.gitStatus} />}
        </span>
      </button>
      {node.isDirectory && isExpanded && node.children && (
        <>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedFile={selectedFile}
              onToggleDir={onToggleDir}
              onFileSelect={onFileSelect}
            />
          ))}
        </>
      )}
    </>
  );
}

function updateTreeChildren(
  tree: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return tree.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

function mergeTree(oldTree: FileNode[], newTree: FileNode[]): FileNode[] {
  return newTree.map((newNode) => {
    const oldNode = oldTree.find((o) => o.path === newNode.path);
    if (oldNode?.children && newNode.isDirectory) {
      return { ...newNode, children: oldNode.children };
    }
    return newNode;
  });
}

function findNode(tree: FileNode[], path: string): FileNode | undefined {
  for (const node of tree) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

const GIT_STATUS_CONFIG: Record<string, { label: string; tooltip: string; className: string }> = {
  M: { label: "M", tooltip: "Modified", className: "text-yellow-500" },
  U: { label: "U", tooltip: "Untracked", className: "text-green-500" },
  D: { label: "D", tooltip: "Deleted", className: "text-red-500" },
};

function GitStatusBadge({ status }: { status: string }) {
  const c = GIT_STATUS_CONFIG[status] ?? GIT_STATUS_CONFIG.M;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={`shrink-0 cursor-default text-xs font-semibold ${c.className}`}>
            {c.label}
          </span>
        }
      />
      <TooltipContent side="right" className="text-xs">
        {c.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function fileIconColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const lname = name.toLowerCase();
  if (lname === "dockerfile" || lname.startsWith("dockerfile.")) return "text-sky-400";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "text-blue-400";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "text-yellow-400";
    case "json":
      return "text-yellow-600";
    case "css":
    case "scss":
    case "less":
      return "text-purple-400";
    case "html":
    case "htm":
      return "text-orange-400";
    case "md":
    case "mdx":
      return "text-slate-400";
    case "py":
      return "text-green-400";
    case "rs":
      return "text-orange-500";
    case "go":
      return "text-cyan-400";
    case "sh":
    case "bash":
    case "zsh":
      return "text-green-500";
    case "yaml":
    case "yml":
    case "toml":
      return "text-red-400";
    case "sql":
      return "text-pink-400";
    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "ico":
      return "text-emerald-400";
    default:
      return "text-muted-foreground";
  }
}
