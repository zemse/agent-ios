// Element in our snapshot format
export interface Element {
  ref: string;
  type: string;
  label: string | null;
  identifier: string | null;
  value: string | null;
  frame: { x: number; y: number; w: number; h: number };
  enabled: boolean;
  visible: boolean;
  children: string[];
}

// RefMap entry for quick LLM reference
export interface RefMapEntry {
  type: string;
  label?: string;
  identifier?: string;
}

// Complete snapshot
export interface Snapshot {
  timestamp: string;
  elements: Element[];
  tree: string; // Root ref
  refMap: Record<string, RefMapEntry>;
}

// Simple XML node representation
interface XMLNode {
  tag: string;
  attributes: Record<string, string>;
  children: XMLNode[];
}

// Simple XML parser (no external dependencies)
function parseXML(xml: string): XMLNode | null {
  const stack: XMLNode[] = [];
  let current: XMLNode | null = null;
  let i = 0;

  const skipWhitespace = () => {
    while (i < xml.length && /\s/.test(xml[i])) i++;
  };

  const parseAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    skipWhitespace();

    while (i < xml.length && xml[i] !== ">" && xml[i] !== "/" && xml[i] !== "?") {
      skipWhitespace();
      if (xml[i] === ">" || xml[i] === "/" || xml[i] === "?") break;

      // Parse attribute name
      let name = "";
      while (i < xml.length && xml[i] !== "=" && xml[i] !== ">" && !/\s/.test(xml[i])) {
        name += xml[i++];
      }
      if (!name) break;

      skipWhitespace();
      if (xml[i] !== "=") continue;
      i++; // skip =
      skipWhitespace();

      // Parse attribute value
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") continue;
      i++; // skip opening quote

      let value = "";
      while (i < xml.length && xml[i] !== quote) {
        if (xml[i] === "&") {
          // Handle basic XML entities
          if (xml.slice(i, i + 4) === "&lt;") {
            value += "<";
            i += 4;
          } else if (xml.slice(i, i + 4) === "&gt;") {
            value += ">";
            i += 4;
          } else if (xml.slice(i, i + 5) === "&amp;") {
            value += "&";
            i += 5;
          } else if (xml.slice(i, i + 6) === "&quot;") {
            value += '"';
            i += 6;
          } else if (xml.slice(i, i + 6) === "&apos;") {
            value += "'";
            i += 6;
          } else {
            value += xml[i++];
          }
        } else {
          value += xml[i++];
        }
      }
      i++; // skip closing quote

      attrs[name] = value;
      skipWhitespace();
    }

    return attrs;
  };

  while (i < xml.length) {
    skipWhitespace();
    if (i >= xml.length) break;

    if (xml[i] === "<") {
      i++;

      // Skip XML declaration and comments
      if (xml[i] === "?") {
        while (i < xml.length && !(xml[i - 1] === "?" && xml[i] === ">")) i++;
        i++;
        continue;
      }
      if (xml[i] === "!") {
        // Skip comments and CDATA
        if (xml.slice(i, i + 3) === "!--") {
          while (i < xml.length && xml.slice(i, i + 3) !== "-->") i++;
          i += 3;
        } else {
          while (i < xml.length && xml[i] !== ">") i++;
          i++;
        }
        continue;
      }

      // Closing tag
      if (xml[i] === "/") {
        i++;
        while (i < xml.length && xml[i] !== ">") i++;
        i++;
        if (stack.length > 0) {
          current = stack.pop()!;
        }
        continue;
      }

      // Opening tag
      let tag = "";
      while (i < xml.length && xml[i] !== ">" && xml[i] !== "/" && !/\s/.test(xml[i])) {
        tag += xml[i++];
      }

      const node: XMLNode = {
        tag,
        attributes: parseAttributes(),
        children: [],
      };

      if (current) {
        current.children.push(node);
      }

      // Self-closing tag
      skipWhitespace();
      if (xml[i] === "/") {
        i++; // skip /
        while (i < xml.length && xml[i] !== ">") i++;
        i++; // skip >
        if (!current) {
          return node;
        }
        continue;
      }

      // Regular tag - push to stack
      if (xml[i] === ">") {
        i++;
        if (current) {
          stack.push(current);
        }
        current = node;
      }
    } else {
      // Skip text content
      while (i < xml.length && xml[i] !== "<") i++;
    }
  }

  return current || (stack.length > 0 ? stack[0] : null);
}

