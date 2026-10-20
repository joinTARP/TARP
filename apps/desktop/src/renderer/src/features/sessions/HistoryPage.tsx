import { AdventureActionDialog } from "./adventure-actions";
import { HistoryAdventureList, HistorySkeleton } from "./HistoryAdventureList";
import { useAdventureActions } from "./use-adventure-actions";

export function HistoryPage() {
  const { rooms, pendingAction, setPendingAction, manage, chooseAction } = useAdventureActions();
  const dialog = (
    <AdventureActionDialog
      action={pendingAction}
      pending={manage.isPending}
      error={manage.error}
      onDismiss={() => setPendingAction(null)}
      onConfirm={() => pendingAction && manage.mutate(pendingAction)}
    />
  );
  if (rooms.isPending) {
    return (
      <>
        <HistorySkeleton />
        {dialog}
      </>
    );
  }
  return (
    <>
      <HistoryAdventureList
        rooms={rooms.data?.rooms ?? []}
        issues={rooms.data?.issues ?? []}
        error={rooms.error ? rooms.error.message : undefined}
        onRetry={() => void rooms.refetch()}
        onAction={chooseAction}
      />
      {dialog}
    </>
  );
}
