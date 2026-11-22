import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { msg, useGT } from "@t3tools/shared/i18n/react";
import { m } from "~/i18n/messages";
import { ChevronDownIcon, ChevronUpIcon, MinusIcon, PlusIcon, ScanIcon } from "~/ui-core/icons";
import { Input } from "~/components/ui/input";
import { observeResize } from "~/lib/observeResize";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { readBoundedDocument } from "./readBoundedDocument";
import { previewErrorText } from "./previewFailureMessages";
import { openPdf, pdfSpanScale, type PdfDocument, type PdfTextItem } from "./pdfDocument";
import {
  currentPdfPage,
  pdfFindIncludes,
  pdfFindMatchRuns,
  pdfPageOffsets,
  pdfPageScrollTop,
  pdfPageText,
  pdfPageWidth,
  pdfRestoredScrollTop,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  stepPdfZoom,
  visiblePdfPages,
} from "./pdfLayout";
import "./pdfViewer.css";

const MAX_PAGES = 2000;
const MAX_FIND_TEXT = 4 * 1024 * 1024;

const MAX_POSITIONS = 50;
type PdfPosition = PdfViewState & { width: number; ratios: readonly number[] };
// Thread switches unmount the preview; retain only the most recent documents.
const positions = new Map<string, PdfPosition>();

type PdfLink = ReturnType<PdfDocument["links"]>[number];

export type PdfViewState = {
  page: number;
  offset: number;
  zoom: number | null;
  left: number;
};

function PdfPage(props: {
  document: PdfDocument;
  index: number;
  width: number;
  query: string;
  onSize: (index: number, ratio: number) => void;
  onError: (error: string) => void;
  onPageLink: (index: number) => void;
  onOpenLink: ((url: string, event: MouseEvent) => void) | undefined;
}) {
  const gt = useGT();
  const [links, setLinks] = useState<readonly PdfLink[]>([]);
  const [spans, setSpans] = useState<readonly PdfTextItem[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useRef<PdfDocument>(null);
  const { document: pdf, index, width, onSize, onError } = props;
  const page = pdf.pages[index]!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the PDF page canvas and read its text and links, cancelling when the page or width changes.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      // A drag changes the width every frame. CSS scales the painted page until the width settles.
      if (painted.current === pdf)
        await new Promise((resolve) => (timer = setTimeout(resolve, 150)));
      if (controller.signal.aborted || !canvas.current) return;
      onSize(index, page.height / page.width);
      const scale = width / page.width;
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (width * width * (page.height / page.width))),
      );
      // Resizing a canvas blanks it, so the page paints off screen and replaces the old one whole.
      const buffer = document.createElement("canvas");
      buffer.width = Math.ceil(width * ratio);
      buffer.height = Math.ceil(width * (page.height / page.width) * ratio);
      const context = buffer.getContext("2d", { alpha: false });
      if (!context) throw new Error(m(msg("This PDF page could not render.")));
      context.scale(scale * ratio, scale * ratio);
      setLinks(pdf.links(index));
      const items = await pdf.paint(index, context, controller.signal);
      if (controller.signal.aborted || !canvas.current) return;
      canvas.current.width = buffer.width;
      canvas.current.height = buffer.height;
      canvas.current.getContext("2d", { alpha: false })?.drawImage(buffer, 0, 0);
      buffer.width = 0;
      painted.current = pdf;
      setSpans(items);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        onError(thrownErrorMessage(cause, m) ?? m(msg("This PDF page could not render.")));
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pdf, page, index, width, onSize, onError]);
  const runs = spans.flatMap((span) => (span.hasEOL ? [span.str, "\n"] : [span.str]));
  const hits = pdfFindMatchRuns(runs, props.query);
  const runIndex: number[] = [];
  spans.reduce((at, span) => (runIndex.push(at), at + (span.hasEOL ? 2 : 1)), 0);
  const scale = width / page.width;
  return (
    <>
      <canvas
        ref={canvas}
        aria-label={gt("Page {number}", { number: String(index + 1) })}
        className="block h-full w-full"
      />
      <div data-pdf-text-layer>
        {spans.map((span, position) => {
          const hit = hits[runIndex[position]!];
          const style = {
            left: `${(span.x / page.width) * 100}%`,
            top: `${((span.y - span.height * 0.86) / page.height) * 100}%`,
            "--font-height": `${span.height}px`,
            "--rotate": `${span.angle}rad`,
            "--scale-x": pdfSpanScale(span.str, span.height * scale, span.width * scale),
            transformOrigin: `0 ${span.height * scale * 0.86}px`,
          } as CSSProperties;
          return (
            // oxlint-disable-next-line react/no-array-index-key -- Runs keep their reading order within an immutable page.
            <Fragment key={position}>
              <span role="presentation" className={hit ? "pdf-find-match" : undefined} style={style}>
                {span.str}
              </span>
              {span.hasEOL ? <br /> : null}
            </Fragment>
          );
        })}
      </div>
      {links.length ? (
        <div className="pointer-events-none absolute inset-0">
          {links.map((link) => {
            const [left, top, width, height] = link.rect;
            const key = `${link.rect.join()}:${"url" in link ? link.url : link.page}`;
            const style = {
              left: `${left * 100}%`,
              top: `${top * 100}%`,
              width: `${width * 100}%`,
              height: `${height * 100}%`,
            };
            return "url" in link ? (
              <a
                key={key}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={link.url}
                className="pointer-events-auto absolute"
                style={style}
                onClick={(event) => {
                  if (!props.onOpenLink) return;
                  event.preventDefault();
                  props.onOpenLink(link.url, event);
                }}
              />
            ) : (
              <a
                key={key}
                href={`#page=${link.page + 1}`}
                aria-label={gt("Page {number}", { number: String(link.page + 1) })}
                className="pointer-events-auto absolute"
                style={style}
                onClick={(event) => {
                  event.preventDefault();
                  props.onPageLink(link.page);
                }}
              />
            );
          })}
        </div>
      ) : null}
    </>
  );
}

