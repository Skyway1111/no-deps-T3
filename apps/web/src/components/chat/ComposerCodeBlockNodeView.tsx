import type { ReactNode } from "react";

import { languageOfInfoString, withInfoStringLanguage } from "~/composer-code-languages";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { MarkdownCodeBlockFrame } from "./MarkdownCodeBlock";
import { ComposerCodeBlockLanguagePicker } from "./ComposerCodeBlockLanguagePicker";

export interface ComposerCodeBlockNodeViewProps {
  readonly languageInfo: string;
  readonly disabled: boolean;
  readonly onChangeLanguage: (nextLanguageInfo: string) => void;
  readonly codeProps?: React.HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | number>;
  readonly children: ReactNode;
}

export function ComposerCodeBlockNodeView({
  languageInfo,
  disabled,
  onChangeLanguage,
  codeProps,
  children,
}: ComposerCodeBlockNodeViewProps) {
  const resolvedTheme = useRenderedAppearance();
  const language = languageOfInfoString(languageInfo);

  const changeLanguage = (next: string) => {
    onChangeLanguage(withInfoStringLanguage(languageInfo, next));
  };

  return (
    <MarkdownCodeBlockFrame
      language={language || "text"}
      fenceTitle={null}
      theme={resolvedTheme}
      headerProps={{
        contentEditable: false,
        onMouseDown: (event) => {
          // Keep clicks on the language header from moving the editor caret.
          event.stopPropagation();
        },
        ...({ "data-composer-ui": "true" } as Record<string, string>),
      }}
      title={
        <ComposerCodeBlockLanguagePicker
          language={language}
          theme={resolvedTheme}
          disabled={disabled}
          onChange={changeLanguage}
        />
      }
    >
      <div className="chat-markdown-shiki">
        <pre className="max-w-full overflow-x-auto px-3 pt-1 pb-2">
          <code
            {...codeProps}
            className="block min-h-[1lh] font-mono whitespace-pre-wrap text-inherit [overflow-wrap:anywhere]"
          >
            {children}
          </code>
        </pre>
      </div>
    </MarkdownCodeBlockFrame>
  );
}
