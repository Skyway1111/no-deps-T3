import { elToReact } from "@t3tools/shared/markdownHast";
import { T, useGT, Var } from "@t3tools/shared/i18n/react";
import { use, useState, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { serializeCodeBlockToMarkdown } from "../../markdown-clipboard";
import { Button } from "../ui/button";

type Engine = typeof import("@t3tools/shared/diagrams/mermaid");
// React types `jsx` for its own element types; the engine passes only intrinsic SVG tags.
const runtime = { Fragment, jsx, jsxs } as Parameters<typeof elToReact>[1];
let engineLoad: Promise<Engine | null> | null = null;
// The engine is its own chunk, loaded by the first diagram a chat shows.
function loadEngine() {
  engineLoad ??= import("@t3tools/shared/diagrams/mermaid").catch(() => null);
  return engineLoad;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
const DIAGRAM_FONT =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
function measureText(text: string, size: number, bold: boolean) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * size * 0.55;
  measureContext.font = `${bold ? 600 : 400} ${size}px ${DIAGRAM_FONT}`;
  return measureContext.measureText(text).width;
}

// The renderer colors diagrams through these, which a standalone image cannot inherit.
const DIAGRAM_COLOR_VARIABLES = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`),
];

let expandedImageUrl: string | null = null;

/**
 * A blob URL, unlike a data URL, passes the desktop connect-src policy that media
 * save and copy actions fetch through.
 */
function diagramImageUrl(svg: SVGSVGElement): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);
  for (const name of DIAGRAM_COLOR_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) element.style.setProperty(name, value);
  }
  element.style.maxWidth = "none";
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

/** Diagrams can come from untrusted PR descriptions; the engine builds elements from parsed text, never markup. */
export function MermaidDiagram({
  source,
  onExpand,
}: {
  source: string;
  onExpand: (imageUrl: string) => void;
}) {
  const gt = useGT();
  const [, setAttempt] = useState(0);
  const engine = use(loadEngine());
  const trimmedSource = source.trim();
  const rendered = ((): { svg: ReactNode } | { error: string } | null => {
    if (!engine) return null;
    try {
      return {
        svg: elToReact<ReactNode>(
          engine.renderMermaidTree(trimmedSource, { measureText }).svg,
          runtime,
        ),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : gt("The diagram could not be rendered."),
      };
    }
  })();

  if (!rendered) {
    return (
      <DiagramError
        message={gt("The diagram renderer failed to load.")}
        source={source}
        onRetry={() => {
          engineLoad = null;
          setAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <div
      className="chat-markdown-mermaid overflow-x-auto"
      data-markdown-mermaid=""
      data-markdown-copy={serializeCodeBlockToMarkdown(source, "mermaid")}
    >
      {"error" in rendered ? (
        <DiagramError message={rendered.error} source={source} />
      ) : (
        <button
          type="button"
          aria-label={gt("Expand diagram")}
          className="block w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            const svg = event.currentTarget.querySelector("svg");
            if (svg) onExpand(diagramImageUrl(svg));
          }}
        >
          <span className="flex w-full justify-center">{rendered.svg}</span>
        </button>
      )}
    </div>
  );
}

function DiagramError({
  message,
  source,
  onRetry,
}: {
  message: string;
  source: string;
  onRetry?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-xs text-destructive">
          <T>
            Unable to render diagram: <Var>{message}</Var>
          </T>
        </p>
        {onRetry ? (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            <T>Retry</T>
          </Button>
        ) : null}
      </div>
      <pre
        data-thread-find-ignore
        className="mt-2 mb-0 overflow-auto font-mono text-xs whitespace-pre-wrap"
      >
        {source}
      </pre>
    </div>
  );
}
