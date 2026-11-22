import * as Red from "../Redacted.ts";
import type { Command, Word } from "./ChildProcess.ts";

const quoteWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
export const quote = (word: Word): string => quoteWord(Red.isRedacted(word) ? "<redacted>" : word);
/** Human-readable command line; redacted words stay hidden. */
export const display = (command: Command): string =>
  command._tag === "PipedCommand" ? `${display(command.left)} | ${display(command.right)}` : [command.command, ...command.args].map(quote).join(" ");
