import { mergeProps, renderElement, useRender } from "~/ui-core/primitives";

import { cn } from "~/lib/utils";

function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
      className,
    ),
    "data-slot": "label",
  };

  return renderElement({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };
