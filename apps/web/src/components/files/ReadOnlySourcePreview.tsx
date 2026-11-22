import { type ClipboardEvent, useEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { File, Virtualizer } from "~/ui-core/codeView/File";
import type { FileOptions } from "~/ui-core/codeView/types";

import "../diffs/diffSurfaceTheme";
import { SourceSelection } from "./sourceSelection";

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions["onPostRender"];
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const { text, onPostRender } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const [selection] = useState(() => new SourceSelection());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the document's selection, which only it reports
  useEffect(() => {
    const root = () => wrapper.current?.querySelector<HTMLElement>("diffs-file");
    const sync = () => {
      const file = root();
      if (file) selection.sync(file, text);
    };
    // A drag that autoscrolls is usually released outside the preview.
    const release = () => {
      const file = root();
      if (file) selection.release(file, text);
    };
    document.addEventListener("selectionchange", sync);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [selection, text]);
  const copySelection = (event: ClipboardEvent<HTMLDivElement>) => {
    const file = event.currentTarget.querySelector<HTMLElement>("diffs-file");
    const copied = file ? selection.copy(file, text) : undefined;
    if (copied === undefined) return;
    event.clipboardData.setData("text/plain", copied);
    event.preventDefault();
  };
  const drawSelection: NonNullable<typeof onPostRender> = (node, instance, phase) => {
    if (phase !== "unmount") selection.render(node, text);
    return onPostRender?.(node, instance, phase);
  };
  return (
    <div
      ref={wrapper}
      className="contents"
      onCopy={copySelection}
      onPointerDown={(event) => selection.press(event.button !== 0 || event.shiftKey)}
      // Scrolling unmounts rows, and a selection made in the same task has not been reported yet.
      onScrollCapture={(event) => {
        const file = event.currentTarget.querySelector<HTMLElement>("diffs-file");
        if (file) selection.sync(file, text);
      }}
    >
      <Virtualizer
        key={`${props.name}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
      >
        <File
          file={{
            name: props.name,
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            onPostRender: drawSelection,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </div>
  );
}
