import { DEMI_VIEWBOX, NOTIF_BLUE, RAYON } from "./vendor/bloub-engine.js";
import { AVATAR_PALETTES } from "../../../lib/interface-preferences.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PAPER = "#111612";
const PALETTE_INK = Object.freeze(Object.fromEntries(
  Object.entries(AVATAR_PALETTES).map(([key, palette]) => [key, palette.color]),
));

const svgElement = (svg, name, attributes = {}) => {
  const node = svg.ownerDocument.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) setAttribute(node, key, value);
  return node;
};

function setAttribute(node, name, value) {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

function setVisible(node, visible) {
  setAttribute(node, "display", visible ? "inline" : "none");
}

function inkFor(color) {
  return PALETTE_INK[color] || PALETTE_INK.sage;
}

function dotFill(dot, ink) {
  return dot.color || (dot.depth === undefined ? ink : PAPER);
}

function dotTransform(dot) {
  return `translate(${dot.x} ${dot.y}) rotate(${dot.rot || 0}) scale(${RAYON})`;
}

function makeArcSlot(svg, defs, mask, uid, id) {
  const gradient = svgElement(svg, "linearGradient", { id: `${uid}-${id}`, gradientUnits: "userSpaceOnUse" });
  gradient.setAttribute("data-bloub-role", "gradient");
  gradient.setAttribute("data-bloub-id", id);
  defs.insertBefore(gradient, mask);

  const back = svgElement(svg, "path", { fill: "none", "data-bloub-role": "arc-back", "data-bloub-id": id });
  const front = svgElement(svg, "path", { fill: "none", "data-bloub-role": "arc-front", "data-bloub-id": id });
  return { gradient, stops: [], back, front };
}

function updateGradient(slot, arc) {
  const { gradient, stops } = slot;
  setAttribute(gradient, "x1", arc.grad.x1);
  setAttribute(gradient, "y1", arc.grad.y1);
  setAttribute(gradient, "x2", arc.grad.x2);
  setAttribute(gradient, "y2", arc.grad.y2);

  while (stops.length < arc.grad.stops.length) {
    const stop = gradient.ownerDocument.createElementNS(SVG_NS, "stop");
    gradient.appendChild(stop);
    stops.push(stop);
  }
  while (stops.length > arc.grad.stops.length) {
    gradient.removeChild(stops.pop());
  }
  arc.grad.stops.forEach((color, index) => {
    setAttribute(stops[index], "offset", index / (arc.grad.stops.length - 1));
    setAttribute(stops[index], "stop-color", color);
  });
}

function createDotSlot(svg, index) {
  const group = svgElement(svg, "g", { "data-bloub-role": "dot", "data-bloub-index": index, display: "none" });
  const path = svgElement(svg, "path", { display: "none" });
  const circle = svgElement(svg, "circle", { display: "none" });
  group.append(path, circle);
  return { group, path, circle };
}

function updateDot(slot, dot, ink) {
  const fill = dotFill(dot, ink);
  slot.usesInk = !dot.color && dot.depth === undefined;
  if (dot.d) {
    setAttribute(slot.path, "d", dot.d);
    setAttribute(slot.path, "transform", dotTransform(dot));
    setAttribute(slot.path, "fill", fill);
    setAttribute(slot.path, "opacity", dot.opacity);
    setVisible(slot.path, true);
    setVisible(slot.circle, false);
  } else {
    setAttribute(slot.circle, "cx", dot.x);
    setAttribute(slot.circle, "cy", dot.y);
    setAttribute(slot.circle, "r", dot.r);
    setAttribute(slot.circle, "fill", fill);
    setAttribute(slot.circle, "opacity", dot.opacity);
    setVisible(slot.circle, true);
    setVisible(slot.path, false);
  }
  setVisible(slot.group, true);
}

export function createBloubRenderer(svg, uid, color = "sage") {
  const defs = svgElement(svg, "defs");
  const maskId = `${uid}-mask`;
  const mask = svgElement(svg, "mask", {
    id: maskId,
    maskUnits: "userSpaceOnUse",
    x: -DEMI_VIEWBOX,
    y: -DEMI_VIEWBOX,
    width: DEMI_VIEWBOX * 2,
    height: DEMI_VIEWBOX * 2,
  });
  const maskBody = svgElement(svg, "path", { fill: "#fff", "data-bloub-role": "mask-body" });
  const maskEyes = [0, 1].map((index) => svgElement(svg, "path", {
    fill: "#000",
    display: "none",
    "data-bloub-role": "mask-eye",
    "data-bloub-index": index,
  }));
  const notch = svgElement(svg, "circle", { fill: "#000", display: "none", "data-bloub-role": "mask-notch" });
  mask.append(maskBody, ...maskEyes, notch);
  defs.appendChild(mask);

  const arcsBack = svgElement(svg, "g", { fill: "none", stroke: "none", "stroke-linecap": "round", "data-bloub-role": "arcs-back" });
  const dotsBehind = svgElement(svg, "g", { display: "none", "data-bloub-role": "dots-behind" });
  const bodyGroup = svgElement(svg, "g", { "data-bloub-role": "body-group" });
  const body = svgElement(svg, "path", { fill: PAPER, "data-bloub-role": "body" });
  const maskedFace = svgElement(svg, "g", { mask: `url(#${maskId})` });
  const face = svgElement(svg, "rect", {
    x: -DEMI_VIEWBOX,
    y: -DEMI_VIEWBOX,
    width: DEMI_VIEWBOX * 2,
    height: DEMI_VIEWBOX * 2,
    fill: inkFor(color),
    "data-bloub-role": "face",
  });
  const dotsFront = svgElement(svg, "g", { display: "none", "data-bloub-role": "dots-front" });
  const notification = svgElement(svg, "circle", { fill: NOTIF_BLUE, display: "none", "data-bloub-role": "notification" });
  const arcsFront = svgElement(svg, "g", { fill: "none", stroke: "none", "stroke-linecap": "round", "data-bloub-role": "arcs-front" });

  bodyGroup.append(body, maskedFace);
  maskedFace.appendChild(face);
  svg.append(defs, arcsBack, dotsBehind, bodyGroup, dotsFront, notification, arcsFront);

  const arcSlots = new Map();
  const dotSlots = [];
  let arcOrder = "";
  let backDotOrder = "";
  let frontDotOrder = "";
  let currentInk = inkFor(color);

  const updateDots = (frame) => {
    const behind = Boolean(frame.dotsBehind);
    const target = behind ? dotsBehind : dotsFront;
    const order = frame.dots.map((_, index) => index).join(",");
    const previousOrder = behind ? backDotOrder : frontDotOrder;
    const orderChanged = order !== previousOrder;

    if (orderChanged) {
      frame.dots.forEach((_, index) => {
        if (!dotSlots[index]) dotSlots[index] = createDotSlot(svg, index);
      });
    }
    dotSlots.forEach((slot, index) => {
      const dot = frame.dots[index];
      if (!dot) {
        setVisible(slot.group, false);
        return;
      }
      updateDot(slot, dot, currentInk);
      if (slot.group.parentNode !== target) target.appendChild(slot.group);
    });

    if (orderChanged) {
      frame.dots.forEach((_, index) => target.appendChild(dotSlots[index].group));
      if (behind) backDotOrder = order;
      else frontDotOrder = order;
    }
    setVisible(dotsBehind, behind && frame.dots.length > 0);
    setVisible(dotsFront, !behind && frame.dots.length > 0);
  };

  const updateArcs = (frame) => {
    const ids = frame.arcs.map((arc) => arc.id);
    const nextOrder = ids.join("|");
    for (const [id, slot] of arcSlots) {
      if (!ids.includes(id)) {
        setVisible(slot.back, false);
        setVisible(slot.front, false);
      }
    }
    for (const arc of frame.arcs) {
      let slot = arcSlots.get(arc.id);
      if (!slot) {
        slot = makeArcSlot(svg, defs, mask, uid, arc.id);
        arcSlots.set(arc.id, slot);
      }
      updateGradient(slot, arc);
      const stroke = `url(#${uid}-${arc.id})`;
      for (const [path, d] of [[slot.back, arc.back], [slot.front, arc.front]]) {
        setAttribute(path, "d", d);
        setAttribute(path, "stroke", stroke);
        setAttribute(path, "stroke-width", arc.width);
        setAttribute(path, "opacity", arc.opacity);
        setVisible(path, true);
      }
    }
    if (nextOrder !== arcOrder) {
      ids.forEach((id) => {
        const slot = arcSlots.get(id);
        arcsBack.appendChild(slot.back);
        arcsFront.appendChild(slot.front);
      });
      arcOrder = nextOrder;
    }
  };

  const setColor = (nextColor) => {
    const nextInk = inkFor(nextColor);
    if (nextInk === currentInk) return;
    currentInk = nextInk;
    setAttribute(face, "fill", currentInk);
    for (const slot of dotSlots) {
      if (slot.usesInk) {
        setAttribute(slot.path, "fill", currentInk);
        setAttribute(slot.circle, "fill", currentInk);
      }
    }
  };

  const render = (frame) => {
    setAttribute(maskBody, "d", frame.bodyPath);
    setAttribute(body, "d", frame.bodyPath);
    setAttribute(bodyGroup, "opacity", frame.bodyAlpha);
    frame.eyes.forEach((eye, index) => {
      const node = maskEyes[index];
      setAttribute(node, "d", eye.d);
      setAttribute(node, "transform", eye.matrix);
      setAttribute(node, "opacity", eye.alpha);
      setVisible(node, true);
    });
    for (let index = frame.eyes.length; index < maskEyes.length; index += 1) {
      setVisible(maskEyes[index], false);
    }
    if (frame.notch) {
      for (const node of [notch, notification]) {
        setAttribute(node, "cx", frame.notch.x);
        setAttribute(node, "cy", frame.notch.y);
      }
      setAttribute(notch, "r", frame.notch.r);
      setVisible(notch, true);
    } else {
      setVisible(notch, false);
    }
    if (frame.notif) {
      setAttribute(notification, "cx", frame.notif.x);
      setAttribute(notification, "cy", frame.notif.y);
      setAttribute(notification, "r", frame.notif.r);
      setVisible(notification, true);
    } else {
      setVisible(notification, false);
    }
    updateDots(frame);
    updateArcs(frame);
  };

  return { render, setColor };
}

export { PALETTE_INK };
