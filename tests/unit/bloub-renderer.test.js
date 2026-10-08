import test from "node:test";
import assert from "node:assert/strict";
import { BotEngine, RAYON } from "../../components/avatar/bloub/vendor/bloub-engine.js";
import { createBloubRenderer, PALETTE_INK } from "../../components/avatar/bloub/bloubRenderer.js";
import {
  BLOUB_CAPTURING_EXPRESSION,
  BLOUB_LISTENING_EXPRESSION,
  BLOUB_NEUTRAL_EXPRESSION,
  bloubExpressionFor,
  bloubStateFor,
  setBloubPresence,
} from "../../components/avatar/bloub/bloubState.js";

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

test("voice attention uses moderate centered expressions and morphs between them", () => {
  assert.equal(bloubStateFor("listening"), "idle");
  assert.equal(bloubStateFor("capturing"), "idle");
  assert.equal(bloubStateFor("listening", { preserveBody: true }), "idle");
  assert.equal(bloubStateFor("capturing", { preserveBody: true }), "idle");
  assert.equal(bloubExpressionFor("listening"), BLOUB_LISTENING_EXPRESSION);
  assert.equal(bloubExpressionFor("capturing"), BLOUB_CAPTURING_EXPRESSION);
  assert.equal(bloubExpressionFor("idle"), BLOUB_NEUTRAL_EXPRESSION);

  for (const expression of [BLOUB_LISTENING_EXPRESSION, BLOUB_CAPTURING_EXPRESSION]) {
    assert.deepEqual([expression.gaze.yaw, expression.gaze.pitch], [0, 0]);
    assert.ok(expression.eyes.every(({ w, h }) => w <= 0.24 && h <= 0.46), "voice eyes stay moderate");
  }

  const engine = new BotEngine(RAYON, "idle", null, BLOUB_NEUTRAL_EXPRESSION);
  const neutralEye = engine.sample(0.6).eyes[0].d;
  engine.setExpression(BLOUB_LISTENING_EXPRESSION, 0.6);
  const listeningStart = engine.sample(0.6).eyes[0].d;
  const listeningMiddle = engine.sample(0.825).eyes[0].d;
  const listeningSettled = engine.sample(1.1).eyes[0].d;
  assert.equal(listeningStart, neutralEye, "listening begins from the visible neutral face");
  assert.notEqual(listeningMiddle, listeningStart, "listening eases toward attention");
  assert.notEqual(listeningSettled, listeningMiddle, "listening continues through the expression morph");

  engine.setExpression(BLOUB_CAPTURING_EXPRESSION, 1.1);
  const captureStart = engine.sample(1.1).eyes[0].d;
  const captureMiddle = engine.sample(1.325).eyes[0].d;
  const captureSettled = engine.sample(1.6).eyes[0].d;
  assert.equal(captureStart, listeningSettled, "capturing continues from the listening face");
  assert.notEqual(captureMiddle, captureStart, "capture has a distinct transition");
  assert.notEqual(captureSettled, captureMiddle, "capture settles without a static face swap");
});

test("leaving voice attention preserves its visible face as the upstream state morph origin", () => {
  const engine = new BotEngine(RAYON, "idle", null, BLOUB_NEUTRAL_EXPRESSION);
  setBloubPresence(engine, "listening", 0);
  const listening = engine.sample(0.6);
  setBloubPresence(engine, "transcribing", 0.6);
  const transitionStart = engine.sample(0.6);
  const transcribing = engine.sample(1.2);

  assert.equal(transitionStart.bodyPath, listening.bodyPath);
  assert.deepEqual(transitionStart.eyes, listening.eyes, "the outgoing listening face does not jump to neutral");
  assert.equal(transcribing.eyes.length, 0, "the upstream thinking glyph owns its settled face");

  setBloubPresence(engine, "idle", 1.2);
  const returned = engine.sample(1.8);
  const neutral = new BotEngine(RAYON, "idle", null, BLOUB_NEUTRAL_EXPRESSION).sample(1.8);
  assert.equal(returned.eyes[0].d, neutral.eyes[0].d, "returning idle restores the neutral expression");
});

test("inline companions keep a full body during active and attention states", () => {
  assert.equal(bloubStateFor("working"), "thinking", "the hero avatar retains the upstream three-dot working glyph");
  for (const state of ["starting", "thinking", "working", "transcribing", "error", "idle"]) {
    const visibleState = bloubStateFor(state, { preserveBody: true });
    assert.notEqual(visibleState, "thinking", `${state} does not collapse an inline companion into three dots`);
    const frame = new BotEngine(RAYON, visibleState).sample(1);
    assert.ok(frame.bodyPath, `${state} keeps a rendered body path`);
    assert.ok(frame.eyes.length > 0, `${state} keeps a recognizable face`);
  }
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
