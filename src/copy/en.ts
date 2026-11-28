// The English UI copy (#66). All the text that the app shows is here:
// components, toasts, push notifications, and metadata. List and item
// names are data, not copy. Text with values is a function. Use `plural`
// for counts, not `n === 1`.
//
// Keep this file free of imports from the app: the server, the client,
// the service worker, and the e2e tests all import it.
import { pluralFor } from "./plural";

const plural = pluralFor("en");

/** A name in curly quotes. */
const q = (name: string) => `“${name}”`;

const APP_NAME = "Shopping Lists";

const viaClaude = (name: string) => `${name} (via Claude)`;

/**
 * "a" or "an" before a name, from its first sound: a vowel letter, or a
 * number said with a vowel. Names like "Uber" or "Hour" can be wrong.
 */
export function article(name: string): "a" | "an" {
  const s = name.trim().toLowerCase();
  // "8…" is "eight…"; "11" and "18" are "eleven" and "eighteen".
  if (/^8/.test(s) || /^1[18](\D|$)/.test(s)) return "an";
  return /^[aeiou]/.test(s) ? "an" : "a";
}

const andList = new Intl.ListFormat("en", { type: "conjunction" });

const items = (n: number) =>
  plural(n, { one: `${n} item`, other: `${n} items` });

/** The values of a push notification sentence. */
interface PushEvent {
  /** The person, with "(via Claude)" for an MCP change. */
  who: string;
  list: string;
  item: string;
  /** The old name of a renamed list. */
  oldList: string;
  /** The list that an item moved from. */
  fromList: string;
}

