// Prints the Claude summary for three sample bursts (#17) and two sample
// lists, for a manual check. Needs ANTHROPIC_API_KEY. Each run makes five
// small API calls.
//   ANTHROPIC_API_KEY=… npm run try:summaries
import { createSummarizer } from "../src/server/notify/summarize";
import {
  createListSummarizer,
  type SummaryItem,
} from "../src/server/summary/summarize";
import type { ActivityEvent } from "../src/server/notify/types";

let id = 0;
function ev(
  type: ActivityEvent["type"],
  snapshot: ActivityEvent["snapshot"],
  via: ActivityEvent["via"] = "app",
): ActivityEvent {
  id++;
  return {
    id,
    actorId: "sample",
    via,
    type,
    listId: snapshot.listName,
    itemId: `item-${id}`,
    snapshot,
    at: Date.now(),
  };
}

const wf = "Whole Foods";
const bursts: { name: string; events: ActivityEvent[] }[] = [
  {
    name: "Many adds to one list",
    events: ["Milk", "Eggs", "Bread", "Spinach", "Lemons", "Olive oil"].map(
      (item) => ev("addItem", { listName: wf, itemName: item }),
    ),
  },
  {
    name: "Shopping in two stores",
    events: [
      ...["Milk", "Eggs", "Bread"].map((item) =>
        ev("check", { listName: wf, itemName: item }),
      ),
      ev("check", { listName: "Target", itemName: "Paper towels" }),
      ev("clearChecked", { listName: "Target", count: 4 }),
    ],
  },
  {
    name: "Claude plans dinner",
    events: [
      ev("createList", { listName: "Taco night" }, "mcp"),
      ...["Tortillas", "Avocados", "Limes", "Cilantro"].map((item) =>
        ev("addItem", { listName: "Taco night", itemName: item }, "mcp"),
      ),
    ],
  },
];

const one = (name: string, quantity = 1): SummaryItem => ({ name, quantity });
const lists: { name: string; items: SummaryItem[] }[] = [
  {
    name: "Whole Foods",
    items: [
      one("Milk"),
      one("Eggs", 12),
      one("Spinach"),
      one("Lemons", 3),
      one("Olive oil"),
      one("Sourdough"),
      one("Greek yogurt", 2),
    ],
  },
  {
    name: "Target",
    items: [
      one("Paper towels"),
      one("Dish soap"),
      one("Birthday card"),
      one("AA batteries"),
    ],
  },
];

async function main() {
  const summarize = createSummarizer();
  for (const burst of bursts) {
    console.log(`${burst.name}:\n  ${await summarize(burst.events, "Sam")}`);
  }
  const summarizeList = createListSummarizer();
  if (!summarizeList) return;
  for (const list of lists) {
    console.log(
      `List “${list.name}”:\n  ${await summarizeList(list.name, list.items)}`,
    );
  }
}

void main();
