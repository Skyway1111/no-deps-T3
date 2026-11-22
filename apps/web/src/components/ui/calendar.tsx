import { useGT } from "@t3tools/shared/i18n/react";
import type * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "~/ui-core/icons";
import { DayPicker, type DayPickerProps } from "~/ui-core/dayPicker";
import { cn } from "~/lib/utils";

const buttonClassNames =
  "relative flex size-(--cell-size) text-base sm:text-sm items-center justify-center rounded-lg text-foreground not-in-data-selected:hover:bg-accent disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const classNames = {
  button_next: buttonClassNames,
  button_previous: buttonClassNames,
  caption_label: "text-base sm:text-sm font-medium flex items-center gap-2 h-full",
  day: "relative size-(--cell-size) text-sm py-px",
  day_button: cn(
    buttonClassNames,
    "in-data-disabled:pointer-events-none in-data-selected:bg-primary in-data-disabled:text-muted-foreground/72 in-data-outside:text-muted-foreground/72 in-data-selected:in-data-outside:text-primary-foreground in-data-selected:text-primary-foreground in-data-disabled:line-through outline-none in-data-selected:transition-[border-radius,box-shadow] focus-visible:z-1 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
  ),
  hidden: "invisible",
  month: "relative w-full",
  month_caption:
    "relative mx-(--cell-size) px-1 mb-1 flex h-(--cell-size) items-center justify-center z-2",
  nav: "absolute top-0 flex w-full justify-between z-3",
  outside: "text-muted-foreground data-selected:bg-accent/50 data-selected:text-muted-foreground",
  today:
    "*:after:pointer-events-none *:after:absolute *:after:bottom-1 *:after:start-1/2 *:after:z-1 *:after:size-[3px] *:after:-translate-x-1/2 *:after:rounded-full *:after:bg-primary [&[data-selected]>*]:after:bg-background [&[data-disabled]>*]:after:bg-foreground/30",
  weekday: "size-(--cell-size) p-0 text-xs font-medium text-muted-foreground/72",
};

const chevron = (direction: "left" | "right") => {
  const Icon = direction === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return <Icon className="rtl:rotate-180" />;
};

export function Calendar({
  className,
  ...props
}: Omit<DayPickerProps, "previousMonthLabel" | "nextMonthLabel">): React.ReactElement {
  const gt = useGT();
  return (
    <DayPicker
      previousMonthLabel={gt("Previous month", { $context: "calendar navigation button" })}
      nextMonthLabel={gt("Next month", { $context: "calendar navigation button" })}
      className={cn("w-fit [--cell-size:--spacing(10)] sm:[--cell-size:--spacing(9)]", className)}
      classNames={classNames}
      chevron={chevron}
      {...props}
    />
  );
}
