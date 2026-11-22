export type ClassDictionary = Record<string, unknown>;
export type ClassValue = ClassValue[] | ClassDictionary | string | number | bigint | boolean | null | undefined;

function append(out: string, value: ClassValue): string {
  if (!value) return out;
  if (typeof value === "string" || typeof value === "number") return out ? out + " " + value : "" + value;
  if (typeof value !== "object") return out;
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) out = append(out, value[i]);
  else for (const key in value) if (value[key]) out = out ? out + " " + key : key;
  return out;
}

export function clsx(...inputs: ClassValue[]): string {
  let out = "";
  for (let i = 0, v; i < inputs.length; i++) if ((v = inputs[i])) out = typeof v === "string" ? (out ? out + " " + v : v) : append(out, v);
  return out;
}
