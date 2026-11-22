import { cva, type VariantProps } from "@t3tools/shared/ui/twMerge";

import { cn } from "~/lib/utils";

const skeletonVariants = cva("bg-muted-foreground/15 motion-safe:animate-skeleton", {
  variants: {
    shape: {
      block: "rounded-sm",
      card: "rounded-lg",
      pill: "rounded-full",
    },
  },
  defaultVariants: { shape: "block" },
});

function Skeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div className={cn(skeletonVariants({ shape }), className)} data-slot="skeleton" {...props} />
  );
}

export { Skeleton };
