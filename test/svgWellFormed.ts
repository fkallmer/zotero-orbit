/**
 * A strict-enough XML well-formedness check for generated markup.
 *
 * The graph tab parses its SVG with `DOMParser(..., 'image/svg+xml')`, which
 * is XML, not HTML. XML mandates a value for every attribute -- so `data-mark`
 * written bare, legal and ordinary in HTML, aborted the parse and the tab drew
 * nothing at all. Every test in the suite passed, because none of them looked
 * at the markup as XML; the browser preview did not catch it either, since it
 * put the same string into an HTML document, where it parses fine.
 *
 * Hence this: the markup is checked the way the thing that consumes it will.
 */

/** Every reason the markup would not survive an XML parser, in order. */
export function xmlErrors(markup: string): string[] {
  const errors: string[] = []
  const open: string[] = []
  // Attribute values may contain > and <, so they are matched as units.
  const tags = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g

  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tags.exec(markup)) !== null) {
    const [whole, closing, name, attributes] = match
    // Anything between two tags is text; a stray < there is an error in XML.
    const between = markup.slice(cursor, match.index)
    if (between.includes('<')) errors.push(`unescaped "<" in text before <${name}>`)
    cursor = match.index + whole.length

    if (closing) {
      const expected = open.pop()
      if (expected !== name) errors.push(`</${name}> closes <${expected ?? 'nothing'}>`)
      continue
    }

    // The attribute run is greedy, so it swallows the slash of a self-closing
    // tag; taking it back off here beats a lazy quantifier that has to
    // backtrack through every quoted value.
    const selfClosing = /\/\s*$/.test(attributes)
    let rest = attributes.replace(/\/\s*$/, '')
    while (rest.trim() !== '') {
      const attribute = /^\s*([a-zA-Z][\w:-]*)\s*=\s*("[^"]*"|'[^']*')/.exec(rest)
      if (!attribute) {
        errors.push(`<${name}> has an attribute without a quoted value: "${rest.trim().slice(0, 40)}"`)
        break
      }
      rest = rest.slice(attribute[0].length)
    }

    if (!selfClosing) open.push(name)
  }

  for (const unclosed of open.reverse()) errors.push(`<${unclosed}> is never closed`)
  return errors
}
