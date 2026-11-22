/* oxlint-disable react/no-array-index-key -- A page keeps its ordinal throughout incremental layout. */
import { useGT } from "@t3tools/shared/i18n/react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type PageSize = {
  readonly width: number;
  readonly height: number;
  readonly background?: string | undefined;
};
export type PaintPage = (
  index: number,
  canvas: HTMLCanvasElement,
  scale: number,
  signal: AbortSignal,
) => Promise<void>;

export function OfficePages(props: {
  pages: readonly PageSize[];
  paint: PaintPage;
  kind: "slide" | "page";
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  scrollRef?: RefObject<((index: number, y?: number) => void) | null>;
  onPageChange?: (index: number) => void;
  onError: (error: unknown) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Page rows in document order, so scrolling finds the current page by binary search.
  const rows = useRef<(HTMLDivElement | undefined)[]>([]);
  const [width, setWidth] = useState(0);
  const [settledWidth, setSettledWidth] = useState(0);
  const [mounted, setMounted] = useState(6);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  const observer = useRef<IntersectionObserver | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- One observer tracks which pages are near the viewport, limiting painting and text layers to them.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) =>
        setNear((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.officePage);
            if (entry.isIntersecting) next.add(index);
            else next.delete(index);
          }
          return next.size === previous.size && [...next].every((i) => previous.has(i))
            ? previous
            : next;
        }),
      { root: scroller.current, rootMargin: "100% 0px" },
    );
    observer.current = io;
    for (const row of rows.current) if (row) io.observe(row);
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, []);
  const track = useStableCallback((index: number, row: HTMLDivElement | undefined) => {
    const previous = rows.current[index];
    if (previous && previous !== row) observer.current?.unobserve(previous);
    rows.current[index] = row;
    if (row) observer.current?.observe(row);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to display density changes so canvas rasters match the current screen.
  useEffect(() => {
    const query = matchMedia(`(resolution: ${ratio}dppx)`);
    const change = () => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the scroll container width and debounce raster resizing, releasing the observer and timer on unmount.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout>;
    const unobserve = observeResize(root, ([entry]) => {
      if (!entry) return;
      const next = entry.contentRect.width;
      setWidth(next);
      clearTimeout(timer);
      timer = setTimeout(() => setSettledWidth(next), 150);
    });
    return () => {
      clearTimeout(timer);
      unobserve();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Yield between page mounting batches with a timer so large documents do not block the browser.
  useEffect(() => {
    if (mounted >= props.pages.length) return;
    const timer = setTimeout(() => setMounted((n) => Math.min(props.pages.length, n + 50)), 0);
    return () => clearTimeout(timer);
  }, [mounted, props.pages.length]);
  useImperativeHandle(
    props.scrollRef,
    () =>
      (index: number, y = 0) => {
        const row = rows.current[index];
        const page = props.pages[index];
        if (row && page)
          scroller.current?.scrollTo({
            top: row.offsetTop + y * Math.min(1, Math.max(0, width - 48) / page.width) - 24,
          });
      },
    [props.pages, width],
  );
  return (
    <div
      ref={scroller}
      className="relative min-h-0 flex-1 overflow-auto bg-muted/60"
      data-office-pages
      onScroll={() => {
        const root = scroller.current;
        if (!root || !props.onPageChange) return;
        if (
          root.scrollHeight > root.clientHeight &&
          root.scrollTop + root.clientHeight >= root.scrollHeight - 1
        ) {
          props.onPageChange(Math.min(mounted, props.pages.length) - 1);
          return;
        }
        const list = rows.current;
        let lo = 0;
        let hi = Math.min(mounted, list.length) - 1;
        if (hi < 0) return;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const row = list[mid];
          if (row && row.offsetTop + row.offsetHeight > root.scrollTop + 24) hi = mid;
          else lo = mid + 1;
        }
        props.onPageChange(lo);
      }}
    >
      <div className="flex flex-col items-center gap-4 py-6">
        {props.pages.slice(0, mounted).map((page, index) => (
          <OfficePage
            key={index}
            page={page}
            index={index}
            near={near.has(index)}
            ratio={ratio}
            track={track}
            scale={Math.min(1, Math.max(0, width - 48) / page.width)}
            rasterScale={Math.min(1, Math.max(0, (settledWidth || width) - 48) / page.width)}
            {...props}
          />
        ))}
      </div>
    </div>
  );
}

function OfficePage(props: {
  page: PageSize;
  index: number;
  near: boolean;
  ratio: number;
  track: (index: number, row: HTMLDivElement | undefined) => void;
  scale: number;
  rasterScale: number;
  paint: PaintPage;
  kind: "slide" | "page";
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  onError: (error: unknown) => void;
}) {
  const {
    near,
    ratio,
    rasterScale,
    index,
    onError,
    page,
    paint,
    scale,
    track,
    kind,
    overlay,
    footer,
  } = props;
  const gt = useGT();
  const row = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register this page's row with the shared viewport observer while mounted.
  useEffect(() => {
    const element = row.current ?? undefined;
    track(index, element);
    return () => track(index, undefined);
  }, [index, track]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the visible page canvas at the current raster scale and cancel obsolete paint requests.
  useEffect(() => {
    const target = canvas.current;
    if (!target || !page || !near || ratio <= 0 || rasterScale <= 0) return;
    const controller = new AbortController();
    void paint(index, target, rasterScale, controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    });
    return () => controller.abort();
  }, [near, index, page, paint, rasterScale, onError, ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the canvas backing store when its page moves away from the viewport.
  useEffect(() => {
    const target = canvas.current;
    if (!near && target) {
      target.width = 0;
      target.height = 0;
    }
  }, [near]);
  return (
    <div className="flex shrink-0 flex-col gap-3" style={{ width: page.width * scale }}>
      <div
        ref={row}
        data-office-page={index}
        role="group"
        aria-label={
          kind === "slide"
            ? gt("Slide {number}", { number: String(index + 1) })
            : gt("Page {number}", { number: String(index + 1) })
        }
        className="relative shrink-0 shadow-md"
        style={{
          width: page.width * scale,
          height: page.height * scale,
          background: page.background ?? "#fff",
        }}
      >
        <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 block size-full" />
        {near ? overlay?.(index) : null}
      </div>
      {footer?.(index)}
    </div>
  );
}
