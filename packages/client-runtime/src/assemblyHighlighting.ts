import { setCustomExtension } from "@t3tools/shared/highlight/languages";

// Assembly sources use the asm lexer rather than RISC-V.
for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
  setCustomExtension(extension, "asm");
}
