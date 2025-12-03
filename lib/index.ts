import { marked } from "marked";
import type { Token, Tokens } from "marked";

type AdfNode = {
  type: string;
  attrs?: Record<string, any>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
};

type AdfMark = {
  type: string;
  attrs?: Record<string, any>;
};

type AdfDocument = {
  version: 1;
  type: "doc";
  content: AdfNode[];
};

type RelaxedToken = Token & {
  tokens?: RelaxedToken[];
  task?: boolean;
  checked?: boolean;
};

/**
 * Generates a local ID for ADF elements.
 * @returns a random UUID v4 string
 */
const generateLocalId = (): string => globalThis.crypto.randomUUID();

export function markdownToAdf(markdown: string): AdfDocument {
  const tokens = marked.lexer(markdown);
  return {
    version: 1,
    type: "doc",
    content: tokensToAdf(tokens),
  };
}

function tokensToAdf(tokens?: RelaxedToken[]): AdfNode[] {
  if (!tokens) return [];

  return tokens
    .map((token) => {
      switch (token.type) {
        case "paragraph":
          return processParagraph(token.tokens);

        case "heading":
          return {
            type: "heading",
            attrs: { level: token.depth },
            content: inlineToAdf(token.tokens),
          };

        case "list":
          // Check if this is a task list (all items have task: true)
          const allItemsAreTasks = token.items.every(
            (item: RelaxedToken) => item.task,
          );

          if (
            allItemsAreTasks &&
            token.items.some((item: RelaxedToken) => item.task)
          ) {
            // Process task list items, preserving document order.
            // This may return multiple taskLists interleaved with bulletLists
            // to maintain proper ordering when task items have nested regular lists.
            // (Jira requires taskList to only contain taskItem nodes)
            return processTaskListItemsWithExtractionPreservingOrder(token.items);
          } else {
            return {
              type: token.ordered ? "orderedList" : "bulletList",
              ...(token.ordered ? { attrs: { order: token.start || 1 } } : {}),
              content: token.items.map((item: RelaxedToken) =>
                processListItem(item),
              ),
            };
          }

        case "code":
          // Don't default to "text" - preserve empty language for round-trip fidelity
          // Jira's ADF schema accepts codeBlock without a language attribute
          return {
            type: "codeBlock",
            ...(token.lang ? { attrs: { language: token.lang } } : {}),
            content: [
              {
                type: "text",
                text: token.text,
              },
            ],
          };

        case "blockquote":
          return {
            type: "blockquote",
            content: tokensToAdf(token.tokens),
          };

        case "hr":
          return { type: "rule" };

        case "table":
          return processTable(token as Tokens.Table);

        default:
          return null;
      }
    })
    .filter(Boolean)
    .flat() as AdfNode[];
}

function createMediaNode(token: Tokens.Image): AdfNode {
  return {
    type: "mediaSingle",
    attrs: {
      layout: "center",
    },
    content: [
      {
        type: "media",
        attrs: {
          type: "external",
          url: token.href,
          alt: token.text || "",
        },
      },
    ],
  };
}

function processTable(token: Tokens.Table): AdfNode {
  const headers = token.header.map((header) => ({
    type: "tableHeader",
    content: processParagraph(header.tokens),
  }));

  const rows = token.rows.map((row) => ({
    type: "tableRow",
    content: row.map((cell) => {
      const content = processParagraph(cell.tokens);

      // ADF requires at least one item in the content
      if (content.length === 0) {
        content.push({
          type: "paragraph",
          content: [
            {
              type: "text",
              text: " ", // ADF requires at least 1 char
            },
          ],
        });
      }

      return {
        type: "tableCell",
        content,
      };
    }),
  }));

  const content = [];

  if (headers.length) {
    content.push({
      type: "tableRow",
      content: headers,
    });
  }

  return {
    type: "table",
    content: content.concat(rows),
  };
}

function processParagraph(tokens?: RelaxedToken[]): AdfNode[] {
  if (!tokens) return [];

  if (tokens.length === 1 && tokens[0]?.type === "image") {
    return [createMediaNode(tokens[0] as Tokens.Image)];
  }

  const outputNodes: AdfNode[] = [];
  let currentParagraphTokens: RelaxedToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as RelaxedToken;

    if (token?.type === "image") {
      if (currentParagraphTokens.length) {
        outputNodes.push({
          type: "paragraph",
          content: inlineToAdf(currentParagraphTokens),
        });
        currentParagraphTokens = [];
      }

      outputNodes.push(createMediaNode(token as Tokens.Image));
    } else {
      currentParagraphTokens.push(token);
    }
  }

  if (currentParagraphTokens.length) {
    outputNodes.push({
      type: "paragraph",
      content: inlineToAdf(currentParagraphTokens),
    });
  }

  return outputNodes;
}