// Convert parsed XML to our snapshot format
export function parseWDASource(xml: string): Snapshot {
  const root = parseXML(xml);
  if (!root) {
    throw new Error("Failed to parse WDA source XML");
  }

  const elements: Element[] = [];
  const refMap: Record<string, RefMapEntry> = {};
  let refCounter = 0;

  const processNode = (node: XMLNode, parentRef: string | null): string => {
    const ref = `@e${refCounter++}`;

    const attrs = node.attributes;

    // Parse frame
    const x = parseFloat(attrs.x || "0");
    const y = parseFloat(attrs.y || "0");
    const width = parseFloat(attrs.width || "0");
    const height = parseFloat(attrs.height || "0");

    // Process children first to get their refs
    const childRefs: string[] = [];
    for (const child of node.children) {
      const childRef = processNode(child, ref);
      childRefs.push(childRef);
    }

    const element: Element = {
      ref,
      type: node.tag,
      label: attrs.label || attrs.name || null,
      identifier: attrs.identifier || attrs.name || null,
      value: attrs.value || null,
      frame: { x, y, w: width, h: height },
      enabled: attrs.enabled !== "false",
      visible: attrs.visible !== "false",
      children: childRefs,
    };

    elements.push(element);

    // Add to refMap for quick LLM reference
    const refEntry: RefMapEntry = { type: node.tag };
    if (element.label) refEntry.label = element.label;
    if (element.identifier) refEntry.identifier = element.identifier;
    refMap[ref] = refEntry;

    return ref;
  };

  const treeRef = processNode(root, null);

  return {
    timestamp: new Date().toISOString(),
    elements,
    tree: treeRef,
    refMap,
  };
}

// Store for ref resolution (element query info)
export interface RefStore {
  refs: Map<string, RefMapEntry>;

  // Add a ref
  set(ref: string, entry: RefMapEntry): void;

  // Get ref info
  get(ref: string): RefMapEntry | undefined;

  // Clear all refs
  clear(): void;
}

export function createRefStore(): RefStore {
  const refs = new Map<string, RefMapEntry>();

  return {
    refs,
    set(ref: string, entry: RefMapEntry) {
      refs.set(ref, entry);
    },
    get(ref: string) {
      return refs.get(ref);
    },
    clear() {
      refs.clear();
    },
  };
}

// Error class for ref resolution failures
export class RefResolutionError extends Error {
  constructor(
    message: string,
    public ref: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = "RefResolutionError";
  }
}

// Type for element finder function (injected from WDA client)
export type ElementFinder = (
  using: string,
  value: string
) => Promise<{ ELEMENT: string } | null>;

// Resolve a ref to a WDA element ID
export async function resolveRef(
  ref: string,
  refStore: RefStore,
  findElement: ElementFinder
): Promise<string> {
  // Validate ref format
  if (!ref.startsWith("@e")) {
    throw new RefResolutionError(
      `Invalid ref format: ${ref}. Refs should start with @e (e.g., @e5)`,
      ref
    );
  }

  // Look up ref in store
  const entry = refStore.get(ref);
  if (!entry) {
    throw new RefResolutionError(
      `Unknown ref: ${ref}. Run 'snapshot' first to get element refs.`,
      ref,
      "snapshot"
    );
  }

  let element: { ELEMENT: string } | null = null;

  // Try to find by accessibility identifier (most stable)
  if (entry.identifier) {
    element = await findElement("accessibility id", entry.identifier);
    if (element) {
      return element.ELEMENT;
    }
  }

  // Try to find by predicate (type + label)
  if (entry.label && entry.type) {
    const predicate = `type == '${entry.type}' AND label == '${entry.label}'`;
    element = await findElement("predicate string", predicate);
    if (element) {
      return element.ELEMENT;
    }
  }

  // Try by label only
  if (entry.label) {
    const predicate = `label == '${entry.label}'`;
    element = await findElement("predicate string", predicate);
    if (element) {
      return element.ELEMENT;
    }
  }

  // Element not found
  throw new RefResolutionError(
    `Element ${ref} not found. UI may have changed. Run 'snapshot' for updated refs.`,
    ref,
    "snapshot"
  );
}