export const en = {
  app: {
    name: APP_NAME,
    /** The name under the icon on a Home Screen. */
    shortName: "Lists",
    description: "Shared shopping lists.",
    /** The description in the web app manifest. */
    manifestDescription: "Shared shopping lists that work offline.",
    /** The browser tab title of a page. */
    pageTitle: (page: string) => `${page} – ${APP_NAME}`,
  },

  common: {
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    rename: "Rename",
    undo: "Undo",
    reload: "Reload",
  },

  people: {
    /** A person that this device does not know. */
    someone: "Someone",
    viaClaude,
  },

  time: {
    justNow: "just now",
  },

  signIn: {
    title: "Sign in",
    intro: "Sign in to see the lists you share.",
    button: "Sign in with Google",
    opening: "Opening Google…",
    emailNotAllowed: `This Google account can’t use ${APP_NAME}. Sign in with the account you use for the lists.`,
    failed: "Sign-in didn’t finish. Try again.",
  },

  offline: {
    title: "Offline",
    heading: "You’re offline",
    body: "This page isn’t saved on this device yet. Your lists are, and changes you make sync when you’re back online.",
    goToLists: "Go to your lists",
  },

  header: {
    settings: "Settings",
    signedInAs: (name: string) => `Signed in as ${name}`,
  },

  sync: {
    signInAgain: "Sign in again to sync",
    signInAgainWithChanges: (n: number) =>
      `Sign in again to sync ${plural(n, { one: `${n} change`, other: `${n} changes` })}`,
    offline: "Offline",
    offlineWithChanges: (n: number) =>
      `Offline · ${plural(n, { one: `${n} change`, other: `${n} changes` })} to sync`,
    changesToSync: (n: number) =>
      `${plural(n, { one: `${n} change`, other: `${n} changes` })} to sync`,
    error: "Can’t sync · Trying again",
    errorWithChanges: (n: number) =>
      `Can’t sync ${plural(n, { one: `${n} change`, other: `${n} changes` })} · Trying again`,
  },

  newVersion: {
    message: "A new version of the app is ready.",
  },

  lists: {
    heading: "Lists",
    /** The label of the sidebar on a large screen. */
    sidebar: "All lists",
    empty: "No lists yet. Make one for each store you go to.",
    pickOne: "Select a list, or make a new one.",
    /** The unchecked items of a list. */
    remaining: (n: number) => items(n),
    nothingToGet: "Nothing to get",
    /** The unchecked items of a short list, for example "Milk and Eggs". */
    names: (names: string[]) => andList.format(names),
    more: (name: string) => `More for ${name}`,
    newName: "New list name",
    newPlaceholder: "New list",
    create: "Create",
    renameLabel: (name: string) => `New name for ${q(name)}`,
    deleteTitle: (name: string) => `Delete the ${q(name)} list?`,
    deleteConfirm: "Delete list",
    /**
     * `total` counts all the items of the list, checked or not. `others` are
     * the names of the other users. More than three become "everyone".
     */
    deleteBody: (total: number, others: string[]) => {
      const who =
        others.length === 0
          ? ""
          : others.length > 3
            ? " for everyone"
            : ` for ${andList.format(others)} too`;
      return total > 0
        ? `It has ${items(total)}. ${plural(total, { one: "It’ll", other: "They’ll" })} be deleted${who}.`
        : `It’ll be deleted${who}.`;
    },
    deleted: (name: string) => `Deleted the ${q(name)} list.`,
  },

  list: {
    back: "Lists",
    notFound: "This list doesn’t exist or was deleted.",
    empty: "Nothing on this list yet. Add the first item below.",
    allChecked: "Everything is checked off.",
    items: "Items",
    /** The checked items that the server deletes soon (#112). */
    olderItems: "Older items",
    actions: "List actions",
    notifications: "Notifications",
    notificationsFailed:
      "Notifications for this list didn’t change. Try again.",
    mutedEverywhere:
      "You won’t get notifications about this list on any of your devices.",
    checkAll: "Check all",
    uncheckAll: "Uncheck all",
    deleteChecked: "Delete checked items",
    deleteList: "Delete list",
    checkedAll: (n: number) => `Checked ${items(n)}.`,
    unchecked: (n: number) => `Unchecked ${items(n)}.`,
    deletedChecked: (n: number) => `Deleted ${items(n)}.`,
    deleteCheckedTitle: (n: number, list: string) =>
      `Delete ${items(n)} checked off ${q(list)}?`,
    deleteCheckedConfirm: "Delete",
    deleteCheckedBody: "They go from the list for both of you.",
  },

  item: {
    /** The "…" menu of an item row (#131). */
    more: (name: string) => `More for ${name}`,
    edit: "Edit",
    move: "Move",
    copy: "Copy",
    /** The menu item, and the badge on the row. */
    outOfStock: "Out of stock",
    inStock: "In stock",
    deleted: (name: string) => `Deleted ${q(name)}.`,
    moved: (name: string, list: string) =>
      `Moved ${q(name)} to the ${q(list)} list.`,
    copied: (name: string, list: string) =>
      `Copied ${q(name)} to the ${q(list)} list.`,
    /** A copy to a list that has the name already. */
    copyOnList: (name: string, list: string) =>
      `${q(name)} is already on the ${q(list)} list.`,
    copyUnchecked: (name: string, list: string) =>
      `${q(name)} was already on the ${q(list)} list. It’s unchecked now.`,
    /** After "Out of stock": the toast offers Move and Copy. */
    markedOutOfStock: (name: string) =>
      `${q(name)} is out of stock. Get it at another store?`,
    moveTitle: (name: string) => `Move ${q(name)} to another list`,
    copyTitle: (name: string) => `Copy ${q(name)} to another list`,
    /** The select of target lists in the Move and Copy dialogs (#134). */
    targets: "List",
    pickList: "Select a list",
    /** Screen reader text before the quantity badge. */
    quantityPrefix: "quantity ",
    quantity: (n: number) => `×${n}`,
    editing: (names: string[]) => `${names.join(", ")} is editing…`,
    added: (who: string, when: string) => `Added by ${who} · ${when}`,
    updated: (who: string, when: string) => `Updated by ${who} · ${when}`,
    /** The automatic delete of an old checked item (#112). Local calendar days. */
    expiresIn: (days: number) =>
      days <= 0
        ? "Expires today"
        : days === 1
          ? "Expires tomorrow"
          : `Expires in ${plural(days, { one: `${days} day`, other: `${days} days` })}`,
  },

  addBar: {
    label: "Add an item",
    suggestions: "Suggestions",
    name: "Item name",
    placeholder: "Add item",
    details: "Quantity and notes",
    add: "Add",
    quantity: "Quantity",
    notes: "Notes",
    notesPlaceholder:
      "For example, brand, size, acceptable substitutions, etc.",
    checkedTitle: (name: string) => `Already on the list. Uncheck ${q(name)}?`,
    checkedConfirm: "Uncheck",
    checkedBody: "It’s checked off. Uncheck it to get it again.",
    /** The user typed a new quantity, new notes, or both. */
    checkedBodyChanges: (quantity: number | undefined, notes: boolean) =>
      quantity === undefined
        ? "It’s checked off. Uncheck it to get it again, with your notes."
        : `It’s checked off. Uncheck it to get ×${quantity}${notes ? ", with your notes" : ""}.`,
    /** A write on this device failed. The form is clear already. */
    failed: (name: string) =>
      `${q(name)} wasn’t saved on this device. Add it again.`,
    duplicateTitle: (name: string) => `${q(name)} is already on the list.`,
    duplicateConfirm: "Add more",
    duplicateBody: (add: number, total: number) =>
      `Add ${add} more? Then it’s ×${total}.`,
  },

  itemSheet: {
    title: "Edit item",
    name: "Name",
    quantity: "Quantity",
    notes: "Notes",
    /** The item went from the list (a delete or a move on another device). */
    gone: (name: string) => `${q(name)} isn’t on this list anymore.`,
  },

  presence: {
    viewing: (name: string) => `${name} has this list open`,
  },

  stepper: {
    /** The − and + buttons of a number input. */
    decrement: "Fewer",
    increment: "More",
  },

  toasts: {
    rejected: (reason: string) => `A change didn’t save: ${reason}.`,
    /** A reason that this version of the app does not know. */
    rejectedGeneral: "A change didn’t save.",
    /** An add or a move to a list that someone deleted while you were offline. */
    listDeletedAdd: (list: string, item: string) =>
      `The ${q(list)} list was deleted, so ${q(item)} wasn’t added.`,
    listDeletedMove: (list: string, item: string) =>
      `The ${q(list)} list was deleted, so ${q(item)} wasn’t moved.`,
    /** Many adds or moves to one deleted list: one toast. */
    listDeletedMany: (
      list: string,
      n: number,
      kind: "add" | "move" | "mixed",
    ) =>
      `The ${q(list)} list was deleted, so ${items(n)} ${plural(n, {
        one: "wasn’t",
        other: "weren’t",
      })} ${
        kind === "add" ? "added" : kind === "move" ? "moved" : "added or moved"
      }.`,
    recreate: "Re-create list",
    /** Why the server refused a change. */
    reasons: {
      list_deleted: "the list was deleted",
      list_not_found: "the list doesn’t exist anymore",
      list_exists: "that list already exists",
      item_not_found: "the item doesn’t exist anymore",
      item_exists: "that item already exists",
      clock_ahead: "this device’s clock is wrong",
      op_conflict: "it conflicts with a change from another person",
      invalid: "the change wasn’t valid",
    },
    mergedUnchecked: (name: string) =>
      `${q(name)} was already on the list. It’s unchecked now.`,
    merged: (name: string) => `${q(name)} was already on the list.`,
  },

  settings: {
    title: "Settings",
    thisDevice: "This device",
    pushNotConfigured: "Notifications aren’t set up on the server yet.",
    pushNeedsInstall:
      "On iPhone and iPad, notifications work only in the app on your Home Screen. In Safari, tap Share, then Add to Home Screen. Open the app from there and come back to this page.",
    pushUnsupported: "This browser can’t get notifications.",
    pushBlocked:
      "Notifications are blocked for this app. Allow them in your browser or system settings, then come back.",
    pushOn:
      "This device gets a notification when the other person changes a list.",
    pushOffer: "Get a notification when the other person changes a list.",
    enablePush: "Enable notifications",
    enableFailed: "Notifications couldn’t be turned on. Try again.",
    deviceFailed: "The device didn’t change. Try again.",
    removeFailed: "The device wasn’t removed. Try again.",
    devices: "Your devices",
    noDevices: "No device gets notifications yet.",
    unnamedDevice: "Unnamed device",
    currentDevice: "This device",
    deviceSwitch: (device: string) => `Notifications on ${device}`,
    /** The server turned the device off after 7 days of failed pushes. */
    notDelivering:
      "Not delivering. Notifications failed for 7 days. Turn it on to try again.",
    on: "On",
    off: "Off",
    remove: "Remove",
    sendTest: "Send a test notification",
    testSent: (n: number) =>
      `Sent a test notification to ${plural(n, { one: `${n} device`, other: `${n} devices` })}.`,
    testUndelivered:
      "The test notification didn’t reach your devices. Try again later.",
    testNoDevices: "No device has notifications on.",
    testFailed: "The test notification didn’t send.",
    lists: "Lists",
    listsHint:
      "Turn off a list to get no notifications about it, on all your devices.",
    listSwitch: (list: string) => `Notifications about ${list}`,
    screen: "Screen",
    keepScreenOn: "Keep screen on",
    keepScreenOnHint:
      "While the app is open, so you can see your list in the store. Only on this device.",
    keepScreenOnUnsupported: "This browser can’t keep the screen on.",
    keepScreenOnFailed: "The screen can’t stay on right now.",
    connectedApps: "Connected apps",
    noApps:
      "No apps are connected. Connect Claude to add and check off items for you.",
    appUsage: (host: string, connected: string, lastUsed: string | null) =>
      lastUsed === null
        ? `${host} · Connected ${connected}`
        : `${host} · Connected ${connected} · Last used ${lastUsed}`,
    connectorUrl: "Connector URL",
    connectorUrlHint:
      "To connect Claude, add a custom connector in Claude’s settings with this URL.",
    copyUrl: "Copy URL",
    copied: "Copied the URL.",
    copyFailed: "Can’t copy the URL. Select it and copy it.",
    disconnect: "Disconnect",
    disconnectTitle: (app: string) => `Disconnect ${app}?`,
    disconnectBody:
      "It can’t see or change your lists until you connect it again.",
    disconnected: (app: string) => `Disconnected ${app}.`,
    disconnectFailed: "The app didn’t disconnect. Try again.",
    account: "Account",
    signedInAs: (name: string) => `Signed in as ${name}`,
    signOut: "Sign out",
    /** Sign-out with ops that did not sync (#115). */
    signOutPendingTitle: "Sign out with changes that didn’t sync?",
    signOutPendingBody: (n: number) =>
      `${plural(n, { one: `${n} change`, other: `${n} changes` })} on this device didn’t sync. If you sign out now, ${plural(n, { one: "it’s", other: "they’re" })} lost.`,
  },

  devices: {
    /** A device that the user agent does not name. */
    unknown: "Device",
    /** Device and browser names, from the user agent. */
    iphone: "iPhone",
    ipad: "iPad",
    android: "Android",
    mac: "Mac",
    windows: "Windows",
    linux: "Linux",
    edge: "Edge",
    firefox: "Firefox",
    chrome: "Chrome",
    safari: "Safari",
    label: (device: string, browser: string) => `${device} · ${browser}`,
  },

  consent: {
    title: "Connect an app",
    /** The name of a client that gives no name. */
    unnamedApp: "An app",
    heading: (app: string) => `Connect ${q(app)} to your lists?`,
    appFrom: "App from",
    /** For an app that registered itself (DCR), with no address to check. */
    unverified: "Not verified",
    sendsYouTo: "Sends you to",
    account: "Account",
    loopback:
      "This app runs on a computer, not on a website. Connect it only if you started it yourself.",
    canDo: "It will be able to:",
    /** What each scope lets an app do. The keys are the keys of SCOPES. */
    scopes: {
      read: "See your lists and items",
      write: "Add, change, check off, and delete lists and items",
      offline: "Stay connected when you aren’t using it",
    },
    via: (name: string) =>
      `Its changes show as ${q(viaClaude(name))}. You can disconnect it at any time in Settings.`,
    connect: "Connect",
    dontConnect: "Don’t connect",
    failed:
      "That didn’t work. Go back to the app that sent you here and connect again.",
    problem: "Can’t connect the app",
    expired:
      "This request expired. Go back to the app that sent you here and connect again.",
    unknownApp:
      "This app isn’t available. Go back to the app that sent you here and connect again.",
  },

  push: {
    /** The title of a push about more than one list. */
    title: APP_NAME,
    testBody: "Notifications work on this device.",
    /** The sentence for one event (#16). See "Notification templates" in docs/PLAN.md. */
    events: {
      createList: (e: PushEvent) =>
        `${e.who} created ${article(e.list)} ${q(e.list)} list.`,
      deleteList: (e: PushEvent) => `${e.who} deleted the ${q(e.list)} list.`,
      renameList: (e: PushEvent) =>
        `${e.who} renamed the ${q(e.oldList)} list to ${q(e.list)}.`,
      restoreList: (e: PushEvent) => `${e.who} restored the ${q(e.list)} list.`,
      addItem: (e: PushEvent) =>
        `${e.who} added ${q(e.item)} to the ${q(e.list)} list.`,
      updateItem: (e: PushEvent) =>
        `${e.who} updated ${q(e.item)} in the ${q(e.list)} list.`,
      deleteItem: (e: PushEvent) =>
        `${e.who} removed ${q(e.item)} from the ${q(e.list)} list.`,
      restoreItem: (e: PushEvent) =>
        `${e.who} put ${q(e.item)} back on the ${q(e.list)} list.`,
      check: (e: PushEvent) =>
        `${e.who} checked ${q(e.item)} off the ${q(e.list)} list.`,
      uncheck: (e: PushEvent) =>
        `${e.who} unchecked ${q(e.item)} in the ${q(e.list)} list.`,
      moveItem: (e: PushEvent) =>
        `${e.who} moved ${q(e.item)} from the ${q(e.fromList)} list to the ${q(e.list)} list.`,
      clearChecked: (e: PushEvent) =>
        `${e.who} deleted the checked items from the ${q(e.list)} list.`,
      uncheckAll: (e: PushEvent) =>
        `${e.who} unchecked everything in the ${q(e.list)} list.`,
      checkAll: (e: PushEvent) =>
        `${e.who} checked everything off the ${q(e.list)} list.`,
      markOutOfStock: (e: PushEvent) =>
        `${e.who} marked ${q(e.item)} as out of stock in the ${q(e.list)} list.`,
      markInStock: (e: PushEvent) =>
        `${e.who} marked ${q(e.item)} as in stock in the ${q(e.list)} list.`,
    },
    /**
     * More than one event, when Claude gives no summary: "Sam made 3
     * changes to the “Costco” list.", or "… to 2 lists.". `list` is the name
     * when there is one list.
     */
    burst: (who: string, changes: number, lists: number, list: string) =>
      `${who} made ${plural(changes, { one: `${changes} change`, other: `${changes} changes` })} to ${
        lists === 1
          ? `the ${q(list)} list`
          : plural(lists, { one: `${lists} list`, other: `${lists} lists` })
      }.`,
  },
};
