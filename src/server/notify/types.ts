// The events of the notifier (#16): activity rows, as the notifier reads
// them.
import type { ActivitySnapshot } from "@/db/schema";
import type { OpType, Via } from "@/shared/ops";

export interface ActivityEvent {
  id: number;
  actorId: string;
  via: Via;
  type: OpType;
  listId: string;
  itemId: string | null;
  snapshot: ActivitySnapshot;
  /** Server time in ms. */
  at: number;
}
