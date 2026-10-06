import test from "node:test";
import assert from "node:assert/strict";
import { BotEngine, RAYON } from "../../components/avatar/bloub/vendor/bloub-engine.js";
import { createBloubRenderer, PALETTE_INK } from "../../components/avatar/bloub/bloubRenderer.js";
import { bloubStateFor } from "../../components/avatar/bloub/bloubState.js";

class TestElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
  }

  get children() { return this.childNodes; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

class TestDocument {
  createElementNS(_namespace, tagName) { return new TestElement(this, tagName); }
}

function byRole(root, role) {
  const matches = [];
  const visit = (node) => {
    if (node.getAttribute?.("data-bloub-role") === role) matches.push(node);
    node.childNodes?.forEach(visit);
  };
  visit(root);
  return matches;
}

function visible(nodes) {
  return nodes.filter((node) => node.getAttribute("display") !== "none");
}

test("offline presence keeps the full Bloub face visible while errors stay distinct", () => {
  assert.equal(bloubStateFor("offline"), "idle");
  assert.equal(bloubStateFor("error"), "alert");
});

test("persistent renderer updates every engine state without rebuilding its SVG nodes", () => {
  const document = new TestDocument();
  const svg = new TestElement(document, "svg");
  const engine = new BotEngine(RAYON, "idle");
  const renderer = createBloubRenderer(svg, "bloub-test");
  const body = byRole(svg, "body")[0];
  const maskBody = byRole(svg, "mask-body")[0];
  const eyeNodes = byRole(svg, "mask-eye");
  const frameIds = [
    "idle", "thinking", "wink", "wide", "alert", "notify", "exclaim", "sleep",
    "egg", "hexagon", "play", "orbit", "swirl", "burst", "comet",
  ];
  let now = 0;
  let idlePath = "";
  let playPath = "";
  let playEyeTransform = "";
  let playArcNodes = [];

  for (const state of frameIds) {
    engine.setState(state, now);
    const frame = engine.sample(now + 1);
    renderer.render(frame);

    assert.equal(byRole(svg, "body")[0], body, `${state} reuses the body path`);
    assert.equal(byRole(svg, "mask-body")[0], maskBody, `${state} reuses the mask silhouette`);
    assert.deepEqual(visible(eyeNodes).length, frame.eyes.length, `${state} updates masked eye visibility`);
    assert.equal(body.getAttribute("d"), frame.bodyPath, `${state} updates body geometry`);
    assert.equal(maskBody.getAttribute("d"), frame.bodyPath, `${state} updates mask geometry`);
    assert.equal(visible(byRole(svg, "arc-back")).length, frame.arcs.length, `${state} keeps the back arc layer`);
    assert.equal(visible(byRole(svg, "arc-front")).length, frame.arcs.length, `${state} keeps the front arc layer`);
    assert.equal(visible(byRole(svg, "dot")).length, frame.dots.length, `${state} keeps its dots`);
    assert.equal(visible(byRole(svg, "mask-notch")).length, Number(Boolean(frame.notch)), `${state} updates the mask notch`);
    assert.equal(visible(byRole(svg, "notification")).length, Number(Boolean(frame.notif)), `${state} updates notification geometry`);

    for (const arc of frame.arcs) {
      const gradient = byRole(svg, "gradient").find((node) => node.getAttribute("data-bloub-id") === arc.id);
      assert.ok(gradient, `${state} retains gradient ${arc.id}`);
      assert.equal(gradient.children.length, arc.grad.stops.length, `${state} preserves gradient stops for ${arc.id}`);
    }

    if (state === "idle") idlePath = body.getAttribute("d");
    if (state === "play") {
      playPath = body.getAttribute("d");
      playEyeTransform = visible(eyeNodes)[0]?.getAttribute("transform");
      playArcNodes = visible(byRole(svg, "arc-back"));
    }
    if (state === "orbit") {
      assert.notEqual(body.getAttribute("d"), idlePath, "animated states change the body geometry");
    }
    if (state === "burst") {
      for (const [palette, ink] of Object.entries(PALETTE_INK)) {
        renderer.setColor(palette);
        assert.equal(byRole(svg, "face")[0].getAttribute("fill"), ink);
      }
    }
    if (state === "comet") {
      assert.notEqual(body.getAttribute("d"), playPath);
      assert.notEqual(visible(eyeNodes)[0]?.getAttribute("transform"), playEyeTransform);
      assert.ok(playArcNodes.length > 0, "play renders its upstream ribbon arcs");
      assert.ok(playArcNodes.every((node) => byRole(svg, "arc-back").includes(node)), "play arc nodes stay mounted across state changes");
      assert.equal(visible(byRole(svg, "arc-back")).length, frame.arcs.length);
    }
    now += 2;
  }
});
