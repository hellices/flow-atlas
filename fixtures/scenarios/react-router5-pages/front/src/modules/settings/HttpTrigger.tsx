import { SettingsTextInput } from "@/ui/SettingsTextInput";

export const HttpTrigger = ({ path, onChange }: { path: string; onChange: (path: string) => void }) => (
  <SettingsTextInput label="Path" placeholder="/my-route" value={path} onChange={onChange} />
);
