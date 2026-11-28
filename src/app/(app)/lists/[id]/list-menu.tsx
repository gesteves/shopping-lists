"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMyUserId, useOtherUserNames } from "@/client/hooks";
import type { ListView } from "@/client/queries";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import {
  DeleteDialog,
  PrivateIcon,
  RenameForm,
} from "../../_components/list-index";
import { ConfirmDialog, useWaEvents } from "../../_components/wa";

/**
 * The list name, and a menu: rename, check all, uncheck all, delete the
 * checked items, make private or share (#154, the creator only), and
 * delete the list. Each bulk change has an undo (#67).
 */
export function ListHeader({ view }: { view: ListView }) {
  const { list, items } = view;
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const me = useMyUserId();
  const others = useOtherUserNames() ?? [];
  // A row from an older server has no `private`.
  const isPrivate = list.private === true;
  const isOwner = me !== undefined && list.createdBy === me;
  const checked = items.filter((i) => i.checked).map((i) => i.id);
  const unchecked = items.filter((i) => !i.checked).map((i) => i.id);

  async function checkAll() {
    await mutate({ type: "checkAll", args: { listId: list.id } });
    showToast({
      message: copy.list.checkedAll(unchecked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of unchecked) {
            await mutate({ type: "uncheck", args: { itemId } });
          }
        },
      },
    });
  }

  async function uncheckAll() {
    await mutate({ type: "uncheckAll", args: { listId: list.id } });
    showToast({
      message: copy.list.unchecked(checked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of checked) {
            await mutate({ type: "check", args: { itemId } });
          }
        },
      },
    });
  }

  async function deleteChecked() {
    setClearing(false);
    await mutate({ type: "clearChecked", args: { listId: list.id } });
    showToast({
      message: copy.list.deletedChecked(checked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of checked) {
            await mutate({ type: "restoreItem", args: { itemId } });
          }
        },
      },
    });
  }

  const menu = useWaEvents<HTMLElement>({
    "wa-select": (event) => {
      const value = (event as CustomEvent<{ item: { value: string } }>).detail
        .item.value;
      if (value === "rename") setRenaming(true);
      if (value === "check-all") void checkAll();
      if (value === "uncheck-all") void uncheckAll();
      if (value === "delete-checked") setClearing(true);
      if (value === "privacy") setPrivacy(true);
      if (value === "delete") setDeleting(true);
    },
  });

  if (renaming) {
    return (
      <div className="mt-2">
        <RenameForm list={list} onDone={() => setRenaming(false)} />
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-4xl font-bold tracking-tight text-balance wrap-anywhere">
          {list.name}
          {isPrivate && <PrivateIcon className="ms-3" />}
        </h1>
        <wa-dropdown ref={menu} placement="bottom-end">
          <wa-button slot="trigger" appearance="plain" size="l">
            <wa-icon name="ellipsis" label={copy.list.actions}></wa-icon>
          </wa-button>
          <wa-dropdown-item value="rename">
            <wa-icon slot="icon" name="pen"></wa-icon>
            {copy.common.rename}
          </wa-dropdown-item>
          <wa-dropdown-item value="check-all" disabled={unchecked.length === 0}>
            <wa-icon slot="icon" name="square-check"></wa-icon>
            {copy.list.checkAll}
          </wa-dropdown-item>
          <wa-dropdown-item value="uncheck-all" disabled={checked.length === 0}>
            <wa-icon slot="icon" name="square"></wa-icon>
            {copy.list.uncheckAll}
          </wa-dropdown-item>
          <wa-dropdown-item
            value="delete-checked"
            disabled={checked.length === 0}
          >
            <wa-icon slot="icon" name="trash-can-check"></wa-icon>
            {copy.list.deleteChecked}
          </wa-dropdown-item>
          {isOwner && (
            <>
              <wa-divider></wa-divider>
              <wa-dropdown-item value="privacy">
                <wa-icon
                  slot="icon"
                  name={isPrivate ? "lock-open" : "lock"}
                ></wa-icon>
                {isPrivate
                  ? copy.privacy.share(others)
                  : copy.privacy.makePrivate}
              </wa-dropdown-item>
            </>
          )}
          <wa-divider></wa-divider>
          <wa-dropdown-item value="delete" variant="danger">
            <wa-icon slot="icon" name="trash-can"></wa-icon>
            {copy.list.deleteList}
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
      <ConfirmDialog
        open={clearing}
        label={copy.list.deleteCheckedTitle(checked.length, list.name)}
        confirmLabel={copy.list.deleteCheckedConfirm}
        onConfirm={deleteChecked}
        onClose={() => setClearing(false)}
      >
        {copy.list.deleteCheckedBody}
      </ConfirmDialog>
      {isOwner && (
        <PrivacyDialog
          open={privacy}
          view={view}
          me={me}
          others={others}
          onClose={() => setPrivacy(false)}
        />
      )}
      <DeleteDialog
        open={deleting}
        list={{ ...list, total: items.length }}
        onClose={() => setDeleting(false)}
        onDeleted={() => router.push("/")}
      />
    </div>
  );
}

/**
 * Asks before a change of the list privacy (#154). Both ways ask: "Make
 * private" takes the list away from the other people at once, also the
 * items that they added. "Share" shows a surprise, and sends a push: it
 * is the change that can spoil a gift. No Undo: the other devices can
 * pull the list at once.
 */
function PrivacyDialog({
  open,
  view,
  me,
  others,
  onClose,
}: {
  open: boolean;
  view: ListView;
  me: string;
  others: string[];
  onClose: () => void;
}) {
  const { list, items } = view;
  const makePrivate = list.private !== true;
  const added = items.filter((i) => i.createdBy !== me).length;

  async function confirm() {
    onClose();
    await mutate({
      type: "setListPrivate",
      args: { listId: list.id, private: makePrivate },
    });
    showToast({
      message: (makePrivate ? copy.privacy.madePrivate : copy.privacy.shared)(
        list.name,
      ),
    });
  }

  return (
    <ConfirmDialog
      open={open}
      label={(makePrivate
        ? copy.privacy.makePrivateTitle
        : copy.privacy.shareTitle)(list.name)}
      confirmLabel={
        makePrivate
          ? copy.privacy.makePrivateConfirm
          : copy.privacy.shareConfirm
      }
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {makePrivate
        ? copy.privacy.makePrivateBody(others, added)
        : copy.privacy.shareBody(others)}
    </ConfirmDialog>
  );
}