function processListItem(item: RelaxedToken): AdfNode {
  const itemContent: AdfNode[] = [];
  let currentParagraphTokens: RelaxedToken[] = [];

  (item.tokens || []).forEach((token: RelaxedToken) => {
    if (
      token.type === "text" ||
      token.type === "em" ||
      token.type === "strong" ||
      token.type === "del" ||
      token.type === "link" ||
      token.type === "codespan"
    ) {
      currentParagraphTokens.push(token);
    } else {
      if (currentParagraphTokens.length) {
        itemContent.push({
          type: "paragraph",
          content: inlineToAdf(currentParagraphTokens),
        });
        currentParagraphTokens = [];
      }

      if (token.type === "list") {
        // Check if nested list is a task list (all items have task: true)
        const allItemsAreTasks = token.items.every(
          (nestedItem: RelaxedToken) => nestedItem.task,
        );

        if (
          allItemsAreTasks &&
          token.items.some((nestedItem: RelaxedToken) => nestedItem.task)
        ) {
          itemContent.push({
            type: "taskList",
            attrs: { localId: generateLocalId() },
            content: token.items.map((nestedItem: RelaxedToken) =>
              processTaskItem(nestedItem),
            ),
          });
        } else {
          itemContent.push({
            type: token.ordered ? "orderedList" : "bulletList",
            ...(token.ordered ? { attrs: { order: token.start || 1 } } : {}),
            content: token.items.map((nestedItem: RelaxedToken) =>
              processListItem(nestedItem),
            ),
          });
        }
      } else {
        const processed = tokensToAdf([token]);
        if (processed.length) {
          itemContent.push(...processed);
        }
      }
    }
  });

  if (currentParagraphTokens.length) {
    itemContent.push({
      type: "paragraph",
      content: inlineToAdf(currentParagraphTokens),
    });
  }

  return {
    type: "listItem",
    content: itemContent,
  };
}

function processTaskItem(item: RelaxedToken): AdfNode {
  const itemContent: AdfNode[] = [];
  let currentParagraphTokens: RelaxedToken[] = [];

  (item.tokens || []).forEach((token: RelaxedToken) => {
    if (
      token.type === "text" ||
      token.type === "em" ||
      token.type === "strong" ||
      token.type === "del" ||
      token.type === "link" ||
      token.type === "codespan"
    ) {
      currentParagraphTokens.push(token);
    } else {
      if (currentParagraphTokens.length) {
        // For task items, content is directly inline text nodes, not wrapped in paragraphs
        itemContent.push(...inlineToAdf(currentParagraphTokens));
        currentParagraphTokens = [];
      }

      // Skip nested lists here - they are handled by processTaskListItems
      if (token.type !== "list") {
        const processed = tokensToAdf([token]);
        if (processed.length) {
          itemContent.push(...processed);
        }
      }
    }
  });

  if (currentParagraphTokens.length) {
    // For task items, content is directly inline text nodes, not wrapped in paragraphs
    itemContent.push(...inlineToAdf(currentParagraphTokens));
  }

  return {
    type: "taskItem",
    attrs: {
      localId: generateLocalId(),
      state: item.checked ? "DONE" : "TODO",
    },
    content: itemContent,
  };
}

/**
 * Processes task list items, handling nested task lists as siblings in the
 * parent taskList's content array (as required by Jira's ADF format).
 */
