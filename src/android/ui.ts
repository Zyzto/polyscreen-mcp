export interface UiNode {
  text: string;
  contentDescription: string;
  resourceId: string;
  className: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  center?: { x: number; y: number };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseUiNodes(xml: string): UiNode[] {
  return [...xml.matchAll(/<node\b([^>]*)\/?>/g)].map((match) => {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (attribute[1] && attribute[2] !== undefined) {
        attributes.set(attribute[1], decodeXml(attribute[2]));
      }
    }
    const bounds = attributes
      .get("bounds")
      ?.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
    const parsedBounds =
      bounds?.[1] && bounds[2] && bounds[3] && bounds[4]
        ? {
            left: Number(bounds[1]),
            top: Number(bounds[2]),
            right: Number(bounds[3]),
            bottom: Number(bounds[4]),
          }
        : undefined;
    return {
      text: attributes.get("text") ?? "",
      contentDescription: attributes.get("content-desc") ?? "",
      resourceId: attributes.get("resource-id") ?? "",
      className: attributes.get("class") ?? "",
      ...(parsedBounds
        ? {
            bounds: parsedBounds,
            center: {
              x: Math.round((parsedBounds.left + parsedBounds.right) / 2),
              y: Math.round((parsedBounds.top + parsedBounds.bottom) / 2),
            },
          }
        : {}),
    };
  });
}

export function findUiNodes(
  nodes: UiNode[],
  query: {
    text?: string | undefined;
    contentDescription?: string | undefined;
    resourceId?: string | undefined;
    exact?: boolean | undefined;
  },
): UiNode[] {
  const matches = (actual: string, expected: string | undefined): boolean => {
    if (expected === undefined) return true;
    return query.exact
      ? actual === expected
      : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  };
  return nodes.filter(
    (node) =>
      matches(node.text, query.text) &&
      matches(node.contentDescription, query.contentDescription) &&
      matches(node.resourceId, query.resourceId),
  );
}
