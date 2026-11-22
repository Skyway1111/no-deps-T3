// Resolves saved project icons by Lucide name; loaded lazily as one chunk with the full set.
import * as StaticIcons from "../ui-core/icons";
import { createIcon, type IconComponent } from "../ui-core/icons";
import { iconAliases, iconBodies } from "../ui-core/iconSet";

function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// Lucide digit names can differ from this inverse; both forms resolve through toPascalName.
function toKebabName(pascalName: string): string {
  return (pascalName.match(/[A-Z][a-z]*|[0-9]+[a-z]*/g) ?? []).join("-").toLowerCase();
}

const kebabByPascal = new Map<string, string>(Object.entries(iconAliases));
const icons = new Map<string, IconComponent>();
for (const [exportName, icon] of Object.entries(StaticIcons)) {
  if (exportName.endsWith("Icon") && typeof icon === "function" && "displayName" in icon) {
    icons.set(exportName.slice(0, -4), icon as IconComponent);
  }
}
for (const kebab of Object.keys(iconBodies)) kebabByPascal.set(toPascalName(kebab), kebab);

export const lucideIconNames: ReadonlyArray<string> = [
  ...icons.keys(),
  ...Object.keys(iconBodies).map(toPascalName),
]
  .sort()
  .map(toKebabName);

function resolve(pascal: string): IconComponent | undefined {
  const kebab = kebabByPascal.get(pascal);
  const canonical = kebab === undefined ? pascal : toPascalName(kebab);
  let icon = icons.get(canonical);
  if (icon === undefined && kebab !== undefined && iconBodies[kebab] !== undefined) {
    icon = createIcon(kebab, iconBodies[kebab]);
    icons.set(canonical, icon);
  }
  return icon;
}

export function lucideIconByName(name: string): IconComponent | undefined {
  const pascal = toPascalName(name);
  return (
    resolve(pascal) ??
    resolve(pascal.replace(/Icon$/, "")) ??
    resolve(pascal.replace(/^Lucide/, ""))
  );
}