function processTaskListItems(items: RelaxedToken[]): AdfNode[] {
  const result: AdfNode[] = [];

  for (const item of items) {
    // First, add the task item itself (without nested lists in its content)
    result.push(processTaskItem(item));

    // Then, find and add any nested lists as siblings
    for (const token of item.tokens || []) {
      if (token.type === "list") {
        const allItemsAreTasks = token.items.every(
          (nestedItem: RelaxedToken) => nestedItem.task,
        );

        if (
          allItemsAreTasks &&
          token.items.some((nestedItem: RelaxedToken) => nestedItem.task)
        ) {
          // Nested task list - recursively process with same structure
          result.push({
            type: "taskList",
            attrs: { localId: generateLocalId() },
            content: processTaskListItems(token.items),
          });
        } else {
          // Nested regular list
          result.push({
            type: token.ordered ? "orderedList" : "bulletList",
            ...(token.ordered ? { attrs: { order: token.start || 1 } } : {}),
            content: token.items.map((nestedItem: RelaxedToken) =>
              processListItem(nestedItem),
            ),
          });
        }
      }
    }
  }

  return result;
}

/**
 * Processes task list items and interleaves extracted non-taskItem nodes.
 * 
 * Jira's ADF schema requires taskList to only contain taskItem (and nested taskList) nodes.
 * Regular bulletList/orderedList nodes that appear as nested content must be extracted
 * and placed as siblings. To preserve document order, we return nodes in sequence:
 * [taskItem1, extractedList1a, extractedList1b, taskItem2, taskItem3, extractedList3a, ...]
 * 
 * The caller will split this into taskList content (taskItems only) and sibling lists.
 * 
 * @returns Array of nodes in document order, mixed taskItems and extracted lists
 */
function processTaskListItemsInterleaved(items: RelaxedToken[]): {
  interleavedNodes: Array<{ type: 'taskItem' | 'extracted'; node: AdfNode }>;
} {
  const interleavedNodes: Array<{ type: 'taskItem' | 'extracted'; node: AdfNode }> = [];

  for (const item of items) {
    // Add the task item itself
    interleavedNodes.push({ type: 'taskItem', node: processTaskItem(item) });

    // Process nested lists - extract them right after their parent task item
    for (const token of item.tokens || []) {
      if (token.type === "list") {
        const allItemsAreTasks = token.items.every(
          (nestedItem: RelaxedToken) => nestedItem.task,
        );

        if (
          allItemsAreTasks &&
          token.items.some((nestedItem: RelaxedToken) => nestedItem.task)
        ) {
          // Nested task list - recursively process and add to interleaved output
          const nested = processTaskListItemsInterleaved(token.items);
          // The nested taskList itself goes in the interleaved output
          const nestedTaskItems = nested.interleavedNodes
            .filter(n => n.type === 'taskItem')
            .map(n => n.node);
          
          interleavedNodes.push({
            type: 'taskItem', // Nested taskList can stay in parent taskList
            node: {
              type: "taskList",
              attrs: { localId: generateLocalId() },
              content: nestedTaskItems,
            },
          });
          
          // But any extracted lists from deeper nesting need to come out
          const nestedExtracted = nested.interleavedNodes.filter(n => n.type === 'extracted');
          interleavedNodes.push(...nestedExtracted);
        } else {
          // Nested regular list - EXTRACT it right after this task item
          interleavedNodes.push({
            type: 'extracted',
            node: {
              type: token.ordered ? "orderedList" : "bulletList",
              ...(token.ordered ? { attrs: { order: token.start || 1 } } : {}),
              content: token.items.map((nestedItem: RelaxedToken) =>
                processListItem(nestedItem),
              ),
            },
          });
        }
      }
    }
  }

  return { interleavedNodes };
}

/**
 * Processes task list items and extracts non-taskItem nodes, preserving document order.
 * 
 * Jira's ADF schema requires taskList to only contain taskItem (and nested taskList) nodes.
 * Regular bulletList/orderedList nodes that appear as nested content must be extracted.
 * 
 * To preserve document order, this function:
 * 1. Processes items in order, tracking taskItems and extracted lists
 * 2. Groups consecutive taskItems into taskLists
 * 3. Outputs taskLists and bulletLists in document order
 * 
 * For example, with input:
 *   - [x] Task 1
 *     - 1.1: Subtask
 *   - [x] Task 2
 * 
 * Output order is: taskList([Task1]), bulletList([1.1]), taskList([Task2])
 * NOT: taskList([Task1, Task2]), bulletList([1.1])
 * 
 * @returns Array of ADF nodes in document order (taskLists and extracted lists interleaved)
 */
