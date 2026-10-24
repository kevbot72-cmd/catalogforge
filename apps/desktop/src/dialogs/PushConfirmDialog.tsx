import { AlertTriangle, Upload } from "lucide-react";
import { Badge, Button, Modal } from "../components/ui";
import { useApp } from "../store/app";

/** The second check before anything is written to a store. */
export function PushConfirmDialog() {
  const { dialog, dialogArg, openDialog, pushNow, summary, info } = useApp();
  if (dialog !== "push-confirm") return null;
  const live = info?.profile.environment === "production";
  const close = () => openDialog(null);
  const yes = () => {
    close();
    void pushNow(typeof dialogArg === "string" ? dialogArg : "");
  };
  return (
    <Modal
      open
      onClose={close}
      title="Are you sure you want to push changes?"
      width={460}
      testId="push-confirm"
      footer={<>
        <Button onClick={close} data-testid="push-confirm-no" autoFocus>No, go back</Button>
        <Button variant={live ? "danger" : "primary"} icon={<Upload size={14} />} onClick={yes} data-testid="push-confirm-yes">Yes, push</Button>
      </>}
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: info?.profile.color || "#888" }} />
          <b>{info?.profile.name}</b>
          {live ? <Badge tone="removed">LIVE store</Badge> : <Badge>{info?.profile.environment}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {summary.created > 0 && <Badge tone="added">{summary.created} new</Badge>}
          {summary.modified > 0 && <Badge tone="changed">{summary.modified} edited ({summary.fields} fields)</Badge>}
          {summary.deleted > 0 && <Badge tone="removed">{summary.deleted} deleted</Badge>}
        </div>
        {live && (
          <p className="flex gap-2 rounded-md bg-removed/10 p-2.5 text-xs text-removed">
            <AlertTriangle size={15} className="shrink-0" /> This writes to your live shop; customers see the changes straight away.
          </p>
        )}
        <p className="text-xs text-muted">Every push is recorded in History and can be reverted.</p>
      </div>
    </Modal>
  );
}
