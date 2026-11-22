import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const addMonths = (date: Date, months: number) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
};
const sameDay = (a: Date | undefined, b: Date | undefined) =>
  a !== undefined && b !== undefined && a.toDateString() === b.toDateString();

/** Weeks (rows of 7 dates) covering `month`, starting on `weekStartsOn`, including outside days. */
function monthGrid(month: Date, weekStartsOn: WeekStart = 0): Date[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() - weekStartsOn + 7) % 7));
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weekCount = Math.ceil((daysInMonth + ((first.getDay() - weekStartsOn + 7) % 7)) / 7);
  return Array.from({ length: weekCount }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
  );
}

export interface DayPickerClassNames {
  root?: string;
  nav?: string;
  button_previous?: string;
  button_next?: string;
  month?: string;
  month_caption?: string;
  caption_label?: string;
  month_grid?: string;
  weekdays?: string;
  weekday?: string;
  week?: string;
  day?: string;
  day_button?: string;
  today?: string;
  outside?: string;
  hidden?: string;
}

export interface DayPickerProps {
  selected?: Date | undefined;
  onSelect?: (date: Date) => void;
  defaultMonth?: Date;
  weekStartsOn?: WeekStart;
  disabled?: { before?: Date; after?: Date } | ((date: Date) => boolean);
  showOutsideDays?: boolean;
  className?: string;
  classNames?: DayPickerClassNames;
  chevron?: (direction: "left" | "right") => ReactNode;
  locale?: string;
  previousMonthLabel: string;
  nextMonthLabel: string;
}

/** Single-date calendar grid with roving focus (arrows, Home/End, PageUp/PageDown). */
export function DayPicker({
  selected,
  onSelect,
  defaultMonth,
  weekStartsOn = 0,
  disabled,
  showOutsideDays = true,
  className,
  classNames: c = {},
  chevron,
  locale,
  previousMonthLabel,
  nextMonthLabel,
}: DayPickerProps) {
  const [focused, setFocused] = useState(() => startOfDay(selected ?? defaultMonth ?? new Date()));
  const [month, setMonth] = useState(() => new Date(focused.getFullYear(), focused.getMonth(), 1));
  const grid = useRef<HTMLTableElement>(null);
  const [today] = useState(() => new Date());
  const isDisabled = (date: Date) =>
    typeof disabled === "function"
      ? disabled(date)
      : (disabled?.before !== undefined && date < startOfDay(disabled.before)) ||
        (disabled?.after !== undefined && date > startOfDay(disabled.after));

  const moveFocus = (date: Date) => {
    setFocused(date);
    if (date.getMonth() !== month.getMonth() || date.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    }
    requestAnimationFrame(() =>
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${date.toDateString()}"]`)
        ?.focus(),
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const offset = (event.currentTarget.ownerDocument.dir || "ltr") === "rtl" ? -1 : 1;
    const weekday = (focused.getDay() - weekStartsOn + 7) % 7;
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -offset),
      ArrowRight: () => addDays(focused, offset),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => addDays(focused, -weekday),
      End: () => addDays(focused, 6 - weekday),
      PageUp: () => addMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focused, event.shiftKey ? 12 : 1),
    };
    const next = moves[event.key]?.();
    if (!next) return;
    event.preventDefault();
    moveFocus(next);
  };

  const weeks = monthGrid(month, weekStartsOn);
  const { weekday: weekdayFormat, day: dayFormat } = formatsFor(locale);
  const caption = month.toLocaleDateString(locale, { month: "long", year: "numeric" });
  const focusTarget = focused.getMonth() === month.getMonth() ? focused : month;

  return (
    <div className={[c.root, className].filter(Boolean).join(" ")} data-slot="calendar">
      <div className={c.month}>
        <nav className={c.nav}>
          <button
            type="button"
            className={c.button_previous}
            aria-label={previousMonthLabel}
            onClick={() => setMonth(addMonths(month, -1))}
          >
            {chevron?.("left")}
          </button>
          <button
            type="button"
            className={c.button_next}
            aria-label={nextMonthLabel}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            {chevron?.("right")}
          </button>
        </nav>
        <div className={c.month_caption}>
          <span className={c.caption_label} aria-live="polite">
            {caption}
          </span>
        </div>
        <table
          ref={grid}
          role="grid"
          aria-label={caption}
          className={c.month_grid}
          onKeyDown={onKeyDown}
        >
          <thead>
            <tr className={c.weekdays}>
              {weeks[0]!.map((date) => (
                <th key={date.getDay()} scope="col" className={c.weekday}>
                  {weekdayFormat.format(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]!.toDateString()} className={c.week}>
                {week.map((date) => {
                  const outside = date.getMonth() !== month.getMonth();
                  const isSelected = sameDay(date, selected);
                  const off = isDisabled(date);
                  const isToday = sameDay(date, today);
                  if (outside && !showOutsideDays) {
                    return <td key={date.toDateString()} className={c.hidden} />;
                  }
                  return (
                    <td
                      key={date.toDateString()}
                      className={[c.day, isToday && c.today, outside && c.outside]
                        .filter(Boolean)
                        .join(" ")}
                      data-selected={isSelected || undefined}
                      data-disabled={off || undefined}
                      data-outside={outside || undefined}
                      data-today={isToday || undefined}
                      aria-selected={isSelected}
                    >
                      <button
                        type="button"
                        className={c.day_button}
                        data-day={date.toDateString()}
                        tabIndex={sameDay(date, focusTarget) ? 0 : -1}
                        disabled={off}
                        aria-label={dayFormat.format(date)}
                        onFocus={() => setFocused(date)}
                        onClick={() => onSelect?.(date)}
                      >
                        {date.getDate()}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Formatters are costly to build and the calendar re-renders on every focus move.
const formats = new Map<string, { weekday: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>();
function formatsFor(locale: string | undefined) {
  const key = locale ?? "";
  let cached = formats.get(key);
  if (!cached) {
    cached = {
      weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
      day: new Intl.DateTimeFormat(locale, { dateStyle: "full" }),
    };
    formats.set(key, cached);
  }
  return cached;
}
