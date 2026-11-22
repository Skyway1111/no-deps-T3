import { fileIconColors } from "@t3tools/shared/file-icons";
import { FileIcon, FolderIcon } from "~/ui-core/icons";
import { memo } from "react";

import { ensurePierreIconSprite, resolvePierreIconForEntry } from "../../pierre-icons";
import { cn } from "~/lib/utils";

export const PierreEntryIcon = memo(function PierreEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  mimeType?: string | undefined;
  theme: "light" | "dark";
  className?: string;
}) {
  const icon = resolvePierreIconForEntry(props.pathValue, props.kind, props.mimeType);

  if (!icon) {
    return props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 text-icon-muted", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 text-icon-muted", props.className)} />
    );
  }

  // Every icon references one shared sprite; build it with the first icon, not at app boot.
  ensurePierreIconSprite();
  const colors = fileIconColors(icon.token);
  return (
    <svg
      aria-hidden="true"
      data-pierre-icon={icon.name}
      data-icon-token={icon.token}
      className={cn("size-4 shrink-0", props.className)}
      style={{ color: colors[props.theme === "light" ? 0 : 1] }}
      viewBox="0 0 16 16"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
});
