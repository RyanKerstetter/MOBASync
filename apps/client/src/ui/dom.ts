// The element a page cannot work without, or an error that says which one it is missing.
export function requireElement<T extends HTMLElement>(root: ParentNode, selector: string, page: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`The ${page} page is missing the required element: ${selector}`)
  return found
}

// An element with a class (if it has one) and what goes in it: nodes, or plain text.
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  if (className) made.className = className
  made.append(...children)
  return made
}
