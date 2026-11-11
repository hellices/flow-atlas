import { useMemo, type ReactNode } from "react";
import { getBasePathToShowPage } from "@/object-metadata/utils/getBasePathToShowPage";
import { RecordTableRowContext } from "@/object-record/RecordTableRowContext";

export const RecordTableTr = ({ recordId, objectNameSingular, children }: { recordId: string; objectNameSingular: string; children: ReactNode }) => {
  const value = useMemo(() => ({ recordId, pathToShowPage: getBasePathToShowPage({ objectNameSingular }) + recordId }), [recordId, objectNameSingular]);
  return <RecordTableRowContext.Provider value={value}>{children}</RecordTableRowContext.Provider>;
};
