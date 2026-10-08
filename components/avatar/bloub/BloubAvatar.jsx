"use client";

import { useEffect, useId, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { BotEngine, DEMI_VIEWBOX, RAYON } from "./vendor/bloub-engine.js";
import { BLOUB_IDLE_LOOK, bloubLookForState, bloubPointerLook, bloubSmoothLook } from "./bloubLook.js";
import { createBloubRenderer } from "./bloubRenderer.js";
import { bloubExpressionFor, bloubStateFor, setBloubPresence } from "./bloubState.js";

export { bloubStateFor } from "./bloubState.js";

export default function BloubAvatar({
  state = "idle",
  label = "Ready",
  agentName = "Hermes",
  reducedMotion: reducedMotionPreference,
  pointerFollowing = true,
  color = "sage",
  preserveBody = false,
}) {
  const svgRef = useRef(null);
  const engineRef = useRef(null);
  const rendererRef = useRef(null);
  const clockRef = useRef(0);
  const colorRef = useRef(color);
  const systemReducedMotion = useReducedMotion();
  const reducedMotion = reducedMotionPreference ?? systemReducedMotion ?? false;
  colorRef.current = color;
  const uid = `bloub-${useId().replaceAll(":", "")}`;

  if (!engineRef.current) engineRef.current = new BotEngine(
    RAYON,
    bloubStateFor(state, { preserveBody }),
    null,
    bloubExpressionFor(state, { preserveBody }),
  );

  useEffect(() => {
    const svg = svgRef.current;
    const engine = engineRef.current;
    if (!svg || !engine) return;

    if (!rendererRef.current) {
      rendererRef.current = createBloubRenderer(svg, uid, colorRef.current);
    }
    const renderer = rendererRef.current;
    const stateLook = bloubLookForState(state, { preserveBody });
    setBloubPresence(engine, state, clockRef.current, { preserveBody });
    engine.setLook(stateLook, clockRef.current, 0.2);

    let frameId = null;
    let disposed = false;
    let inView = true;
    let previous = 0;
    let pendingPointer = null;
    let pointerPoint = null;
    let currentLook = { ...BLOUB_IDLE_LOOK };
    let lastLookAt = clockRef.current;
    let bounds = { left: 0, top: 0, width: 0, height: 0 };
    const followsPointer = state === "idle" && pointerFollowing && !reducedMotion;

    const refreshBounds = () => {
      const rect = svg.getBoundingClientRect();
      bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    };

    const resetLook = () => {
      pendingPointer = null;
      pointerPoint = null;
      currentLook = { ...BLOUB_IDLE_LOOK };
      lastLookAt = clockRef.current;
      engine.setLook(stateLook, clockRef.current, 0.2);
    };

    const paint = () => {
      if (pendingPointer && followsPointer) {
        pointerPoint = pendingPointer;
        pendingPointer = null;
      }
      if (followsPointer) {
        const target = pointerPoint
          ? bloubPointerLook(pointerPoint, bounds, { width: window.innerWidth, height: window.innerHeight }) || BLOUB_IDLE_LOOK
          : BLOUB_IDLE_LOOK;
        const stepFrom = lastLookAt;
        const stepTo = clockRef.current;
        const elapsed = Math.max(0, stepTo - stepFrom);
        currentLook = bloubSmoothLook(currentLook, target, elapsed);
        if (elapsed > 0) engine.setLook(currentLook, stepFrom, elapsed);
        lastLookAt = stepTo;
      }

      // Reduced motion samples the settled target pose instead of the first
      // transition frame, which still belongs to the state being left.
      const sampleAt = clockRef.current + (reducedMotion ? 1 : 0);
      renderer.render(engine.sample(sampleAt));
    };

    const canAnimate = () => !disposed && !reducedMotion && inView && document.visibilityState !== "hidden";
    const tick = (now) => {
      frameId = null;
      if (!canAnimate()) return;
      const delta = previous ? Math.min((now - previous) / 1000, 0.064) : 0;
      previous = now;
      clockRef.current += delta;
      paint();
      frameId = requestAnimationFrame(tick);
    };

    const sync = () => {
      previous = 0;
      if (!canAnimate()) {
        resetLook();
      } else {
        refreshBounds();
        if (frameId === null) frameId = requestAnimationFrame(tick);
      }
      if (!canAnimate() && frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    };

    const onPointerMove = (event) => {
      if (event.pointerType === "touch" || !canAnimate()) return;
      pendingPointer = { x: event.clientX, y: event.clientY };
    };
    const onPointerOut = (event) => { if (!event.relatedTarget) resetLook(); };

    paint();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshBounds);
    observer?.observe(svg);
    resizeObserver?.observe(svg);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", refreshBounds, { passive: true });
    window.addEventListener("scroll", refreshBounds, { passive: true, capture: true });
    if (followsPointer) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerout", onPointerOut);
      window.addEventListener("blur", resetLook);
    }
    sync();

    return () => {
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", refreshBounds);
      window.removeEventListener("scroll", refreshBounds, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", resetLook);
      engine.setLook(null, clockRef.current);
    };
  }, [state, reducedMotion, pointerFollowing, preserveBody, uid]);

  useEffect(() => {
    rendererRef.current?.setColor(color);
  }, [color]);

  return <svg
    ref={svgRef}
    className="bloubAvatar"
    viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`}
    role="img"
    aria-label={`${agentName} avatar, ${label}`}
  />;
}
