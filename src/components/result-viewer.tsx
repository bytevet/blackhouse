interface ResultViewerProps {
  html: string;
}

export function ResultViewer({ html }: ResultViewerProps) {
  return (
    <div className="h-full w-full">
      <iframe
        srcDoc={html}
        sandbox="allow-scripts"
        className="h-full w-full border-0 bg-white"
        title="Session Result"
      />
    </div>
  );
}
