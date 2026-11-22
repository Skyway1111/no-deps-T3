import { useNativeFileDrag } from "../../useNativeFileDrag";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { documentChipKindForFileName, basenameOfPath } from "~/pierre-icons";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { useGT } from "@t3tools/shared/i18n/react";
import { createContext, use, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { WorkspaceEntryTooltip } from "../chat/WorkspaceEntryIcon";
import { FileTagChipContent } from "../chat/FileTagChip";
import { SkillChipPopover, skillPopoverDescription } from "../chat/SkillInlineText";
import { AssistantCitationChip } from "../chat/AssistantCitationChip";
import { ModelMentionChip } from "../chat/ModelMentionChip";
import { ContextChip } from "../ContextChip";
import { ComposerContextActionsContext, ComposerContextReferenceChip } from "../composerContextPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SkillMeta } from "~/composer-rich-text-doc";
import { cn } from "~/lib/utils";
import { useRenderedAppearance } from "../../hooks/useTheme";
import type { CitationInsertedSpaces, ComposerChip, OpenCitationComment } from "./types";

export const ComposerCitationCommentContext = createContext<{
  openComment: OpenCitationComment | null;
  onOpenChange: (citeKey: string, open: boolean) => void;
  onDraftChange: (citeKey: string, comment: string) => void;
  onSaveComment: (citeKey: string, comment: string) => boolean;
  onRemoveCitation: (citeKey: string, removeSpaces: CitationInsertedSpaces) => void;
  onRestoreFocusAfterCitation: (citeKey: string, sent: boolean) => void;
  onSubmitAndSend: () => boolean;
  isEditable: boolean;
}>({
  openComment: null,
  onOpenChange: () => {},
  onDraftChange: () => {},
  onSaveComment: () => false,
  onRemoveCitation: () => {},
  onRestoreFocusAfterCitation: () => {},
  onSubmitAndSend: () => false,
  isEditable: true,
});

export const RichComposerSkillsContext = createContext<ReadonlyArray<ServerProviderSkill>>([]);

const CHIP_CLASS =
  "relative inline-flex min-w-0 max-w-full select-none items-baseline data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

export function composerSkillMeta(skills: ReadonlyArray<ServerProviderSkill>, name: string): SkillMeta | null {
  const skill = skills.find((c) => c.name === name && isProviderSkillUserInvocable(c));
  if (!skill) return null;
  return {
    label: formatProviderSkillDisplayName(skill),
    description: skill.shortDescription?.trim() || skill.description?.trim() || null,
  };
}

function MentionChip({ path, offset, cls }: { path: string; offset: number; cls: string }) {
  const gt = useGT();
  const theme = useRenderedAppearance();
  const actions = use(ComposerContextActionsContext);
  const nativeDrag = useNativeFileDrag(actions.environmentId, () => resolvePathLinkTarget(path, actions.cwd ?? ""));
  const trigger = (
    <ContextChip
      {...nativeDrag}
      kind={documentChipKindForFileName(path) ?? "mention"}
      dir="ltr"
      render={<button type="button" />}
      onClick={() => actions.openMention(path)}
      aria-label={gt("Preview {path}", { path })}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        environmentId={actions.environmentId}
        cwd={actions.cwd}
        label={basenameOfPath(path).normalize("NFC")}
        theme={theme}
      />
    </ContextChip>
  );
  return (
    <span contentEditable={false} data-composer-chip-offset={offset} data-composer-mention="" className={cls}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipPopup side="top" className="pointer-events-auto">
          <WorkspaceEntryTooltip path={path} environmentId={actions.environmentId} cwd={actions.cwd} />
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

function SkillChip({ chip, offset, cls }: { chip: Extract<ComposerChip, { kind: "composer-skill" }>; offset: number; cls: string }) {
  const actions = use(ComposerContextActionsContext);
  const skills = use(RichComposerSkillsContext);
  const skill = skills.find((c) => c.name === chip.skillName && isProviderSkillUserInvocable(c));
  return (
    <span contentEditable={false} data-composer-chip-offset={offset} data-composer-skill="" className={cls}>
      <SkillChipPopover
        label={skill ? formatProviderSkillDisplayName(skill) : chip.skillLabel || chip.skillName}
        description={skill ? skillPopoverDescription(skill) : chip.skillDescription}
        onViewInstructions={skill?.path && actions.environmentId ? () => actions.openMention(skill.path) : undefined}
      />
    </span>
  );
}

function CitationChip({ chip, offset, cls }: { chip: Extract<ComposerChip, { kind: "composer-citation" }>; offset: number; cls: string }) {
  const ctx = use(ComposerCitationCommentContext);
  const target = ctx.openComment?.key === chip.citeKey ? ctx.openComment : null;
  const sentRef = useRef(false);
  const onRestoreFocus = () => {
    const sent = sentRef.current;
    sentRef.current = false;
    ctx.onRestoreFocusAfterCitation(chip.citeKey, sent);
  };
  return (
    <span
      contentEditable={false}
      spellCheck={false}
      data-composer-chip-offset={offset}
      data-composer-citation=""
      data-composer-citation-chip="true"
      className={cls}
      onKeyDown={(e: ReactKeyboardEvent<HTMLElement>) => {
        if (!ctx.isEditable || e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
        if (!(e.target instanceof HTMLElement) || e.target.dataset.citationCommentTrigger === undefined) return;
        e.preventDefault();
        onRestoreFocus();
      }}
    >
      <AssistantCitationChip
        citation={chip.citation}
        commentEditor={{
          open: target !== null,
          sourceAnchor: target?.sourceAnchor,
          onOpenChange: (open) => { if (!open || ctx.isEditable) ctx.onOpenChange(chip.citeKey, open); },
          ...(target?.removeOnCancel ? { onCancel: () => ctx.onRemoveCitation(chip.citeKey, target.removeOnCancel!) } : {}),
          onSave: (comment) => ctx.onSaveComment(chip.citeKey, comment),
          onDraftChange: (comment) => ctx.onDraftChange(chip.citeKey, comment),
          onSaveAndSend: (comment) => {
            if (!ctx.onSaveComment(chip.citeKey, comment)) return false;
            sentRef.current = ctx.onSubmitAndSend();
            return true;
          },
          onRestoreFocus,
        }}
      />
    </span>
  );
}

export function ComposerInlineChip({
  chip,
  offset,
  rangeSelected,
  isEditable,
  onDeleteReadOnlyChip,
}: {
  chip: ComposerChip;
  offset: number;
  rangeSelected: boolean;
  isEditable: boolean;
  onDeleteReadOnlyChip: (offset: number) => void;
}) {
  const actions = use(ComposerContextActionsContext);
  const cls = cn(CHIP_CLASS, rangeSelected && "composer-chip-range-selected");
  switch (chip.kind) {
    case "composer-mention":
      return <MentionChip path={chip.path} offset={offset} cls={cls} />;
    case "composer-skill":
      return <SkillChip chip={chip} offset={offset} cls={cls} />;
    case "composer-model":
      return (
        <span contentEditable={false} data-composer-chip-offset={offset} data-composer-model="" className={cls}>
          <ModelMentionChip environmentId={actions.environmentId} instanceId={chip.instanceId} model={chip.model} source={chip.source} />
        </span>
      );
    case "composer-citation":
      return <CitationChip chip={chip} offset={offset} cls={cls} />;
    case "composer-context-reference":
      return (
        <span
          contentEditable={false}
          data-composer-chip-offset={offset}
          data-composer-context-reference=""
          className={cls}
          onKeyDown={(e: ReactKeyboardEvent<HTMLElement>) => {
            if (isEditable || (e.key !== "Backspace" && e.key !== "Delete")) return;
            if (!(e.target instanceof globalThis.Node) || !e.currentTarget.contains(e.target)) return;
            e.preventDefault();
            onDeleteReadOnlyChip(offset);
          }}
        >
          <ComposerContextReferenceChip kind={chip.refKind} contextId={chip.contextId} label={chip.label} />
        </span>
      );
  }
}