function processTaskListItemsWithExtractionPreservingOrder(items: RelaxedToken[]): AdfNode[] {
  const { interleavedNodes } = processTaskListItemsInterleaved(items);
  
  // Group consecutive taskItems into taskLists, preserving extracted lists in order
  const result: AdfNode[] = [];
  let currentTaskItems: AdfNode[] = [];
  
  const flushTaskItems = () => {
    if (currentTaskItems.length > 0) {
      result.push({
        type: "taskList",
        attrs: { localId: generateLocalId() },
        content: currentTaskItems,
      });
      currentTaskItems = [];
    }
  };
  
  for (const { type, node } of interleavedNodes) {
    if (type === 'taskItem') {
      currentTaskItems.push(node);
    } else {
      // Extracted list - flush any pending taskItems first, then add the list
      flushTaskItems();
      result.push(node);
    }
  }
  
  // Don't forget any remaining taskItems
  flushTaskItems();
  
  return result;
}

/**
 * Legacy function for backwards compatibility.
 * Returns taskItems and extractedLists separately (loses document order).
 */
function processTaskListItemsWithExtraction(items: RelaxedToken[]): {
  taskItems: AdfNode[];
  extractedLists: AdfNode[];
} {
  const { interleavedNodes } = processTaskListItemsInterleaved(items);
  
  const taskItems: AdfNode[] = [];
  const extractedLists: AdfNode[] = [];
  
  for (const { type, node } of interleavedNodes) {
    if (type === 'taskItem') {
      taskItems.push(node);
    } else {
      extractedLists.push(node);
    }
  }

  return { taskItems, extractedLists };
}

function getSafeText(token: RelaxedToken): string {
  if (
    token.tokens?.length === 1 &&
    token.tokens[0] &&
    "text" in token.tokens[0]
  ) {
    return getSafeText(token.tokens[0]);
  }

  if ("text" in token) {
    return token.text
      .replace(/\n$/, "")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ");
  }

  return "";
}

function getMarks(
  token: RelaxedToken,
  marks: Record<string, AdfMark> = {},
): AdfMark[] {
  if (token.type === "em" && !marks.em) {
    marks.em = { type: "em" };
  }

  if (token.type === "strong" && !marks.strong) {
    marks.strong = { type: "strong" };
  }

  if (token.type === "del" && !marks.strike) {
    marks.strike = { type: "strike" };
  }

  if (token.type === "link") {
    marks.link = {
      type: "link",
      attrs: { href: token.href },
    };
  }

  if (token.type === "codespan" && !marks.code) {
    marks.code = { type: "code" };
  }

  const nextToken = token.tokens?.[0];
  const tokensLength = token.tokens?.length ?? 0;

  // Only continue recursion if there is only one nested token
  if (nextToken && tokensLength === 1) {
    return getMarks(nextToken, marks);
  }

  const resolvedMarks = Object.values(marks);

  if (marks.code) {
    // Code Inline mark only supports a link or annotation mark
    return resolvedMarks.filter(
      (mark) => mark.type === "link" || mark.type === "code",
    );
  }

  return resolvedMarks;
}

function inlineToAdf(tokens?: RelaxedToken[]): AdfNode[] {
  if (!tokens) return [];

  return tokens
    .flatMap((token) => {
      switch (token.type) {
        case "text":
          if (token.tokens) {
            return inlineToAdf(token.tokens);
          }
          return [
            {
              type: "text",
              text: getSafeText(token),
              ...(token.tokens ? { content: inlineToAdf(token.tokens) } : {}),
            },
          ];

        case "em":
          return (token.tokens ?? []).map((t) => ({
            type: "text",
            text: getSafeText(t),
            marks: getMarks(t, { em: { type: "em" } }),
          }));

        case "strong":
          return (token.tokens ?? []).map((t) => ({
            type: "text",
            text: getSafeText(t),
            marks: getMarks(t, { strong: { type: "strong" } }),
          }));

        case "del":
          return (token.tokens ?? []).map((t) => ({
            type: "text",
            text: getSafeText(t),
            marks: getMarks(t, { strike: { type: "strike" } }),
          }));

        case "link":
          return [
            {
              type: "text",
              text: getSafeText(token),
              marks: getMarks(token),
            },
          ];

        case "codespan":
          return [
            {
              type: "text",
              text: getSafeText(token),
              marks: getMarks(token),
            },
          ];

        case "br":
          return [{ type: "hardBreak" }];

        default:
          return [];
      }
    })
    .filter((node) => {
      if (node.type === "text" && !node.text) {
        return false;
      }

      return true;
    });
}
