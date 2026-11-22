import { useGT } from "@t3tools/shared/i18n/react";
import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const gt = useGT();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? gt("Continue with ChatGPT")}
    </Button>
  );
}
