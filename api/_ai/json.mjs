/**
 * Close a JSON object the model was cut off in the middle of writing.
 *
 * A schedule of fifteen long conditions does not fit in the output cap, and a
 * truncated array parses as nothing at all — so Meath 212214, a 206-hectare
 * solar farm, showed "couldn't read the decision order" over a decision that
 * had been read perfectly well up to condition eleven. Raising the cap moves
 * the cliff rather than removing it: the schedules that overrun it are exactly
 * the ones worth reading.
 *
 * So the tail is trimmed back to the last element that finished, and the
 * brackets still open are closed. Losing the condition the model was mid-way
 * through is a real loss; losing the fourteen before it is a much larger one.
 *
 * Written as a scan rather than a regex because it has to know which brackets
 * are inside a string — condition text is full of them.
 */
export function closeTruncatedJson(text) {
  // Every point at which an element of an array finished, so a half-written
  // one can be dropped whole rather than repaired into nonsense.
  const completions = [];
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack[stack.length - 1] === "[") completions.push(i);
    }
  }
  if (!stack.length && !inString) return text;
  for (let k = completions.length - 1; k >= 0; k--) {
    const candidate = closeAll(text.slice(0, completions[k] + 1));
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // An outer object may still be missing a required shape; keep walking
      // back through the elements that finished.
    }
  }
  return closeAll(text);
}

/** `text` with every bracket it left open closed, innermost first. */
export function closeAll(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // A cut inside a string leaves it unterminated; close that first.
  const closed = inString ? `${text}"` : text;
  return (
    closed +
    stack
      .reverse()
      .map((c) => (c === "{" ? "}" : "]"))
      .join("")
  );
}

