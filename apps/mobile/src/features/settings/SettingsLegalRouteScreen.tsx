import { useGT } from "@t3tools/shared/i18n/react";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  const gt = useGT();
  return (
    <SettingsLegalDocumentRouteScreen
      documentName={gt("Legal", { $context: "legal documents page title" })}
      documentUrl={LEGAL_URL}
    />
  );
}