export default function PdfViewer(props: {
  src: string;
  title: string;
  positionKey?: string;
  initialView?: PdfViewState;
  onViewChange?: (view: PdfViewState) => void;
  onOpenLink?: (url: string, event: MouseEvent) => void;
  actions?: ReactNode;
}) {
  const gt = useGT();
  const [savedPosition] = useState(() =>
    props.positionKey === undefined ? undefined : positions.get(props.positionKey),
  );
  const [initialView] = useState<PdfViewState>(
    () => savedPosition ?? props.initialView ?? { page: 0, offset: 0, zoom: null, left: 0 },
  );
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ratios, setRatios] = useState<readonly number[]>([]);
  const [zoom, setZoom] = useState(initialView.zoom);
  const [pageWidth, setPageWidth] = useState(612);
  const [viewport, setViewport] = useState({ width: 600, height: 800 });
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [match, setMatch] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const zoomAnchor = useRef<{ page: number; offset: number; width: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the PDF fetch, load timeout, and parse across source changes, retries, and unmounts.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => {
      setError(m(msg("This PDF took too long to load. Try again.")));
      controller.abort();
    }, 30_000);
    void readBoundedDocument(
      props.src,
      controller.signal,
      50 * 1024 * 1024,
      revision > 0 ? "reload" : "default",
    )
      .then(async (bytes) => {
        controller.signal.throwIfAborted();
        const document = await openPdf(bytes);
        if (document.numPages > MAX_PAGES)
          throw new Error(
            m(msg("Preview limited to 2,000 pages. Save this PDF to read it in full.")),
          );
        if (controller.signal.aborted) return;
        setPageWidth(document.pages[0]!.width);
        setRatios(
          savedPosition?.ratios.length === document.numPages
            ? savedPosition.ratios
            : document.pages.map((page) => page.height / page.width),
        );
        setPdf(document);
      })
      .catch((cause: unknown) => {
        if (!disposed && !controller.signal.aborted)
          setError(previewErrorText(cause, m(msg("Unable to open PDF."))));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [props.src, revision, savedPosition]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the PDF viewport before paint and observe resizes for fit-width sizing and visible-page selection.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    return observeResize(node, update);
  }, []);
  const { scale, width } = pdfPageWidth(viewport.width, pageWidth, zoom);
  const offsets = pdfPageOffsets(ratios, width);
  const current = currentPdfPage(offsets, ratios.length, scrollTop);
  const visible = visiblePdfPages(ratios, offsets, scrollTop, viewport.height);
  // Stable callbacks let page canvases survive scroll and find updates.
  const [onSize] = useState(
    () => (index: number, ratio: number) =>
      setRatios((old) =>
        old[index] === ratio ? old : old.map((value, i) => (i === index ? ratio : value)),
      ),
  );
  const jumpToPage = useEffectEvent((index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(offsets, index) });
  });
  const saveView = (node: HTMLDivElement, notify = true) => {
    const page = currentPdfPage(offsets, ratios.length, node.scrollTop);
    if (!pdf) return;
    const view = {
      page,
      offset: Math.max(0, node.scrollTop - (offsets[page]! - 16)),
      zoom,
      left: node.scrollLeft,
    };
    if (notify) props.onViewChange?.(view);
    if (props.positionKey !== undefined) {
      positions.delete(props.positionKey);
      positions.set(props.positionKey, { ...view, width, ratios });
      const oldest = positions.keys().next();
      if (positions.size > MAX_POSITIONS && !oldest.done) positions.delete(oldest.value);
    }
  };
  const restoreView = useEffectEvent(() => {
    const node = scroll.current;
    if (!pdf || !node) return;
    node.scrollTo({
      top: pdfRestoredScrollTop(ratios, width, initialView, savedPosition?.width),
      left: initialView.left,
    });
    setScrollTop(node.scrollTop);
    saveView(node);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the saved PDF scroll position after the loaded document's page layout commits.
  useLayoutEffect(() => {
    if (pdf) restoreView();
  }, [pdf]);
  const showPage = (index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(offsets, index) });
  };
  const changeZoom = (value: number | null) => {
    zoomAnchor.current = {
      page: current,
      offset: (scroll.current?.scrollTop ?? 0) - (offsets[current]! - 16),
      width,
    };
    setZoom(value);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the DOM scroll anchor after the new zoom width has committed to page layout.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const node = scroll.current;
    if (!node || !pdf) return;
    if (anchor && anchor.width !== width) {
      node.scrollTo({
        top: offsets[anchor.page]! - 16 + (anchor.offset * width) / anchor.width,
      });
    }
    saveView(node, anchor !== null);
  });
  const firstMatch = matches[0];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll to the first asynchronous search result after its measured page offsets have committed.
  useLayoutEffect(() => {
    if (firstMatch !== undefined) jumpToPage(firstMatch);
  }, [firstMatch]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce PDF text extraction and cancel obsolete searches when the query or document changes.
  useEffect(() => {
    if (!pdf || !query.trim()) {
      // oxlint-disable-next-line react/set-state-in-effect -- A blank query cancels the previous search.
      setFinding(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setFinding(true);
      setFindError(null);
      setMatches([]);
      setMatch(0);
      void (async () => {
        const found: number[] = [];
        let size = 0;
        for (let index = 0; index < pdf.numPages; index++) {
          const items = await pdf.text(index);
          if (cancelled) return;
          const text = pdfPageText(items);
          size += text.length;
          if (size > MAX_FIND_TEXT)
            throw new Error(
              m(msg("This PDF has too much text to search. Save it to search in another app.")),
            );
          if (!pdfFindIncludes(text, query)) continue;
          found.push(index);
          if (found.length === 1) setMatches([index]);
        }
        if (cancelled) return;
        setMatches(found);
      })()
        .catch((cause: unknown) => {
          if (!cancelled)
            setFindError(thrownErrorMessage(cause, m) ?? m(msg("Could not search this PDF.")));
        })
        .finally(() => {
          if (!cancelled) setFinding(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pdf, query]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs">
        <span className="mr-auto px-1 tabular-nums" aria-live="polite">
          {pdf
            ? gt(
                "{count, plural, one {{current} / {count} page} other {{current} / {count} pages}}",
                {
                  count: pdf.numPages,
                  current: String(current + 1),
                },
              )
            : "PDF"}
        </span>
        <FileSurfaceAction
          label={gt("Previous page")}
          disabled={!pdf || current === 0}
          onPress={() => showPage(current - 1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Next page")}
          disabled={!pdf || current + 1 >= pdf.numPages}
          onPress={() => showPage(current + 1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Zoom out")}
          disabled={scale <= PDF_MIN_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, -1))}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-14 text-center tabular-nums">
          {zoom === null ? gt("Fit width") : `${Math.round(scale * 100)}%`}
        </span>
        <FileSurfaceAction
          label={gt("Zoom in")}
          disabled={scale >= PDF_MAX_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, 1))}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Fit width")}
          onPress={() => {
            changeZoom(null);
            scroll.current?.scrollTo({ left: 0 });
          }}
        >
          <ScanIcon className="size-3.5" />
        </FileSurfaceAction>
        <div className="w-28">
          <Input
            ref={find}
            size="compact"
            type="search"
            aria-label={gt("Find in PDF")}
            placeholder={gt("Find in PDF")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches([]);
              setFindError(null);
            }}
          />
        </div>
        {query ? (
          <>
            <span role="status">
              {finding
                ? gt("Searching…")
                : (findError ?? `${matches.length ? match + 1 : 0}/${matches.length}`)}
            </span>
            <FileSurfaceAction
              label={gt("Next matching page")}
              disabled={!matches.length}
              onPress={() => {
                const next = (match + 1) % matches.length;
                setMatch(next);
                showPage(matches[next]!);
              }}
            >
              <ChevronDownIcon className="size-3.5" />
            </FileSurfaceAction>
          </>
        ) : null}
        {props.actions}
      </div>
      <div
        ref={scroll}
        role="region"
        aria-label={props.title}
        tabIndex={0}
        className="relative min-h-0 min-w-0 w-full flex-1 overflow-auto scrollbar-gutter-stable bg-muted/40"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setScrollTop(top);
          saveView(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "f") {
            event.preventDefault();
            event.stopPropagation();
            find.current?.focus();
          }
        }}
      >
        {error ? (
          <FileSurfaceFailure
            message={error}
            onRetry={() => {
              setError(null);
              setPdf(null);
              setRevision((value) => value + 1);
            }}
          />
        ) : !pdf ? (
          <FileSurfaceLoading />
        ) : (
          <div
            className="relative"
            style={{
              height: `max(${offsets.at(-1) ?? 0}px, calc(100% + ${(offsets.at(-2) ?? 16) - 16}px))`,
              minWidth: width + 32,
            }}
          >
            {visible.map(({ index, ratio }) => (
              <div
                key={index}
                className="absolute bg-white shadow-sm"
                style={
                  {
                    top: offsets[index],
                    left: Math.max(16, (viewport.width - width) / 2),
                    width,
                    height: width * ratio,
                    "--total-scale-factor": 1,
                  } as CSSProperties
                }
              >
                <PdfPage
                  document={pdf}
                  index={index}
                  width={width}
                  query={query}
                  onSize={onSize}
                  onError={setError}
                  onPageLink={showPage}
                  onOpenLink={props.onOpenLink}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
