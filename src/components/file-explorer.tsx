import { useState, useCallback, useEffect } from "react";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-react";
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
}

export function FileExplorer({ sessionId, onFileSelect, selectedFile }: FileExplorerProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const files = await loadDirectory("/workspace");
    setTree(files);
    setLoading(false);
  }, [loadDirectory]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

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
            <File className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{node.name}</span>
        {node.gitStatus && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {node.gitStatus}
          </span>
        )}
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
