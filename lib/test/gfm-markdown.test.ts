import anyTest, { type TestFn } from "ava";
import { markdownToAdf } from "../index";

import taskListAdf from "./fixtures/gfm-task-list.json" with { type: "json" };
import nestedTaskListAdf from "./fixtures/gfm-nested-task-list.json" with {
  type: "json",
};

const test = anyTest as unknown as TestFn<void>;

// Helper function to normalize UUIDs for testing
function normalizeAdfForTesting(adf: any): any {
  const normalized = JSON.parse(JSON.stringify(adf));
  let taskListCounter = 0;
  let taskItemCounter = 0;

  function traverse(node: any) {
    if (node.type === "taskList" && node.attrs?.localId) {
      node.attrs.localId = `test-task-list-id${taskListCounter > 0 ? `-${taskListCounter}` : ""}`;
      taskListCounter++;
    }
    if (node.type === "taskItem" && node.attrs?.localId) {
      taskItemCounter++;
      node.attrs.localId = `test-task-item-id-${taskItemCounter}`;
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  }

  if (normalized.content) {
    normalized.content.forEach(traverse);
  }

  return normalized;
}

test(`Can convert GFM task lists`, async (t) => {
  const markdown = `- [ ] Foo bar
- [ ] Baz yo`;

  const adf = await markdownToAdf(markdown);
  const normalizedAdf = normalizeAdfForTesting(adf);
  t.deepEqual(normalizedAdf, taskListAdf);
});

test(`Can convert nested GFM task lists with checked and unchecked items`, async (t) => {
  const markdown = `- [x] Completed task
- [ ] Incomplete task
  - [x] Nested completed
  - [ ] Nested incomplete`;

  const adf = await markdownToAdf(markdown);
  const normalizedAdf = normalizeAdfForTesting(adf);
  t.deepEqual(normalizedAdf, nestedTaskListAdf);
});

test(`Can handle task lists with formatting`, async (t) => {
  const markdown = `- [x] **Bold** task
- [ ] *Italic* task with [link](https://example.com)
- [ ] \`Code\` task`;

  const adf = await markdownToAdf(markdown);
  const normalizedAdf = normalizeAdfForTesting(adf);

  // Check that it's a task list
  t.is(normalizedAdf.content[0].type, "taskList");
  t.is(normalizedAdf.content[0].content.length, 3);

  // Check first item has bold formatting
  const firstItem = normalizedAdf.content[0].content[0];
  t.is(firstItem.attrs.state, "DONE");
  t.is(firstItem.content[0].marks[0].type, "strong");

  // Check second item has italic and link
  const secondItem = normalizedAdf.content[0].content[1];
  t.is(secondItem.attrs.state, "TODO");
  t.truthy(
    secondItem.content.some((node: any) =>
      node.marks?.some((mark: any) => mark.type === "em"),
    ),
  );
  t.truthy(
    secondItem.content.some((node: any) =>
      node.marks?.some((mark: any) => mark.type === "link"),
    ),
  );

  // Check third item has code formatting
  const thirdItem = normalizedAdf.content[0].content[2];
  t.is(thirdItem.attrs.state, "TODO");
  t.truthy(
    thirdItem.content.some((node: any) =>
      node.marks?.some((mark: any) => mark.type === "code"),
    ),
  );
});

test(`Handles mixed regular and task list items correctly`, async (t) => {
  const markdown = `- Regular item
- [ ] Task item
- Another regular item`;

  const adf = await markdownToAdf(markdown);

  // Mixed lists should be treated as regular bullet lists
  const firstContent = adf.content[0];
  t.is(firstContent?.type, "bulletList");
  t.truthy(firstContent?.content);
  t.is(firstContent?.content?.length, 3);

  // All items should be regular list items
  firstContent?.content?.forEach((item: any) => {
    t.is(item.type, "listItem");
  });
});

test(`Extracts nested bullet lists from task lists (Jira ADF schema requirement)`, async (t) => {
  // Jira's ADF schema requires taskList to only contain taskItem nodes.
  // When a task list has nested regular bullet items, they must be extracted
  // and placed as siblings. To preserve document order, we split the taskList
  // so extracted items appear in their original position.
  //
  // Input:
  //   - [x] Task 1
  //     - 1.1
  //     - 1.2
  //   - [x] Task 2
  //
  // Output order: taskList([Task1]), bulletList([1.1, 1.2]), taskList([Task2])
  const markdown = `- [x] Task 1: Create module
  - 1.1: Subtask one
  - 1.2: Subtask two
- [x] Task 2: Another task`;

  const adf = await markdownToAdf(markdown);

  // Should have 3 top-level nodes to preserve document order:
  // taskList([Task1]), bulletList([1.1, 1.2]), taskList([Task2])
  t.is(adf.content.length, 3, "Should have taskList + bulletList + taskList");

  // First node should be a taskList containing Task 1 only
  const taskList1 = adf.content[0]!;
  t.is(taskList1.type, "taskList");
  t.is(taskList1.content?.length, 1, "First taskList should have 1 taskItem (Task 1)");
  t.true(
    taskList1.content?.every((item: any) => item.type === "taskItem"),
    "taskList should only contain taskItem nodes"
  );

  // Second node should be the extracted bulletList
  const bulletList = adf.content[1]!;
  t.is(bulletList.type, "bulletList");
  t.is(bulletList.content?.length, 2, "bulletList should have 2 items (1.1, 1.2)");

  // Third node should be a taskList containing Task 2
  const taskList2 = adf.content[2]!;
  t.is(taskList2.type, "taskList");
  t.is(taskList2.content?.length, 1, "Second taskList should have 1 taskItem (Task 2)");
});

test(`Handles deeply nested task and bullet list combinations`, async (t) => {
  // Test with multiple levels of nesting
  const markdown = `- [x] Parent task
  - [x] Nested task
    - Regular nested bullet
  - Another regular bullet`;

  const adf = await markdownToAdf(markdown);

  // Verify taskList doesn't contain bulletList at any level
  function assertNoNestedBulletListsInTaskList(node: any, path = ""): void {
    if (node.type === "taskList" && node.content) {
      for (const child of node.content) {
        t.not(
          child.type,
          "bulletList",
          `Found bulletList inside taskList at ${path}`
        );
        t.not(
          child.type,
          "orderedList",
          `Found orderedList inside taskList at ${path}`
        );
        if (child.content) {
          assertNoNestedBulletListsInTaskList(child, `${path}/${child.type}`);
        }
      }
    }
  }

  for (const node of adf.content) {
    assertNoNestedBulletListsInTaskList(node, node.type);
  }

  t.pass("No bulletList or orderedList found inside taskList nodes");
});
