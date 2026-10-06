import { Fragment, memo } from "react";

// A small, inert Markdown renderer: model output never becomes HTML or script.
// Fenced code, links, lists and tables stay useful without loading an editor.
function safeHref(value) {
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value) ? value : null;
}

function inline(text, depth = 0) {
  if (depth > 3) return text;
  const expression = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|~~[^~\n]+~~)/g;
  const output = [];
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > offset) output.push(text.slice(offset, match.index));
    const value = match[0];
    let node;
    if (value.startsWith("`")) node = <code>{value.slice(1, -1)}</code>;
    else if (value.startsWith("[")) {
      const split = value.indexOf("](");
      const href = safeHref(value.slice(split + 2, -1));
      node = href ? <a href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noopener noreferrer">{inline(value.slice(1, split), depth + 1)}</a> : value;
    } else if (value.startsWith("**") || value.startsWith("__")) node = <strong>{inline(value.slice(2, -2), depth + 1)}</strong>;
    else if (value.startsWith("~~")) node = <del>{inline(value.slice(2, -2), depth + 1)}</del>;
    else node = <em>{inline(value.slice(1, -1), depth + 1)}</em>;
    output.push(<Fragment key={match.index}>{node}</Fragment>);
    offset = match.index + value.length;
  }
  if (offset < text.length) output.push(text.slice(offset));
  return output;
}

const fence = /^\s*(`{3,}|~{3,})(.*)$/;
const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/;
const tableDivider = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const cells = line => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
const startsBlock = line => fence.test(line) || /^\s{0,3}(#{1,6})\s|^\s*>|^\s*(?:[-*_]\s*){3,}$/.test(line) || listItem.test(line);

export default memo(function MessageContent({ text }) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const key = index;
    const code = line.match(fence);
    if (code) {
      const codeLines = [];
      const closingFence = new RegExp(`^\\s*${code[1][0]}{${code[1].length},}\\s*$`);
      index++;
      while (index < lines.length && !closingFence.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<div key={key} className="messageCode">{code[2].trim() && <span>{code[2].trim()}</span>}<pre><code>{codeLines.join("\n")}</code></pre></div>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 2, 6)}`;
      blocks.push(<Tag key={key}>{inline(heading[2].replace(/\s+#+\s*$/, ""))}</Tag>);
      index++; continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { blocks.push(<hr key={key} />); index++; continue; }
    if (line.includes("|") && tableDivider.test(lines[index + 1] || "")) {
      const header = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push(<div className="messageTable" key={key}><table><thead><tr>{header.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{header.map((_, column) => <td key={column}>{inline(row[column] || "")}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const item = line.match(listItem);
    if (item) {
      const ordered = /^\d/.test(item[2]);
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(listItem);
        if (!match || /^\d/.test(match[2]) !== ordered) break;
        const chunks = [match[3]];
        index++;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !startsBlock(lines[index])) chunks.push(lines[index++].trim());
        items.push(<li key={index}>{inline(chunks.join("\n"))}</li>);
      }
      blocks.push(ordered ? <ol key={key} start={parseInt(item[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(quote.join("\n"))}</blockquote>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !tableDivider.test(lines[index + 1] || "")) paragraph.push(lines[index++]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="messageContent">{blocks}</div>;
});
